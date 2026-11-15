/**
 * The panel's Files (docs/uploads.md "The panel"): the phone's own storage in the Android app (what changed lately,
 * every folder, a search by name), and the files your chats already hold, on every network. The system's file picker
 * is only a link at the end ("Other apps…"), for a file that lives in another app (a cloud drive).
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ago, bytes } from '../../format.ts';
import { askFilesAccess, device, deviceFile, listFiles, asFile, type DeviceFile } from '../../device.ts';
import { authorName, convTitle } from '../../model.ts';
import { db, isSelfIdentity } from '../../state.ts';
import { Icon } from '../icons.tsx';
import { useHubFiles, type HubFile } from './hubfiles.ts';
import type { PanelCtx, Picks } from './Panel.tsx';
import { PanelHead, PickMark } from './parts.tsx';

interface Props {
  ctx: PanelCtx;
  picks: Picks;
  full: boolean;
  setFull: (f: boolean) => void;
}

function iconOf(name: string, mime?: string | null): string {
  const m = mime ?? '';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'play';
  if (m.startsWith('audio/')) return 'headphones';
  if (/\.(zip|tar|gz|7z|rar|xz|zst)$/i.test(name)) return 'archive';
  if (/\.(js|ts|py|rs|c|h|go|java|kt|json|sh|html|css)$/i.test(name)) return 'fileCode';
  if (/\.(pdf|txt|md|docx?|odt|rtf|xlsx?|ods|csv|pptx?)$/i.test(name)) return 'fileText';
  return 'file';
}

function Row({ icon, name, meta, n, onClick, track, chevron }: { icon: string; name: string; meta: ComponentChildren; n?: number | null; onClick: () => void; track: string; chevron?: boolean }) {
  return (
    <button class={`kp-row ${n ? 'on' : ''}`} data-track={track} aria-pressed={n === undefined ? undefined : !!n} onClick={onClick}>
      <span class="kp-row-icon">
        <Icon name={icon} size={18} />
      </span>
      <span class="kp-row-text">
        <span class="kp-row-name">{name}</span>
        <span class="kp-row-meta">{meta}</span>
      </span>
      {chevron ? <Icon name="chevronRight" size={16} /> : <PickMark n={n ?? null} />}
    </button>
  );
}

function PhoneRow({ f, picks, open }: { f: DeviceFile; picks: Picks; open: (path: string) => void }) {
  if (f.dir) return <Row icon="folder" name={f.name} meta={`${f.count ?? 0} ${f.count === 1 ? 'item' : 'items'}`} onClick={() => open(f.path)} track="folder" chevron />;
  const id = `file:${f.path}`;
  const where = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : 'Phone';
  return <Row icon={iconOf(f.name, f.mime)} name={f.name} meta={`${bytes(f.size ?? 0)} · ${ago(f.at)} · ${where}`} n={picks.at(id)} onClick={() => picks.toggle(id, () => deviceFile(f))} track="phone file" />;
}

function HubRow({ f, picks }: { f: HubFile; picks: Picks }) {
  const conv = db.conversations.get(f.message.conversationId);
  const who = f.message.authorId && isSelfIdentity(f.message.authorId) ? 'You' : authorName(f.message.authorId);
  return (
    <Row
      icon={iconOf(f.att.name ?? '', f.att.mime)}
      name={f.att.name ?? 'file'}
      meta={`${f.att.size ? `${bytes(f.att.size)} · ` : ''}${who} · ${conv ? convTitle(conv) : ''} · ${ago(f.message.ts)}`}
      n={picks.at(f.id)}
      onClick={() => picks.toggle(f.id, () => asFile(f.att.url, f.att.name ?? 'file', f.att.mime))}
      track="chat file"
    />
  );
}

export function FilesTab(p: Props) {
  const { ctx, picks, full, setFull } = p;
  const d = device();
  const [folder, setFolder] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const searching = full && folder === null;
  useEffect(() => {
    if (!full) setQ('');
  }, [full]);
  return (
    <>
      {folder !== null ? (
        <Folder path={folder} picks={picks} open={setFolder} close={() => setFolder(null)} />
      ) : searching ? (
        <Search q={q} setQ={setQ} picks={picks} back={() => setFull(false)} phone={!!d?.files} />
      ) : (
        <>
          <PanelHead full={false} setFull={setFull} title="Files">
            <span class="kp-grow" />
            <button class="icon-btn" data-track="search files" aria-label="Search files" onClick={() => setFull(true)}>
              <Icon name="search" size={18} />
            </button>
          </PanelHead>
          <div class="kp-scroll">
            {d && (d.files ? <Recent picks={picks} open={setFolder} /> : <AskFiles pickFiles={ctx.pickFiles} />)}
            <Chats query="has:file" picks={picks} />
            <button class="kp-other" data-track="other apps" onClick={ctx.pickFiles}>
              <Icon name="external" size={14} /> {d ? 'Other apps…' : 'Choose a file…'}
            </button>
          </div>
        </>
      )}
    </>
  );
}

function AskFiles({ pickFiles }: { pickFiles: () => void }) {
  return (
    <div class="kp-ask">
      <b>Browse this phone's files here?</b>
      <span>Android lets an app see your Downloads and other folders only with "All files access", a switch in Settings.</span>
      <button class="kp-btn" data-track="files access" onClick={askFilesAccess}>
        Open Settings
      </button>
      <button class="kp-link" data-track="files access (picker)" onClick={pickFiles}>
        Use the system picker this time
      </button>
    </div>
  );
}

function usePhone(o: { path?: string; q?: string; recent?: boolean }, key: string) {
  const [entries, setEntries] = useState<DeviceFile[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setEntries(null);
    listFiles(o).then(
      (r) => live && (setEntries(r.entries), setFailed(r.error ?? null)),
      (e) => live && setFailed(String(e?.message ?? e)),
    );
    return () => void (live = false);
  }, [key]);
  return { entries, failed };
}

function Recent({ picks, open }: { picks: Picks; open: (path: string) => void }) {
  const [all, setAll] = useState(false);
  const r = usePhone({ recent: true }, 'recent');
  const shown = (r.entries ?? []).slice(0, all ? 80 : 6);
  return (
    <>
      <div class="kp-sec">On this phone</div>
      <Row icon="folder" name="Browse folders" meta="Downloads, Documents and the rest" onClick={() => open('')} track="browse folders" chevron />
      {shown.map((f) => (
        <PhoneRow f={f} picks={picks} open={open} />
      ))}
      {!all && (r.entries?.length ?? 0) > 6 && (
        <button class="kp-more" data-track="more recent" onClick={() => setAll(true)}>
          More recent files
        </button>
      )}
      {r.failed && <div class="kp-note">{r.failed}</div>}
    </>
  );
}

function Chats({ query, picks, title = 'In your chats' }: { query: string; picks: Picks; title?: string }) {
  const hub = useHubFiles(query, ['file', 'audio', 'video']);
  return (
    <>
      <div class="kp-sec">{title}</div>
      {hub.items.map((f) => (
        <HubRow f={f} picks={picks} />
      ))}
      {!hub.loading && !hub.items.length && <div class="kp-empty">{hub.failed ?? 'No files in your chats yet.'}</div>}
      {hub.more && (
        <button class="kp-more" data-track="more chat files" onClick={hub.more}>
          More
        </button>
      )}
    </>
  );
}

function Folder({ path, picks, open, close }: { path: string; picks: Picks; open: (p: string) => void; close: () => void }) {
  const r = usePhone({ path }, `dir:${path}`);
  const up = () => (path ? open(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '') : close());
  return (
    <>
      <div class="kp-head">
        <button class="icon-btn" data-track="folder up" aria-label="Up" onClick={up}>
          <Icon name="back" size={18} />
        </button>
        <span class="kp-title kp-crumbs">{['Phone', ...(path ? path.split('/') : [])].join(' › ')}</span>
      </div>
      <div class="kp-scroll">
        {r.entries?.map((f) => (
          <PhoneRow f={f} picks={picks} open={open} />
        ))}
        {r.entries && !r.entries.length && <div class="kp-empty">This folder is empty.</div>}
        {r.failed && <div class="kp-note">{r.failed}</div>}
      </div>
    </>
  );
}

function Search({ q, setQ, picks, back, phone }: { q: string; setQ: (q: string) => void; picks: Picks; back: () => void; phone: boolean }) {
  const [typed, setTyped] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);
  const r = usePhone({ q }, `q:${q}`);
  return (
    <>
      <div class="kp-head">
        <button class="icon-btn" data-track="search back" aria-label="Back" onClick={back}>
          <Icon name="back" size={18} />
        </button>
        <input class="kp-search" type="search" placeholder="Search files by name" value={typed} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} ref={(el) => void (el && !q && !typed && el.focus())} enterkeyhint="search" />
      </div>
      <div class="kp-scroll">
        {phone && q && (
          <>
            <div class="kp-sec">On this phone</div>
            {r.entries?.map((f) => (
              <PhoneRow f={f} picks={picks} open={() => {}} />
            ))}
            {r.entries && !r.entries.length && <div class="kp-empty">Nothing on this phone by that name.</div>}
          </>
        )}
        {q && <Chats query={`has:file filename:${q.includes(' ') ? JSON.stringify(q) : q}`} picks={picks} />}
      </div>
    </>
  );
}
