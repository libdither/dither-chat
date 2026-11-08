/**
 * "3 remote images hidden · Load · Always from Sam" (docs/mail-design.md §7). Remote images are held back until you
 * ask, because loading them tells the sender you opened the mail; when you do, they come through the hub's proxy, so
 * the sender never sees your address. Trackers (1-2 px images) stay out either way.
 */
import type * as P from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { bodies, details } from '../../mail/api.ts';
import { api, toast } from '../../state.ts';
import { mailChanged } from '../../versions.ts';
import { Icon } from '../icons.tsx';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

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

export function ImageBanner({ message, body }: { message: P.MailMessageView; body: P.MailBodyView }) {
  const [busy, setBusy] = useState(false);
  const h = body.html;
  if (!h || h.imagesShown || !h.remoteImages) return null;
  const who = message.from.name || message.from.email;
  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast({ kind: 'error', title: 'Could not load the images', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const load = run(async () => {
    const r = await api<{ body: P.MailBodyView | null }>('/api/mail/images', { body: { messageId: message.id } });
    if (r.body) bodies.set(message.id, r.body);
    mailChanged();
  });
  const always = run(async () => {
    await api('/api/mail/images', { body: { sender: message.from.email, allow: true } });
    // Every open message from them.
    const from = message.from.email.toLowerCase();
    const ids = [...details.values()].flatMap((d) => d.messages).filter((m) => m.from.email.toLowerCase() === from && bodies.has(m.id)).map((m) => m.id);
    await refresh([...new Set([message.id, ...ids])]);
  });
  return (
    <div class="mail-img-banner" role="note">
      <Icon name="image" size={15} />
      <span class="mail-img-banner-text">
        {plural(h.remoteImages, 'A remote image', 'remote images')} hidden
        {h.trackers > 0 && <span class="mail-img-banner-faint"> · {plural(h.trackers, 'a tracker', 'trackers')} removed</span>}
      </span>
      <span class="mail-img-banner-acts">
        <button class="link-btn" disabled={busy} onClick={load} title="Load this message's images through your hub">
          Load
        </button>
        <span aria-hidden="true">·</span>
        <button class="link-btn" disabled={busy} onClick={always} title={`Always load images from ${message.from.email}`}>
          Always from {who}
        </button>
      </span>
    </div>
  );
}
