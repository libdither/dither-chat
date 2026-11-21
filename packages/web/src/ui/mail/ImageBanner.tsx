/**
 * The picture bar over a mail (docs/mail.md "Pictures and trackers"): what loaded, what is held back because loading it
 * would tell the sender you opened the mail, and the trackers that went: "3 loaded · 1 held back · 1 tracker removed ·
 * Load all · ⋯". The ⋯ menu sets this mail's own choice (none, only the ones that can't tell, or all; or back to the
 * usual), the sender's rule (Always or Never from them, or back to the setting), and opens Details: every picture's host, why it counts as what it is, what
 * happened to it and, once the hub has it, its size.
 *
 * Pictures come through the hub's proxy whatever happens, so a sender never sees your address. The bar is quiet when
 * there is nothing to say: everything loaded, none of it could tell, and nothing removed.
 */
import type * as P from '@dither-chat/protocol';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { bytes as bytesText } from '../../format.ts';
import { bodies, details } from '../../mail/api.ts';
import { api, go, toast } from '../../state.ts';
import { mailChanged } from '../../versions.ts';
import { groups, openMenu } from '../ContextMenu.tsx';
import { Icon } from '../icons.tsx';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Reloads the body views of open messages: what the hub serves changed. */
async function refresh(ids: string[]) {
  await Promise.all(
    ids.map((id) =>
      api<P.MailBodyView>(`/api/mail/messages/${encodeURIComponent(id)}/body`)
        .then((b) => bodies.set(id, b))
        .catch(() => {}),
    ),
  );
  mailChanged();
}

const CLASS_LABEL: Record<P.MailPicturesView['items'][number]['class'], string> = {
  shared: 'can’t tell',
  personal: 'can tell',
  tracker: 'tracker',
};
const ACTION_LABEL: Record<P.MailPicturesView['items'][number]['action'], string> = {
  load: 'loaded',
  hold: 'held back',
  drop: 'removed',
};

