/**
 * Forwarding a message into other conversations. Within a network, through the network's own forward where the
 * adapter has one and the sending account can read the original; otherwise the hub sends the content again,
 * files included, through the destination account's ordinary send. See docs/menus.md#forwarding.
 */
import type * as P from '@dither-chat/protocol';
import { ATTACHMENT_LIMITS, NETWORK_META } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { lowerForSend, lowerRefs, storeResolve } from './mentionrefs.ts';
import type { Store } from './store.ts';
import type { Uploads } from './uploads.ts';

/** At most this many destinations per forward, as Discord allows. */
export const MAX_TARGETS = 5;
export const MAX_NOTE = 2000;

/**
 * Which account sends into a destination, and how. `picked` is the hub's usual choice for the destination
 * (the requested account, else the last one used there, else any connected one); `requested` is set only when
 * the person chose an account to send as. A native forward needs an account that can read the original too.
 */
export function planForward(
  src: { network: P.Network; seenVia: string[] },
  dest: { network: P.Network; accounts: string[] },
  o: { picked: string | null; requested?: string; canForward: (accountId: string) => boolean; online: (accountId: string) => boolean },
): { mode: P.ForwardMode; accountId: string } | null {
  if (!o.picked) return null;
  if (dest.network !== src.network) return { mode: 'cross', accountId: o.picked };
  const native = (a: string) => src.seenVia.includes(a) && o.canForward(a) && o.online(a);
  if (o.requested && dest.accounts.includes(o.requested)) return { mode: native(o.requested) ? 'native' : 'resend', accountId: o.requested };
  if (native(o.picked)) return { mode: 'native', accountId: o.picked };
  const other = dest.accounts.find(native);
  return other ? { mode: 'native', accountId: other } : { mode: 'resend', accountId: o.picked };
}

/** Networks whose own clients forward without saying so. A re-send within them looks the same. */
const BARE_RESEND: Partial<Record<P.Network, true>> = { signal: true };

/** Mentions as plain names, so a re-sent message pings nobody; channel and emoji tokens as text another network can show. */
export function plainTokens(body: string, name: (kind: 'user' | 'room', nativeId: string) => string | null): string {
  return body
    .replace(/<@&\d+>/g, '@role')
    .replace(/<@!?([^>\s]+)>/g, (_, id) => '@' + (name('user', id) ?? 'someone'))
    .replace(/<#([^>\s]+)>/g, (_, id) => '#' + (name('room', id) ?? 'channel'))
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/@(everyone|here)\b/g, '@​$1');
}

/** The text of a forward that goes out as an ordinary message: the note, a line saying where it came from, the original quoted. */
export function forwardText(o: { note?: string; text: string; author: string | null; source: string | null; network: P.Network; dest: P.Network; mode: P.ForwardMode }): string {
  const note = o.note?.trim();
  if (o.mode === 'resend' && BARE_RESEND[o.dest]) return [note, o.text].filter(Boolean).join('\n\n');
  const where = [o.source, o.network !== o.dest ? NETWORK_META[o.network].name : null].filter(Boolean).join(', ');
  const line = `↪ Forwarded${o.author ? ` from **${o.author}**` : ''}${where ? ` (${where})` : ''}`;
  const quoted = o.text.trim() ? o.text.trim().split('\n').map((l) => `> ${l}`).join('\n') : '';
  return [note, [line, quoted].filter(Boolean).join('\n')].filter(Boolean).join('\n\n');
}

export interface ForwardDeps {
  store: Store;
  uploads: Uploads;
  online(accountId: string): boolean;
  command<T = unknown>(accountId: string, cmd: P.AdapterCommand extends infer C ? (C extends { id: string } ? Omit<C, 'id'> : C) : never, timeout?: number): Promise<T>;
  pickAccount(conversationId: string, requested?: string): string | null;
  sendRefusal(conversationId: string, accountId: string | null): string | null;
  /** The bytes behind a stored attachment URL, as the media proxy fetches them. */
  media(raw: string, accountId: string | null): Promise<{ bytes: Uint8Array; mime: string } | null>;
}

type File = { name: string; mime: string; kind: P.AttachmentKind; bytes: Uint8Array };

