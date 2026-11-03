/**
 * Forwarding, as Discord's dialog does it: search every conversation on every account, pick up to five, add a
 * note, send. The hub decides per destination whether the network forwards it itself or the content goes again
 * (docs/menus.md#forwarding). Also the card a forward shows as in a timeline.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, sendBlocker } from '@dither-chat/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { phone } from '../phone.ts';
import { fullTime } from '../format.ts';
import { renderMarkdown } from '../markdown.ts';
import { authorName, communitiesOf, convLabel, convTitle, identityName, kindLabel, netName, plainBody, visibleConv } from '../model.ts';
import { api, db, go, isSelfIdentity, openProfile, prefs, rev, toast } from '../state.ts';
import { Avatar, Modal, NetGlyph } from './bits.tsx';
import { Icon } from './icons.tsx';
import { openConv } from './Sidebar.tsx';

export const forwarding = signal<P.MessageView | null>(null);

const MAX = 5;

function sender(c: P.ConversationView): P.AccountView | null {
  const accs = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a);
  return accs.find((a) => a.id === prefs.value.sendAs[c.id]) ?? accs.find((a) => a.status === 'online') ?? accs[0] ?? null;
}

/** How it will arrive, in a few words: the network's own forward, or a copy. */
function howLabel(m: P.MessageView, c: P.ConversationView): string {
  if (c.network !== m.network) return `Copy to ${netName(c.network)}`;
  const acc = sender(c);
  const native = acc && acc.capabilities.includes('forward') && m.seenVia.some((id) => c.vantages.some((v) => v.accountId === id));
  return native ? 'Forward' : 'Copy';
}

function where(c: P.ConversationView): string {
  if (c.shape === 'direct') return `Direct message · ${netName(c.network)}`;
  const com = communitiesOf(c)[0];
  return [com?.name, kindLabel(c)].filter(Boolean).join(' · ');
}

