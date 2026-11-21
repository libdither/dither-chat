/**
 * The composer's size and pictures controls (docs/mail.md "Sizes" and "Writing"):
 *
 * - `PicturesChoice`: the footer's "3 pictures · Link" when the mail has pictures from the web (a forward's, a
 *   quote's); it opens how they go: Link (their app fetches them; a personal one can tell the original sender), Embed
 *   (fetched now and sent inside the mail: nothing is fetched on their end) or Leave out, each with what it does to
 *   the size. It sits in the footer so it stays in sight however long the forward is.
 * - `SizeMeter`: the footer's "≈ 188 KB of 25 MB", which opens the breakdown: text, HTML, pictures inside, files, the
 *   total as sent, and what their app loads on their end. (Plain text only is the editor's Plain view.)
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { bytes } from '../../format.ts';
import { Icon } from '../icons.tsx';
import { measureHtml, sizeLine, type SizeLine } from '../../mail/sendsize.ts';
import { api } from '../../state.ts';

const MB = 1024 * 1024;
const mbText = (n: number) => `${Number.isInteger(n / MB) ? n / MB : (n / MB).toFixed(1)} MB`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const about = (b: number, unknown: number) => (unknown ? (b ? `${bytes(b)} + ${unknown} not known` : `${unknown} not known yet`) : bytes(b));

/** What the hub knows of pictures from the web, asked once per address. */
const known = new Map<string, { size: number | null; class: string; cached?: boolean }>();

export function useDraftSize(o: {
  html: string | null | undefined;
  text: string;
  plainOnly: boolean;
  mode: P.MailOutgoingPictures;
  linkCanTell?: boolean;
  files: number;
  accountId: string;
  /** The forward or quote as the hub made it (its text part's share). */
  island?: P.MailIsland | null;
}): SizeLine & { webCount: number; canTellAll: number } {
  const m = useMemo(() => measureHtml(o.html, o.island), [o.html, o.island]);
  const [, redraw] = useState(0);
  const asking = useRef(false);
  const key = m.pictures.web.join('\n');
  useEffect(() => {
    const want = m.pictures.web.filter((u) => !known.has(u));
    if (!want.length || asking.current) return;
    asking.current = true;
    const t = setTimeout(() => {
      api<P.MailPictureSizes>('/api/mail/pictures/sizes', { body: { urls: want, accountId: o.accountId } })
        .then((r) => want.forEach((u, i) => known.set(u, { size: r.sizes[i] ?? null, class: r.classes[i] ?? 'shared', cached: r.cached?.[i] })))
        .catch(() => {})
        .finally(() => {
          asking.current = false;
          redraw((n) => n + 1);
        });
    }, 400);
    return () => {
      clearTimeout(t);
      asking.current = false;
    };
  }, [key]);
  const line = sizeLine({ text: o.text, islandText: m.islandText, html: m.html, plainOnly: o.plainOnly, pictures: m.pictures, mode: o.mode, linkCanTell: o.linkCanTell, known, files: o.files });
  const canTellAll = m.pictures.web.filter((u) => known.get(u)?.class === 'personal').length;
  return { ...line, webCount: m.pictures.web.length, canTellAll };
}

const MODES: { m: P.MailOutgoingPictures; label: string }[] = [
  { m: 'link', label: 'Link' },
  { m: 'embed', label: 'Embed' },
  { m: 'drop', label: 'Leave out' },
];

