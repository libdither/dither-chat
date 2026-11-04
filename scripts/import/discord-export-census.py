#!/usr/bin/env python
"""Counts-only census of DiscordChatExporter (DCE) HTML/JSON exports.

Prints aggregate structure (files, message counts, date ranges, attachment
link kinds, media-dir coverage) and never message text, author names,
channel names or ids. Used to size the Discord history import; see
docs/import-discord.md.

    python -I scripts/import/discord-export-census.py EXPORT_DIR [MEDIA_DIR]
"""
from __future__ import annotations

import collections
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

DISCORD_EPOCH_MS = 1_420_070_400_000
MSG_RE = re.compile(rb'chatlog__message-container[^>]*data-message-id=["\']?(\d+)')
SYS_RE = re.compile(rb'chatlog__system-notification-content')
USER_RE = re.compile(rb'data-user-id=["\']?(\d+)')
FILE_HREF_RE = re.compile(rb'href=["\']?file://([^"\'>\s]+)', re.I)
REL_HREF_RE = re.compile(rb'chatlog__attachment[^<]*<a href=["\']?(?!https?:|file:)([^"\'>\s]+)', re.I)
CDN_ATT_RE = re.compile(rb'href=["\']?https://cdn\.discordapp\.com/attachments/[^"\'>\s]+', re.I)
SIGNED_RE = re.compile(rb'href=["\']?https://cdn\.discordapp\.com/attachments/[^"\'>\s]*[?&](?:amp;)?ex=', re.I)
# DCE emits unquoted single-class attributes (class=chatlog__reply>), so
# match the class name followed by a delimiter rather than a space.
FEATURES = {
    f: re.compile(rb'class=["\']?chatlog__' + c + rb'(?=[\s>"\'])')
    for f, c in {
        "attachments": rb"attachment", "replies": rb"reply", "reactions": rb"reaction",
        "edited": rb"edited-timestamp", "embeds": rb"embed", "stickers": rb"sticker",
        "system": rb"system-notification-content", "threads": rb"thread",
    }.items()
}
CHANNEL_ID_RE = re.compile(r"\[(\d+)\]\.(?:html|json)$")


def ts(snowflake: int) -> dt.date:
    return dt.datetime.fromtimestamp(((snowflake >> 22) + DISCORD_EPOCH_MS) / 1000, dt.timezone.utc).date()


def kind(name: str) -> str:
    # "Direct Messages - <name> [id].html", "<Guild> - <cat> - <chan> [id].html"
    return "dm/group" if name.startswith("Direct Messages - ") else "guild"


def census_html(path: Path, agg, media_names):
    data = path.read_bytes()
    ids = [int(m) for m in MSG_RE.findall(data)]
    k = kind(path.name)
    m = CHANNEL_ID_RE.search(path.name)
    agg["channels"][m.group(1) if m else path.name] += 1
    agg["files"][k] += 1
    agg["messages"][k] += len(ids)
    agg["bytes"][k] += len(data)
    agg["per_file"].append(len(ids))
    if ids:
        agg["min"] = min(agg["min"] or ts(min(ids)), ts(min(ids)))
        agg["max"] = max(agg["max"] or ts(max(ids)), ts(max(ids)))
        agg["years"].update(ts(i).year for i in ids)
        agg["ids"].update(ids)
        if ids != sorted(ids):
            agg["unsorted_files"] += 1
    agg["authors"].update(USER_RE.findall(data))
    for f, needle in FEATURES.items():
        agg["features"][f] += len(needle.findall(data))
    files = FILE_HREF_RE.findall(data)
    agg["att_file"] += len(files)
    agg["att_rel"] += len(REL_HREF_RE.findall(data))
    agg["att_cdn"] += len(CDN_ATT_RE.findall(data))
    agg["att_cdn_signed"] += len(SIGNED_RE.findall(data))
    for f in files:
        name = os.path.basename(f.decode("utf-8", "replace"))
        agg["att_file_present" if name in media_names else "att_file_missing"] += 1


def census_json(path: Path, agg):
    doc = json.loads(path.read_bytes())
    agg["json_top_keys"].update(doc.keys())
    msgs = doc.get("messages", [])
    if msgs:
        agg["json_msg_keys"].update(msgs[0].keys())
    agg["files"]["json"] += 1
    agg["messages"]["json"] += len(msgs)


def main() -> int:
    root = Path(sys.argv[1])
    media = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    media_names = {p.name for p in media.iterdir()} if media else set()
    agg = {
        "files": collections.Counter(), "messages": collections.Counter(), "bytes": collections.Counter(),
        "per_file": [], "min": None, "max": None, "years": collections.Counter(), "ids": collections.Counter(),
        "authors": set(), "features": collections.Counter(), "unsorted_files": 0,
        "att_file": 0, "att_rel": 0, "att_cdn": 0, "att_cdn_signed": 0,
        "att_file_present": 0, "att_file_missing": 0,
        "channels": collections.Counter(), "json_top_keys": collections.Counter(), "json_msg_keys": collections.Counter(),
    }
    other = collections.Counter()
    for p in sorted(root.iterdir()):
        if p.suffix == ".html":
            census_html(p, agg, media_names)
        elif p.suffix == ".json":
            census_json(p, agg)
        else:
            other[p.suffix or "(none)"] += 1
    per = sorted(agg["per_file"])
    dup = sum(1 for c in agg["ids"].values() if c > 1)
    print(f"files: {dict(agg['files'])}  other: {dict(other)}")
    print(f"messages: {dict(agg['messages'])}  unique ids: {len(agg['ids'])}  ids in >1 file: {dup}")
    print(f"channel ids exported more than once: {sum(1 for c in agg['channels'].values() if c > 1)}")
    print(f"MB: { {k: round(v / 1e6, 1) for k, v in agg['bytes'].items()} }")
    if per:
        print(f"msgs/file: min {per[0]} median {per[len(per) // 2]} max {per[-1]}  files with 0: {per.count(0)}")
    print(f"date range: {agg['min']} .. {agg['max']}  per year: {dict(sorted(agg['years'].items()))}")
    print(f"distinct authors: {len(agg['authors'])}  files not id-sorted: {agg['unsorted_files']}")
    print(f"features: {dict(agg['features'])}")
    print(f"attachment links: file:// {agg['att_file']} (present in media dir {agg['att_file_present']}, "
          f"missing {agg['att_file_missing']}), relative {agg['att_rel']}, cdn {agg['att_cdn']} "
          f"(signed/expiring {agg['att_cdn_signed']})")
    if agg["json_top_keys"]:
        print(f"json top keys: {sorted(agg['json_top_keys'])}  message keys: {sorted(agg['json_msg_keys'])}")
    if media:
        exts = collections.Counter(p.suffix.lower() for p in media.iterdir())
        print(f"media dir: {sum(exts.values())} files, top ext {exts.most_common(6)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