function ForwardDialog({ m, onClose }: { m: P.MessageView; onClose: () => void }) {
  rev.value;
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  // Preact leaves autofocus to the browser, which honours it only while a page loads. On a phone, no keyboard unasked.
  useEffect(() => void (!phone.value && search.current?.focus()), []);
  const all = useMemo(
    () =>
      [...db.conversations.values()]
        .filter((c) => visibleConv(c) && c.variant !== 'forum' && c.vantages.length > 0)
        .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0)),
    [rev.value],
  );
  const needle = q.trim().toLowerCase();
  const shown = (needle ? all.filter((c) => `${convTitle(c)} ${convLabel(c)} ${where(c)}`.toLowerCase().includes(needle)) : all).slice(0, 80);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX ? p : [...p, id]));
  const send = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    try {
      const r = await api<{ results: P.ForwardResult[] }>(`/api/messages/${m.id}/forward`, {
        body: { targets: picked.map((id) => ({ conversationId: id, ...(prefs.value.sendAs[id] ? { accountId: prefs.value.sendAs[id] } : {}) })), ...(note.trim() ? { note: note.trim() } : {}) },
      });
      const failed = r.results.filter((x) => !x.ok);
      const skipped = [...new Set(r.results.flatMap((x) => x.skipped ?? []))];
      if (!failed.length) {
        toast({ kind: 'info', title: r.results.length === 1 ? `Forwarded to ${convTitle(db.conversations.get(r.results[0].conversationId))}` : `Forwarded to ${r.results.length} conversations`, body: skipped.length ? `Left out: ${skipped.join(', ')}` : '' }, 3000);
        onClose();
      } else {
        toast({ kind: 'error', title: `Could not forward to ${failed.map((x) => convTitle(db.conversations.get(x.conversationId))).join(', ')}`, body: failed.map((x) => x.error).filter(Boolean).join('; ') });
        setPicked(failed.map((x) => x.conversationId));
      }
    } catch (e: any) {
      toast({ kind: 'error', title: 'Could not forward', body: e.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Forward To" onClose={onClose}>
      <div class="fwd">
        <p class="fwd-sub">Pick up to {MAX} places, on any account and any network.</p>
        <label class="search fwd-search">
          <Icon name="search" size={15} />
          <input ref={search} placeholder="Search conversations" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </label>
        {picked.length > 0 && (
          <div class="fwd-chips">
            {picked.map((id) => {
              const c = db.conversations.get(id);
              return (
                <button class="fwd-chip" onClick={() => toggle(id)} aria-label={`Remove ${convTitle(c)}`}>
                  {c && <NetGlyph network={c.network} size={11} />}
                  {convTitle(c)}
                  <Icon name="x" size={11} />
                </button>
              );
            })}
          </div>
        )}
        <div class="fwd-list" role="listbox" aria-multiselectable="true">
          {shown.map((c) => {
            const on = picked.includes(c.id);
            const blocked = sendBlocker(c, sender(c));
            const person = c.peerPersonId ? db.persons.get(c.peerPersonId) : null;
            const com = communitiesOf(c)[0];
            return (
              <button class={`fwd-row ${on ? 'on' : ''}`} role="option" aria-selected={on} disabled={!!blocked || (!on && picked.length >= MAX)} title={blocked ?? undefined} onClick={() => toggle(c.id)}>
                <Avatar id={person?.id ?? com?.id ?? c.id} name={convTitle(c)} url={person?.avatar ?? (c.shape === 'channel' || c.shape === 'thread' ? com?.icon : c.avatar) ?? c.avatar} size={32} square={c.shape !== 'direct'} network={c.network} />
                <span class="fwd-row-text">
                  <b>{c.shape === 'channel' || c.shape === 'thread' ? `#${convTitle(c)}` : convTitle(c)}</b>
                  <small>{blocked ?? where(c)}</small>
                </span>
                {!blocked && <span class="fwd-how">{howLabel(m, c)}</span>}
                <span class={`fwd-check ${on ? 'on' : ''}`} aria-hidden="true">
                  {on && <Icon name="check" size={13} />}
                </span>
              </button>
            );
          })}
          {!shown.length && <div class="fwd-empty">Nothing matches “{q}”.</div>}
        </div>
        <ForwardPreview m={m} />
        <div class="fwd-send">
          <input
            class="fwd-note"
            placeholder="Add an optional message…"
            value={note}
            maxLength={2000}
            onInput={(e) => setNote((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.isComposing && (e.preventDefault(), void send())}
          />
          <button class="btn primary" disabled={!picked.length || busy} onClick={() => void send()}>
            {busy ? 'Sending…' : picked.length > 1 ? `Send (${picked.length})` : 'Send'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** What is being forwarded, small. */
function ForwardPreview({ m }: { m: P.MessageView }) {
  const text = plainBody(m.forward?.text ?? m.body, m.network);
  const files = m.attachments.length;
  return (
    <div class="fwd-preview">
      <Icon name="forward" size={14} />
      <span>
        <b>{isSelfIdentity(m.authorId) ? identityName(m.authorId) || 'You' : authorName(m.authorId)}</b> {text.slice(0, 140) || (files ? '' : 'Message')}
        {files > 0 && <em> {files === 1 ? '1 attachment' : `${files} attachments`}</em>}
      </span>
    </div>
  );
}

export function ForwardLayer() {
  const m = forwarding.value;
  return m ? <ForwardDialog key={m.id} m={m} onClose={() => (forwarding.value = null)} /> : null;
}

// ------------------------------------------------------------------ in a timeline

/**
 * A forward: a bar down the side, "Forwarded", the content, then where it came from. Whatever the message also
 * says (a note the hub sent with it as one message) shows above the card, as Discord shows its own note below.
 */
export function ForwardCard({ m, children }: { m: P.MessageView; children: any }) {
  const f = m.forward!;
  const author = f.authorId ? (isSelfIdentity(f.authorId) ? 'You' : authorName(f.authorId)) : f.authorName;
  const origin = f.conversationId ? db.conversations.get(f.conversationId) : null;
  const fromNet = f.network && f.network !== m.network ? f.network : null;
  const note = f.note ? renderMarkdown(f.note, { network: m.network, user: () => null, room: () => null }) : null;
  return (
    <>
      {note && <div class="msg-body" dangerouslySetInnerHTML={{ __html: note }} />}
      <div class="fwd-card">
        <div class="fwd-card-head">
          <Icon name="forward" size={13} /> <i>Forwarded</i>
          {author && (
            <button class="fwd-card-author" onClick={() => f.authorId && openProfile(f.authorId)} disabled={!f.authorId}>
              {author}
            </button>
          )}
        </div>
        {children}
        {(f.source || fromNet || f.ts) && (
          <button class="fwd-card-src" disabled={!origin} onClick={() => (origin && f.messageId ? go({ view: 'inbox', conv: origin.id, msg: f.messageId }) : origin && openConv(origin))} title={f.ts ? fullTime(f.ts) : undefined}>
            {fromNet && <NetGlyph network={fromNet} size={11} />}
            {[f.source, fromNet ? NETWORK_META[fromNet].name : null].filter(Boolean).join(' · ')}
            {f.ts ? ` · ${new Date(f.ts).toLocaleDateString()}` : ''}
            {origin && <Icon name="chevronRight" size={11} />}
          </button>
        )}
      </div>
    </>
  );
}