/** A footer button's popover: open and shut, shut by a click away or Escape. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), e.preventDefault(), setOpen(false));
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  return { open, setOpen, box };
}

/** How the pictures from the web go, with what each choice does. */
export function PicturesChoice({
  s,
  mode,
  onMode,
  linkCanTell,
  onLinkCanTell,
  inlineParts,
}: {
  s: ReturnType<typeof useDraftSize>;
  mode: P.MailOutgoingPictures;
  onMode: (m: P.MailOutgoingPictures) => void;
  linkCanTell: boolean;
  onLinkCanTell: (v: boolean) => void;
  inlineParts: boolean;
}) {
  const { open, setOpen, box } = usePopover();
  if (!s.webCount) return null;
  const them = (n: number) => (n === 1 ? 'it' : 'them');
  const note =
    mode === 'link'
      ? `Their app fetches ${them(s.linked.n)} when they open it${s.linked.bytes || s.linked.unknown ? ` (${about(s.linked.bytes, s.linked.unknown)})` : ''}.${
          s.linked.leftOut ? '' : s.canTellAll ? ` ${plural(s.canTellAll, 'picture')} can tell the original sender it was opened.` : ''
        }`
      : mode === 'embed'
        ? `Fetched now and sent inside the mail (${about(s.embedded.bytes, s.embedded.unknown)}, a third more as sent): nothing is fetched on their end.${
            s.embedded.leftOut
              ? ` ${plural(s.embedded.leftOut, 'picture')} that can tell ${s.embedded.leftOut === 1 ? 'is' : 'are'} left out: fetching ${them(s.embedded.leftOut)} would tell the original sender you opened it. Load ${them(s.embedded.leftOut)} in the reader first to send ${them(s.embedded.leftOut)} inside.`
              : ''
          } One that can’t be fetched is left out too.${inlineParts ? '' : ' This account sends them as data: pictures, which Gmail hides.'}`
        : 'They are left out; their places close up.';
  const label = MODES.find((x) => x.m === mode)!.label;
  // What goes, and what of it can tell or is left out, said on the button.
  const leftOut = mode === 'link' ? s.linked.leftOut : mode === 'embed' ? s.embedded.leftOut : 0;
  const goes = mode === 'drop' ? s.webCount : s.webCount - leftOut;
  const warn = leftOut ? `${leftOut} left out` : mode === 'link' && s.canTellAll ? `${s.canTellAll} can tell` : '';
  return (
    <div class="mc-pics" ref={box}>
      <button
        type="button"
        class={`mc-limit mc-pics-btn${warn ? ' warn' : ''}`}
        aria-expanded={open}
        title="How the pictures from the web go"
        onClick={() => setOpen(!open)}
      >
        <Icon name="image" size={13} />
        <span class="mc-pics-n">{goes} · </span>
        {label}
        {warn && <span class="mc-seg-warn"> · {warn}</span>}
      </button>
      {open && (
        <div class="mc-size-pop mc-pics-pop" role="dialog" aria-label="Pictures from the web">
          <p class="mc-pics-what">{plural(s.webCount, 'picture')} from the web</p>
          <span class="mc-seg" role="radiogroup" aria-label="How they go">
            {MODES.map((x) => (
              <button type="button" role="radio" aria-checked={mode === x.m} class={`mc-seg-btn${mode === x.m ? ' on' : ''}`} onClick={() => onMode(x.m)}>
                {x.label}
                {/* Said on the choice itself: linking these tells the original sender the mail was opened. */}
                {x.m === 'link' && s.canTellAll > 0 && <span class="mc-seg-warn"> · {s.canTellAll} can tell</span>}
              </button>
            ))}
          </span>
          {mode === 'link' && s.canTellAll > 0 && (
            <label class="mc-pics-tell">
              <input type="checkbox" checked={!linkCanTell} onChange={(e) => onLinkCanTell(!(e.currentTarget as HTMLInputElement).checked)} />
              Leave out the {s.canTellAll === 1 ? 'one' : s.canTellAll} that can tell
            </label>
          )}
          <p class="mc-pics-note">{note}</p>
        </div>
      )}
    </div>
  );
}

/** "≈ 188 KB of 25 MB", and the breakdown under it. */
export function SizeMeter({ s, cap, plainOnly }: { s: ReturnType<typeof useDraftSize>; cap: number; plainOnly: boolean }) {
  const { open, setOpen, box } = usePopover();
  // The account's cap counts the files' and pictures' own bytes (what dither-accounts checks), not their base64.
  const over = s.files + s.inside.bytes + s.embedded.bytes > cap;
  const rows: [string, string][] = [
    ['Text part', bytes(s.text)],
    ...(plainOnly ? [] : ([['HTML part', bytes(s.html)]] as [string, string][])),
    ...(s.inside.n ? ([[`${plural(s.inside.n, 'picture')} pasted in`, bytes(s.inside.bytes)]] as [string, string][]) : []),
    ...(s.embedded.n ? ([[`${plural(s.embedded.n, 'picture')} embedded`, about(s.embedded.bytes, s.embedded.unknown)]] as [string, string][]) : []),
    ...(s.files ? ([['Files', bytes(s.files)]] as [string, string][]) : []),
  ];
  return (
    <div class="mc-size" ref={box}>
      <button type="button" class={`mc-limit mc-size-btn${over ? ' over' : ''}`} aria-expanded={open} title="How big it is, as it goes" onClick={() => setOpen(!open)}>
        ≈ {bytes(s.sent)}
        <span class="mc-size-cap"> of {mbText(cap)}</span>
      </button>
      {open && (
        <div class="mc-size-pop" role="dialog" aria-label="Size">
          <table>
            <tbody>
              {rows.map(([k, v]) => (
                <tr>
                  <th scope="row">{k}</th>
                  <td>{v}</td>
                </tr>
              ))}
              <tr class="mc-size-total">
                <th scope="row">Sent in all</th>
                <td>≈ {bytes(s.sent)}</td>
              </tr>
              {s.linked.n > 0 && (
                <tr>
                  <th scope="row">Loaded on their end</th>
                  <td>
                    {plural(s.linked.n, 'picture')}, {about(s.linked.bytes, s.linked.unknown)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p class="mc-size-note">Pictures and files travel as base64, a third bigger than they are. This account takes {mbText(cap)} of files and pictures on one message.</p>
          {plainOnly && <p class="mc-size-note">Plain text only: no HTML part (the editor's Plain view).</p>}
        </div>
      )}
    </div>
  );
}