/** One row per host and kind, with how many of them and the bytes the hub has. */
function PictureDetails({ p }: { p: P.MailPicturesView }) {
  const rows = new Map<string, { host: string; item: P.MailPicturesView['items'][number]; n: number; size: number; sized: number }>();
  for (const x of p.items) {
    const key = `${x.host} ${x.class} ${x.action} ${x.why}`;
    const r = rows.get(key) ?? { host: x.host, item: x, n: 0, size: 0, sized: 0 };
    r.n++;
    if (x.size !== undefined) {
      r.size += x.size;
      r.sized++;
    }
    rows.set(key, r);
  }
  const hostsAll = p.hostsAll ?? p.hosts;
  return (
    <div class="mail-pic-details">
      {p.loaded > 0 && (
        <p class="mail-pic-note">
          {plural(p.loaded, 'picture')} from {plural(p.hosts, 'host')}
          {hostsAll > p.hosts ? ` (of ${hostsAll} in all)` : ''}
          {p.bytes ? `, ${bytesText(p.bytes)} fetched` : ''}
          {p.unknown ? `${p.bytes ? '' : ','} ${p.unknown} load when shown` : ''}.
        </p>
      )}
      <table>
        <tbody>
          {[...rows.values()].map((r) => (
            <tr class={`pic-${r.item.action}`}>
              <td class="pic-host">
                {r.host || 'unreadable address'}
                {r.n > 1 && <span class="pic-n"> ×{r.n}</span>}
              </td>
              <td class={`pic-class pic-${r.item.class}`}>{CLASS_LABEL[r.item.class]}</td>
              <td class="pic-why">{r.item.why}</td>
              <td class="pic-act">{ACTION_LABEL[r.item.action]}</td>
              <td class="pic-size">{r.item.action !== 'load' ? '' : r.sized === r.n ? bytesText(r.size) : r.sized ? `${bytesText(r.size)} + ${r.n - r.sized} when shown` : 'loads when shown'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="mail-pic-note">
        “Can’t tell”: the address is the same in every copy of the mail, so fetching it says someone opened some copy, not that you did. Everything comes through your hub, so no sender sees your
        address. Links are not changed: a link can still tell the sender you clicked it.
      </p>
    </div>
  );
}

/** This mail's choice, from the ⋯ menu. */
const THIS_MAIL: { v: P.MailSettings['pictures']; label: string }[] = [
  { v: 'none', label: 'No pictures' },
  { v: 'shared', label: 'Only the ones that can’t tell' },
  { v: 'all', label: 'All pictures' },
];

/** Settings, at Mail. */
function openPictureSettings() {
  go({ view: 'settings' });
  // Once the page has drawn its sections.
  setTimeout(() => document.getElementById('set-mail')?.scrollIntoView({ block: 'start' }), 250);
}

export function ImageBanner({ message, body }: { message: P.MailMessageView; body: P.MailBodyView }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const h = body.html;
  const p = h?.pictures;
  if (!h || !p) return null;
  // Pictures that could tell the sender keep the bar up even once loaded: you should know, and can take it back.
  const canTellLoaded = p.items.filter((x) => x.action === 'load' && x.class !== 'shared').length;
  const quiet = !p.held && !p.removed && !canTellLoaded && p.source === 'setting' && p.trackersSource !== 'message';
  if (quiet) return null;
  const who = message.from.name || message.from.email;
  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast({ kind: 'error', title: 'Could not change that', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const forMessage = (pictures: P.MailSettings['pictures'] | null) =>
    run(async () => {
      const r = await api<{ body: P.MailBodyView | null }>('/api/mail/images', { body: { messageId: message.id, pictures } });
      if (r.body) bodies.set(message.id, r.body);
      mailChanged();
    });
  const trackersFor = (trackers: 'keep' | 'remove' | null) =>
    run(async () => {
      const r = await api<{ body: P.MailBodyView | null }>('/api/mail/images', { body: { messageId: message.id, trackers } });
      if (r.body) bodies.set(message.id, r.body);
      mailChanged();
    });
  const forSender = (rule: { allow: boolean } | { forget: true }) =>
    run(async () => {
      await api('/api/mail/images', { body: { sender: message.from.email, ...rule } });
      // Every open message from them.
      const from = message.from.email.toLowerCase();
      const ids = [...details.values()].flatMap((d) => d.messages).filter((m) => m.from.email.toLowerCase() === from && bodies.has(m.id)).map((m) => m.id);
      await refresh([...new Set([message.id, ...ids])]);
    });
  const canTellHeld = p.items.some((x) => x.action === 'hold' && x.class !== 'shared');
  const tells = `they would tell ${who} you opened it`;
  const parts: ComponentChildren[] = [];
  if (p.loaded) parts.push(`${plural(p.loaded, 'picture')} loaded${canTellLoaded ? `, ${canTellLoaded} of them could tell ${who}` : ''}`);
  if (p.held)
    parts.push(
      p.policy === 'none' ? (
        `${plural(p.held, 'picture')} not loaded`
      ) : (
        <span title={canTellHeld ? `Held back: ${tells}` : undefined}>
          {p.held} held back
          {canTellHeld && <span class="mail-img-banner-faint mail-img-why"> ({tells})</span>}
        </span>
      ),
    );
  if (p.removed) parts.push(`${plural(p.removed, 'tracker')} removed`);
  if (p.keepTrackers && p.trackersSource === 'message') parts.push('trackers kept');
  const because = p.source === 'sender' ? (p.policy === 'none' ? `Never from ${who}` : `Always from ${who}`) : p.source === 'message' ? 'your choice for this mail' : null;
  const menu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(
      { x: r.right, y: r.bottom },
      {
        label: 'Pictures',
        items: groups(
          // This mail only: one of three, the one in force ticked.
          [
            { kind: 'label', label: 'This mail' },
            ...THIS_MAIL.map((x) => ({ label: x.label, checked: p.policy === x.v, radio: true, run: forMessage(x.v) })),
            p.source === 'message' && { label: 'Back to the usual', icon: 'refresh', run: forMessage(null) },
          ],
          // Trackers, this mail only: kept (they report that you opened it) or removed.
          [
            p.keepTrackers
              ? { label: 'Remove its trackers', icon: 'eyeOff', run: trackersFor(p.trackersSource === 'message' ? null : 'remove') }
              : { label: p.removed ? `Keep its ${plural(p.removed, 'tracker')}` : 'Keep its trackers', icon: 'eye', run: trackersFor(p.trackersSource === 'message' ? null : 'keep') },
          ],
          p.source === 'sender'
            ? [{ label: `Use my setting for ${who}`, icon: 'refresh', run: forSender({ forget: true }) }]
            : [
                { label: `Always load from ${who}`, icon: 'eye', run: forSender({ allow: true }) },
                { label: `Never load from ${who}`, icon: 'eyeOff', run: forSender({ allow: false }) },
              ],
          [
            { label: open ? 'Hide details' : 'Details', icon: 'info', run: () => setOpen(!open) },
            { label: 'Picture settings', icon: 'settings', run: openPictureSettings },
          ],
        ),
      },
      e.currentTarget,
    );
  };
  return (
    <div class="mail-img-banner" role="note">
      <div class="mail-img-banner-row">
        <Icon name="image" size={15} />
        <span class="mail-img-banner-text">
          {parts.length ? parts.flatMap((x, i) => (i ? [' · ', x] : [x])) : 'Pictures'}
          {because && <span class="mail-img-banner-faint"> · {because}</span>}
          {p.bytes > 0 && <span class="mail-img-banner-faint mail-img-bytes"> · {bytesText(p.bytes)}</span>}
        </span>
        <span class="mail-img-banner-acts">
          {p.held > 0 && (
            <button class="link-btn" disabled={busy} onClick={forMessage('all')} title="Load every picture of this mail, through your hub">
              Load all
            </button>
          )}
          <button class="icon-btn mail-img-more" disabled={busy} onClick={menu} aria-label="Picture choices" title="Picture choices">
            <Icon name="more" size={15} />
          </button>
        </span>
      </div>
      {open && <PictureDetails p={p} />}
    </div>
  );
}
