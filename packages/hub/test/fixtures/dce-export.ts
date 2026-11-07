/**
 * A synthetic DiscordChatExporter HTML export, in DCE's own markup (unquoted attributes, legacy media names, the
 * narrow no-break space in times), with made-up ids and words. Used by import-discord.test.ts and demo checks.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function dceExport(me = "100000000000000001") {
  const ME = me;
  const PEER = "100000000000000002";
  const THIRD = "100000000000000003";
  const DM = "200000000000000001";
  const CHAN = "200000000000000002";
  // Snowflakes in 2021: (ms - epoch) << 22.
  const sf = (ms: number, n = 0) =>
    String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));
  const T = Date.UTC(2021, 5, 1, 12);
  const M1 = sf(T, 1),
    M2 = sf(T + 60_000, 2),
    M3 = sf(T + 120_000, 3),
    M4 = sf(T + 180_000, 4),
    M5 = sf(T + 240_000, 5),
    M6 = sf(T + 300_000, 6);

  const home = "file:///home/someone/Pictures/Discord-test-images";
  const group = (
    author: string,
    name: string,
    display: string,
    messages: string,
    avatar = true,
  ) =>
    `<div class=chatlog__message-group>${messages.replace("{HEAD}", `${avatar ? `<img class=chatlog__avatar src=${home}/avatar-abcde.png alt=Avatar loading=lazy>` : ""}`).replace("{AUTHOR}", `<div class=chatlog__header><span class=chatlog__author title=${name} data-user-id=${author}>${display}</span> <span class=chatlog__timestamp title="Tuesday, June 1, 2021 12:00 PM"><a>06/01/2021</a></span></div>`)}</div>`;
  const box = (id: string, inner: string, first = false, reply = "") =>
    `<div id=chatlog__message-container-${id} class=chatlog__message-container data-message-id=${id}><div class=chatlog__message>${reply}<div class=chatlog__message-aside>${first ? "{HEAD}" : ""}</div><div class=chatlog__message-primary>${first ? "{AUTHOR}" : ""}${inner}</div></div></div>`;
  const page = (guild: string, channel: string, groups: string) =>
    `<!DOCTYPE html><html lang=en><head><title>x</title><style>.a{}</style></head><body><div class=preamble><div class=preamble__entries-container><div class=preamble__entry>${guild}</div><div class=preamble__entry>${channel}</div></div></div><div class=chatlog>${groups}</div><div class=postamble><div class=postamble__entry>Exported 6 message(s)</div></div></body></html>`;

  const dmHtml = page(
    "Direct Messages",
    "peer",
    group(
      PEER,
      "peer",
      "Peer",
      box(
        M1,
        `<div class="chatlog__content chatlog__markdown"><span class=chatlog__markdown-preserve>hello <strong>there</strong> <span class=chatlog__markdown-mention title=me>@Me</span> <img class="chatlog__emoji chatlog__emoji--small" alt=":wave:" src="${home}/123456789012345678-abcde.png"></span></div>`,
        true,
      ) +
        box(
          M2,
          `<div class=chatlog__attachment><a href="${home}/photo-1a2b3.png"><img class=chatlog__attachment-media src="${home}/photo-1a2b3.png" alt=Image title="Image: photo.png (1 KB)" loading=lazy></a></div><div class=chatlog__reactions><div class=chatlog__reaction title=thumbsup><img class="chatlog__emoji chatlog__emoji--small" alt=👍 src=${home}/1f44d-abcde.svg><span class=chatlog__reaction-count>2</span></div></div>`,
        ),
    ) +
      group(
        ME,
        "me",
        "Me",
        box(
          M3,
          `<div class="chatlog__content chatlog__markdown"><span class=chatlog__markdown-preserve>a <code class="chatlog__markdown-pre chatlog__markdown-pre--inline">x</code> &amp; <a href=https://example.org>site</a></span><span class=chatlog__edited-timestamp title="Tuesday, June 1, 2021 12:30 PM">(edited)</span></div>`,
          true,
          `<div class=chatlog__reply-symbol></div><div class=chatlog__reply><div class=chatlog__reply-content><span class=chatlog__reply-link onclick="scrollToMessage(event, '${M1}')">hello</span></div></div>`,
        ) +
          box(
            M4,
            `<div class=chatlog__embed><video class=chatlog__embed-generic-gifv width=100 height=100><source src="${home}/tenor-abcde.mp4" alt=GIF></video></div>`,
          ),
      ),
  );
  const chanHtml = page(
    "Some Server",
    "General / chat",
    group(
      THIRD,
      "third",
      "Third",
      box(
        M5,
        `<div class="chatlog__content chatlog__markdown"><span class=chatlog__markdown-preserve>in a server</span></div>`,
        true,
      ),
      false,
    ) +
      group(
        PEER,
        "peer",
        "Peer",
        box(
          M6,
          `<div class="chatlog__content chatlog__markdown"><span class=chatlog__markdown-preserve>live says otherwise</span></div>`,
          true,
        ),
        false,
      ),
  );

  return {
    ME,
    PEER,
    THIRD,
    DM,
    CHAN,
    T,
    M1,
    M2,
    M3,
    M4,
    M5,
    M6,
    home,
    dmHtml,
    chanHtml,
  };
}

/** Write it under raw/ the way rsync left the real ones: Documents/ for the HTML, Pictures/ for media. */
export function writeDceExport(sourceDir: string, me?: string) {
  const x = dceExport(me);
  const raw = join(sourceDir, "raw");
  mkdirSync(join(raw, "Documents/Discord-test"), { recursive: true });
  mkdirSync(join(raw, "Pictures/Discord-test-images"), { recursive: true });
  writeFileSync(
    join(raw, `Documents/Discord-test/Direct Messages - peer [${x.DM}].html`),
    x.dmHtml,
  );
  writeFileSync(
    join(
      raw,
      `Documents/Discord-test/Some Server - General - chat [${x.CHAN}].html`,
    ),
    x.chanHtml,
  );
  for (const f of [
    "avatar-abcde.png",
    "photo-1a2b3.png",
    "tenor-abcde.mp4",
    "123456789012345678-abcde.png",
  ])
    writeFileSync(
      join(raw, "Pictures/Discord-test-images", f),
      `bytes of ${f}`,
    );
  writeFileSync(
    join(sourceDir, "source.json"),
    JSON.stringify({
      v: 1,
      network: "discord",
      kind: "dce-html",
      label: "test",
      account: null,
      addedAt: 1,
      addedBy: "test",
    }),
  );
  return { ...x, raw };
}
