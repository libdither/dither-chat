/**
 * A person's or group's stories, on their page only (docs/media-kinds.md): never in the inbox, never alerting, gone a
 * day after they were posted, as on Signal. Opening one marks it seen here and tells its author only where the
 * account's rules allow (read receipts on); replying and reacting go to their 1:1, or the group of a group story.
 */
import { createPortal } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { ago, fullTime } from '../format.ts';
import { useLayer } from '../phone.ts';
import { authorName } from '../model.ts';
import { api, toast } from '../state.ts';
import { Icon } from './icons.tsx';
import { Card } from './ProfileShell.tsx';

const QUICK = ['❤️', '😂', '😮', '😢', '👍', '🔥'];

/** A text story's background: its gradient, its colour, or the default. */
function backdrop(t: P.StoryTextFact): string {
  if (t.gradient && t.gradient.colors.length > 1) return `linear-gradient(${t.gradient.angle ?? 180}deg, ${t.gradient.colors.join(', ')})`;
  return t.gradient?.colors[0] ?? t.background ?? 'var(--accent-fill)';
}
const FONT: Record<string, string> = { SERIF: 'Georgia, serif', SCRIPT: 'cursive', CONDENSED: '"Arial Narrow", sans-serif', BOLD: 'inherit' };

function StoryFace({ s, big }: { s: P.StoryView; big?: boolean }) {
  if (s.attachment) {
    const a = s.attachment;
    if (a.kind === 'video') return <video class="story-media" src={a.url} muted={!big} controls={big} autoplay={big} playsInline preload="metadata" />;
    return <img class="story-media" src={a.url} alt={a.name ?? 'Story'} loading="lazy" />;
  }
  const t = s.text!;
  return (
    <div class="story-text" style={{ background: backdrop(t), color: t.color ?? '#fff', fontFamily: FONT[t.style ?? ''] ?? 'inherit', fontWeight: t.style === 'BOLD' ? 700 : undefined }}>
      <span style={t.textBackground ? { background: t.textBackground, padding: '2px 6px', borderRadius: '6px' } : undefined}>{t.text}</span>
      {big && t.url && (
        <a href={t.url} target="_blank" rel="noopener noreferrer" class="story-link">
          <Icon name="link" size={12} /> {t.url}
        </a>
      )}
    </div>
  );
}

export function StoriesCard({ identityId, conversationId }: { identityId?: string; conversationId?: string }) {
  const [list, setList] = useState<P.StoryView[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const q = identityId ? `identity=${identityId}` : `conversation=${conversationId}`;
  const load = () =>
    api<P.StoryView[]>(`/api/stories?${q}`)
      .then(setList)
      .catch(() => setList([]));
  useEffect(() => void load(), [q]);
  if (!list?.length) return null;
  return (
    <Card title="Stories" icon="sparkles" count={list.length} class="pf-stories">
      <div class="story-strip">
        {list.map((s, i) => (
          <button class={`story-thumb ${s.viewed ? 'seen' : ''}`} data-track="open story" onClick={() => setOpen(i)} title={`${fullTime(s.ts)}${conversationId ? ` · ${authorName(s.authorId)}` : ''}`}>
            <StoryFace s={s} />
            <small>{conversationId ? authorName(s.authorId) : ago(s.ts)}</small>
          </button>
        ))}
      </div>
      <p class="pf-hint">Stories end a day after they were posted. They never notify.</p>
      {open !== null && list[open] && (
        <StoryViewer
          list={list}
          at={open}
          setAt={setOpen}
          onSeen={(id) => setList((l) => l && l.map((x) => (x.id === id ? { ...x, viewed: true } : x)))}
          onClose={() => {
            setOpen(null);
            void load();
          }}
        />
      )}
    </Card>
  );
}

function StoryViewer({ list, at, setAt, onSeen, onClose }: { list: P.StoryView[]; at: number; setAt: (i: number) => void; onSeen: (id: string) => void; onClose: () => void }) {
  const s = list[at];
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useLayer(onClose);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (document.activeElement === input.current) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' && at < list.length - 1) setAt(at + 1);
      else if (e.key === 'ArrowLeft' && at > 0) setAt(at - 1);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [at]);
  // Opened: seen here, and its author told where the account's rules say so (the hub and adapter decide).
  useEffect(() => {
    if (s.viewed) return;
    void api(`/api/stories/${s.id}/viewed`, { method: 'POST' })
      .then(() => onSeen(s.id))
      .catch(() => {});
  }, [s.id]);
  const reply = async (b: { body?: string; emoji?: string }) => {
    setBusy(true);
    try {
      await api(`/api/stories/${s.id}/reply`, { body: b });
      setText('');
      toast({ kind: 'info', title: b.emoji ? `Reacted ${b.emoji}` : 'Replied', body: s.conversationId ? 'In the group' : `In your chat with ${authorName(s.authorId)}` });
    } catch (e) {
      toast({ kind: 'error', title: 'Not sent', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const left = Math.max(0, s.expiresAt - Date.now());
  return createPortal(
    <div class="story-viewer" role="dialog" aria-modal="true" aria-label={`Story by ${authorName(s.authorId)}`} data-track-area="story viewer">
      <div class="story-bar">
        <span>
          <b>{authorName(s.authorId)}</b> · {ago(s.ts)} · ends in {Math.max(1, Math.round(left / 3_600_000))} h
        </span>
        <button class="icon-btn" data-track="close story" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={22} />
        </button>
      </div>
      <div class="story-stage">
        {at > 0 && (
          <button class="story-nav prev" aria-label="Previous story" onClick={() => setAt(at - 1)}>
            <Icon name="back" size={20} />
          </button>
        )}
        <StoryFace s={s} big />
        {at < list.length - 1 && (
          <button class="story-nav next" aria-label="Next story" onClick={() => setAt(at + 1)}>
            <Icon name="chevronRight" size={20} />
          </button>
        )}
      </div>
      {s.allowsReplies ? (
        <div class="story-reply">
          <div class="story-quick">
            {QUICK.map((e) => (
              <button disabled={busy} data-track="react to story" aria-label={`React ${e}`} onClick={() => void reply({ emoji: e })}>
                {e}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void reply({ body: text.trim() });
            }}
          >
            <input ref={input} value={text} placeholder="Reply" aria-label="Reply to the story" onInput={(e) => setText((e.target as HTMLInputElement).value)} />
            <button class="send-btn" type="submit" disabled={busy || !text.trim()} aria-label="Send reply">
              <Icon name="send" size={16} />
            </button>
          </form>
        </div>
      ) : (
        <p class="story-noreply">Replies are off for this story.</p>
      )}
    </div>,
    document.body,
  );
}