export async function forwardMessage(deps: ForwardDeps, messageId: string, req: P.ForwardRequest): Promise<P.ForwardResult[] | { error: string; status: number }> {
  const { store } = deps;
  const targets = (req.targets ?? []).filter((t, i, all) => t && typeof t.conversationId === 'string' && all.findIndex((x) => x.conversationId === t.conversationId) === i);
  if (!targets.length) return { error: 'forward to where?', status: 400 };
  if (targets.length > MAX_TARGETS) return { error: `at most ${MAX_TARGETS} conversations at a time`, status: 400 };
  const note = typeof req.note === 'string' ? req.note.trim().slice(0, MAX_NOTE) : '';
  const src = store.forwardSource(messageId);
  if (!src) return { error: 'no such message', status: 404 };
  const m = src.view;
  // Forwarding a forward passes on the original.
  const inner = m.forward;
  const text = inner?.text ?? m.body;
  const author = inner ? (inner.authorId ? store.identityLabel(inner.authorId) : inner.authorName) : src.authorName;
  const source = inner ? inner.source : store.placeLabel(m.conversationId);
  const origin: P.ForwardView = {
    messageId: inner?.messageId ?? m.id,
    conversationId: inner?.conversationId ?? m.conversationId,
    authorId: inner ? inner.authorId : m.authorId,
    authorName: author,
    network: inner?.network ?? m.network,
    source,
    ts: inner?.ts ?? m.ts,
  };
  const names = (kind: 'user' | 'room', id: string) =>
    kind === 'user' ? store.identityLabel(hubId('idn', m.network, id)) : store.conversationView(hubId('cnv', m.network, id))?.name ?? null;
  // A person or account named by reference (a Calendar chat's) goes on as their name.
  const plain = plainTokens(lowerRefs(text, storeResolve(store, '')), names);

  let files: File[] | null = null;
  const loadFiles = async (): Promise<{ files: File[]; missing: string[] }> => {
    const missing: string[] = [];
    if (!files) {
      files = [];
      for (const f of src.files) {
        const got = await deps.media(f.url, m.seenVia[0] ?? null).catch(() => null);
        if (!got) missing.push(f.name ?? 'file');
        else files.push({ name: f.name ?? 'file', mime: f.mime ?? got.mime, kind: f.kind, bytes: got.bytes });
      }
    }
    return { files, missing };
  };

  const results: P.ForwardResult[] = [];
  for (const t of targets) {
    const conv = store.nativeOf('conversation', t.conversationId);
    const destView = store.conversationView(t.conversationId);
    if (!conv || !destView) {
      results.push({ conversationId: t.conversationId, ok: false, error: 'no such conversation' });
      continue;
    }
    const accounts = store.vantageAccounts('conversation', t.conversationId);
    const plan = planForward(
      { network: m.network, seenVia: m.seenVia },
      { network: conv.network, accounts },
      {
        picked: deps.pickAccount(t.conversationId, t.accountId),
        requested: t.accountId,
        online: deps.online,
        canForward: (a) => (JSON.parse(store.account(a)?.capabilities ?? '[]') as P.Capability[]).includes('forward'),
      },
    );
    if (!plan) {
      results.push({ conversationId: t.conversationId, ok: false, error: 'no connected account can send here' });
      continue;
    }
    const refused = deps.sendRefusal(t.conversationId, plan.accountId);
    if (refused) {
      results.push({ conversationId: t.conversationId, ok: false, accountId: plan.accountId, error: refused });
      continue;
    }
    try {
      let mode = plan.mode;
      let nativeId: string | null = null;
      const skipped: string[] = [];
      // Your note's references, as this destination's network takes them (mentionrefs.ts).
      const noteHere = note && lowerForSend(store, t.conversationId, JSON.parse(store.account(plan.accountId)?.capabilities ?? '[]'), note);
      if (mode === 'native') {
        const r = await deps.command<{ nativeId?: string | null; fallback?: string }>(
          plan.accountId,
          { t: 'forward', conversation: conv.nativeId, source: { conversation: src.conversationNative, message: m.nativeId }, ...(noteHere ? { note: noteHere } : {}) },
          60_000,
        );
        if (r?.fallback) mode = 'resend';
        else nativeId = r?.nativeId ?? null;
      }
      if (mode !== 'native') {
        const { files: all, missing } = await loadFiles();
        skipped.push(...missing);
        const acc = store.account(plan.accountId)!;
        const canFiles = (JSON.parse(acc.capabilities) as P.Capability[]).includes('sendMedia');
        const limit = ATTACHMENT_LIMITS[conv.network];
        const fit = all.filter((f) => canFiles && f.bytes.length <= limit.bytes).slice(0, limit.files);
        for (const f of all) if (!fit.includes(f)) skipped.push(f.name);
        const body = forwardText({ note: noteHere, text: plain, author, source, network: m.network, dest: conv.network, mode });
        const ids = fit.map((f) => deps.uploads.put(f.bytes, f.name, f.mime).id);
        try {
          const spool = deps.uploads.get(ids) ?? [];
          if (!body.trim() && !spool.length) throw new Error('nothing in this message can go there');
          const r = await deps.command<{ nativeId?: string | null }>(plan.accountId, { t: 'send', conversation: conv.nativeId, body, ...(spool.length ? { attachments: spool } : {}) }, spool.length ? 180_000 : undefined);
          nativeId = r?.nativeId ?? null;
        } finally {
          deps.uploads.remove(ids);
        }
      }
      if (nativeId) {
        const view: P.ForwardView = { ...origin, sentAs: mode, ...(mode === 'native' ? {} : { text: plain, ...(note ? { note } : {}) }) };
        store.recordForward(hubId('msg', conv.network, nativeId), view);
      }
      results.push({ conversationId: t.conversationId, ok: true, mode, accountId: plan.accountId, ...(skipped.length ? { skipped } : {}) });
    } catch (e: any) {
      results.push({ conversationId: t.conversationId, ok: false, mode: plan.mode, accountId: plan.accountId, error: String(e?.message ?? e) });
    }
  }
  return results;
}
