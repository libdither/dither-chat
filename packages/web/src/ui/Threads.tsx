/**
 * Threads, forums and group DMs beyond messages (docs/threads.md), a chunk of its own (ThreadsLazy.tsx): a forum's
 * posts with their tags, first messages and order, a channel's thread browser with its archived and your private
 * threads, the forms to start a thread or a post, and the About page's thread and group cards. Every write goes
 * through the hub, which asks the network afresh whether this account may; a refusal comes back as its sentence.
 */
import type * as P from '@dither-chat/protocol';
import { namedTags, POST_TAGS_MAX, postProblem, THREAD_NAME_MAX, THREAD_NOTIFY_LABEL, threadNameProblem } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ago } from '../format.ts';
import { authorName, convTitle, plainBody, threadsOf } from '../model.ts';
import { api, db, isSelfIdentity, rev, toast } from '../state.ts';
import { ableAccount, followThread, threadDialog, threadMuteChoices, threadNotify, type ThreadDialog } from '../threads.ts';
import { uploadFile } from '../upload.ts';
import { Empty, Modal } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Card } from './ProfileShell.tsx';
import { openConv } from './Sidebar.tsx';

// ---------------------------------------------------------------- posts

/** A forum's or channel's threads the hub has, archived ones too, newest activity first. */
function allThreads(convId: string): P.ConversationView[] {
  return (db.threads.get(convId) ?? []).map((id) => db.conversations.get(id)).filter((t): t is P.ConversationView => !!t);
}

/** A post's start: when it was made, else its id's time is not known here, so its first or latest message. */
const startedAt = (t: P.ConversationView) => t.thread?.createdAt ?? t.thread?.first?.ts ?? t.lastMessageAt ?? 0;

function TagChips({ forum, ids }: { forum: P.ForumView | undefined; ids: string[] }) {
  const tags = namedTags(forum, ids);
  if (!tags.length) return null;
  return (
    <span class="forum-tags">
      {tags.map((t) => (
        <span class="forum-tag">
          {t.emoji ? `${t.emoji} ` : ''}
          {t.name}
        </span>
      ))}
    </span>
  );
}

function PostRow({ t, forum, gallery }: { t: P.ConversationView; forum: P.ForumView | undefined; gallery: boolean }) {
  const first = t.thread?.first ?? null;
  const shown = first ?? t.lastMessage;
  const by = t.thread?.ownerId ?? first?.authorId ?? null;
  return (
    <button class={`forum-post ${t.archived ? 'archived' : ''} ${gallery ? 'tile' : ''}`} onClick={() => openConv(t)}>
      {gallery && (t.thread?.cover ? <img class="forum-cover" src={t.thread.cover} alt="" loading="lazy" /> : <span class="forum-cover none"><Icon name="image" size={22} /></span>)}
      <span class="forum-post-head">
        {t.thread?.pinned && <Icon name="pin" size={12} />}
        <b>{convTitle(t)}</b>
        {t.archived && <span class="forum-tag muted">Archived</span>}
        {t.thread?.locked && <Icon name="lock" size={12} />}
      </span>
      <TagChips forum={forum} ids={t.thread?.tags ?? []} />
      {!gallery && shown && (
        <span class="forum-preview">
          {shown.authorId ? `${authorName(shown.authorId)}: ` : ''}
          {plainBody(shown.text, t.network)}
        </span>
      )}
      <small class="forum-meta">
        {by ? `${isSelfIdentity(by) ? 'You' : authorName(by)} · ` : ''}
        {t.thread?.messageCount != null ? `${t.thread.messageCount} message${t.thread.messageCount === 1 ? '' : 's'} · ` : ''}
        {t.lastMessageAt ? ago(t.lastMessageAt) : ''}
        {t.thread?.following.length ? ' · following' : ''}
      </small>
    </button>
  );
}

/** A forum or media channel's page: its posts, by latest activity or newest, filtered by tag, a gallery for media. */
export function ForumView({ c }: { c: P.ConversationView }) {
  rev.value;
  const forum = c.forum;
  const [sort, setSort] = useState<'activity' | 'created'>(forum?.sort ?? 'activity');
  const [tags, setTags] = useState<ReadonlySet<string>>(new Set());
  const [archived, setArchived] = useState(false);
  const gallery = (forum?.layout ?? (c.variant === 'media' ? 'gallery' : 'list')) === 'gallery';
  const posts = allThreads(c.id)
    .filter((t) => archived || !t.archived)
    .filter((t) => !tags.size || (t.thread?.tags ?? []).some((x) => tags.has(x)))
    .sort((a, b) => Number(!!b.thread?.pinned) - Number(!!a.thread?.pinned) || (sort === 'created' ? startedAt(b) - startedAt(a) : (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0)));
  const toggle = (id: string) => setTags((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  return (
    <div class="forum">
      {c.topic && <p class="forum-topic">{c.topic}</p>}
      <div class="forum-bar">
        {ableAccount(c, 'forumPosts') && (
          <button class="btn primary small" onClick={() => (threadDialog.value = { kind: 'post', convId: c.id })}>
            <Icon name="pencil" size={13} /> New post
          </button>
        )}
        <select class="select small" value={sort} aria-label="Order" onChange={(e) => setSort((e.target as HTMLSelectElement).value as 'activity' | 'created')}>
          <option value="activity">Latest activity</option>
          <option value="created">Newest first</option>
        </select>
        <label class="forum-check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived((e.target as HTMLInputElement).checked)} /> Show archived
        </label>
        {ableAccount(c, 'listThreads') && (
          <button class="btn ghost small" onClick={() => (threadDialog.value = { kind: 'browse', convId: c.id, tab: 'archived' })}>
            <Icon name="archive" size={13} /> Load archived posts
          </button>
        )}
      </div>
      {!!forum?.tags.length && (
        <div class="forum-filter" role="group" aria-label="Filter by tag">
          {forum.tags.map((t) => (
            <button class={`chip-btn ${tags.has(t.id) ? 'on' : ''}`} aria-pressed={tags.has(t.id)} onClick={() => toggle(t.id)}>
              {t.emoji ? `${t.emoji} ` : ''}
              {t.name}
            </button>
          ))}
        </div>
      )}
      {posts.length === 0 && <Empty icon="forum" title={tags.size ? 'No posts with those tags loaded' : 'No posts loaded'} />}
      <div class={gallery ? 'forum-grid' : 'forum-list'}>
        {posts.map((t) => (
          <PostRow t={t} forum={forum} gallery={gallery} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the browser

function ThreadBrowser({ c, tab: first }: { c: P.ConversationView; tab: 'active' | 'archived' | 'mine' }) {
  rev.value;
  const [tab, setTab] = useState(first);
  const [page, setPage] = useState<{ ids: string[]; next: number | null; note?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async (t: typeof tab, offset: number) => {
    if (t === 'active') return;
    setBusy(true);
    try {
      const r = await api<P.ThreadPageView>(`/api/conversations/${c.id}/threads?archived=1${t === 'mine' ? '&mine=1' : ''}&offset=${offset}`);
      setPage((p) => ({ ids: [...(offset && p ? p.ids : []), ...r.conversationIds], next: r.next, ...(r.note ? { note: r.note } : {}) }));
    } catch (e) {
      setPage({ ids: [], next: null, note: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setPage(null);
    void load(tab, 0);
  }, [tab]);
  const list = tab === 'active' ? threadsOf(c.id).filter((t) => !t.archived) : (page?.ids ?? []).map((id) => db.conversations.get(id)).filter((t): t is P.ConversationView => !!t);
  const pick = (t: P.ConversationView) => {
    threadDialog.value = null;
    openConv(t);
  };
  return (
    <div class="thread-browser">
      <div class="thread-tabs" role="tablist">
        {(['active', 'archived', ...(ableAccount(c, 'myThreads') && c.variant !== 'forum' && c.variant !== 'media' ? (['mine'] as const) : [])] as const).map((t) => (
          <button role="tab" aria-selected={tab === t} class={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'active' ? 'Active' : t === 'archived' ? 'Archived' : 'Your private ones'}
          </button>
        ))}
      </div>
      {page?.note && <p class="pf-hint">{page.note}</p>}
      {list.length === 0 && !busy && <Empty icon="thread" title={tab === 'active' ? 'No active threads loaded' : 'None found'} />}
      <div class="pf-rows">
        {list.map((t) => (
          <button class="pf-row" onClick={() => pick(t)}>
            <span class="pf-chan-icon">
              <Icon name="thread" size={16} />
            </span>
            <span class="pf-row-text">
              <b>{convTitle(t)}</b>
              <small>
                {t.thread?.private ? 'Private · ' : ''}
                {t.lastMessageAt ? ago(t.lastMessageAt) : ''}
              </small>
            </span>
          </button>
        ))}
      </div>
      {busy && <p class="pf-hint">Asking Discord…</p>}
      {page?.next != null && !busy && (
        <button class="btn ghost small" onClick={() => void load(tab, page.next!)}>
          More
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- starting

async function uploads(files: File[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) out.push((await uploadFile(f, f.name, f.type || 'application/octet-stream')).id);
  return out;
}

function StartThread({ c, messageId, name: first }: { c: P.ConversationView; messageId?: string; name?: string }) {
  const [name, setName] = useState(first ?? '');
  const [body, setBody] = useState('');
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const problem = threadNameProblem(name);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<P.CreatedThreadView>(`/api/conversations/${c.id}/threads`, { body: { name, ...(messageId ? { message: messageId } : {}), ...(priv ? { private: true } : {}), ...(body.trim() ? { body } : {}), accountId: ableAccount(c, 'createThreads') } });
      threadDialog.value = null;
      const t = db.conversations.get(r.conversationId);
      if (t) openConv(t);
      toast({ kind: 'info', title: 'Thread started', body: name.trim() }, 3000);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not start the thread', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="thread-form" onSubmit={(e) => (e.preventDefault(), !problem && void submit())}>
      <label>
        Name
        <input class="input" value={name} maxLength={THREAD_NAME_MAX} autoFocus onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </label>
      {!messageId && (
        <label>
          First message (optional)
          <textarea class="input" rows={3} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
        </label>
      )}
      {c.variant !== 'announcement' && !messageId && (
        <label class="forum-check">
          <input type="checkbox" checked={priv} onChange={(e) => setPriv((e.target as HTMLInputElement).checked)} /> Private: only people you add, and moderators, see it
        </label>
      )}
      {name && problem && <small class="about-reason">{problem}</small>}
      <button class="btn primary" disabled={busy || !!problem}>
        {busy ? 'Starting…' : 'Start thread'}
      </button>
    </form>
  );
}

function NewPost({ c }: { c: P.ConversationView }) {
  const forum = c.forum;
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const problem = postProblem({ name, body, tags, files: files.length }, forum?.tags.length ? forum : null) ?? (c.variant === 'media' && !files.length ? 'A media channel post starts with a picture or a video' : null);
  const toggle = (id: string) => setTags((t) => (t.includes(id) ? t.filter((x) => x !== id) : t.length < POST_TAGS_MAX ? [...t, id] : t));
  const submit = async () => {
    setBusy(true);
    try {
      const attachments = await uploads(files);
      const r = await api<P.CreatedThreadView>(`/api/conversations/${c.id}/posts`, { body: { name, body, tags, attachments, accountId: ableAccount(c, 'forumPosts') } });
      threadDialog.value = null;
      const t = db.conversations.get(r.conversationId);
      if (t) openConv(t);
      toast({ kind: 'info', title: 'Posted', body: name.trim() }, 3000);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not post it', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="thread-form" onSubmit={(e) => (e.preventDefault(), !problem && void submit())}>
      <label>
        Title
        <input class="input" value={name} maxLength={THREAD_NAME_MAX} autoFocus onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Message
        <textarea class="input" rows={5} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
      </label>
      {!!forum?.tags.length && (
        <div class="forum-filter" role="group" aria-label="Tags">
          {forum.tags.map((t) => (
            <button type="button" class={`chip-btn ${tags.includes(t.id) ? 'on' : ''}`} aria-pressed={tags.includes(t.id)} title={t.moderated ? 'Only moderators may use this tag' : undefined} onClick={() => toggle(t.id)}>
              {t.emoji ? `${t.emoji} ` : ''}
              {t.name}
            </button>
          ))}
        </div>
      )}
      <label>
        Files
        <input type="file" multiple accept={c.variant === 'media' ? 'image/*,video/*' : undefined} onChange={(e) => setFiles([...((e.target as HTMLInputElement).files ?? [])])} />
      </label>
      {(name || body || files.length > 0) && problem && <small class="about-reason">{problem}</small>}
      <button class="btn primary" disabled={busy || !!problem}>
        {busy ? 'Posting…' : 'Post'}
      </button>
    </form>
  );
}

/** What the thread menus opened: the browser or a form, over the page. */
export function ThreadsLayer() {
  rev.value;
  const d: ThreadDialog | null = threadDialog.value;
  const c = d ? db.conversations.get(d.convId) : undefined;
  if (!d || !c) return null;
  const close = () => (threadDialog.value = null);
  const title = d.kind === 'browse' ? `Threads in ${convTitle(c)}` : d.kind === 'post' ? `New post in ${convTitle(c)}` : d.messageId ? 'Create thread from message' : `Start a thread in ${convTitle(c)}`;
  return (
    <Modal title={title} onClose={close}>
      {d.kind === 'browse' && <ThreadBrowser c={c} tab={d.tab ?? 'active'} />}
      {d.kind === 'start' && <StartThread c={c} messageId={d.messageId} name={d.name} />}
      {d.kind === 'post' && <NewPost c={c} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- About cards

/** A thread's About card: following and how it notifies, archiving and locking where you may. */
export function ThreadCard({ c, view, onDone }: { c: P.ConversationView; view: P.AboutView; onDone: (v: P.AboutView) => void }) {
  const t = view.thread!;
  const [busy, setBusy] = useState(false);
  const follow = !!ableAccount(c, 'followThreads');
  const state = async (change: { archived?: boolean; locked?: boolean }, what: string) => {
    setBusy(true);
    try {
      onDone(await api<P.AboutView>(`/api/conversations/${c.id}/thread-state`, { body: { ...change, ...(view.accountId ? { accountId: view.accountId } : {}) } }));
      toast({ kind: 'info', title: what, body: convTitle(c) }, 3000);
    } catch (e) {
      toast({ kind: 'error', title: `Could not change the thread`, body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const joined = !!c.thread?.following.length || t.joined;
  return (
    <Card title="Thread" icon="thread">
      {follow && (
        <>
          <p class="pf-hint">{joined ? 'You follow it: Discord tells you of its messages as set below.' : 'You do not follow it: only mentions of you reach you from it.'}</p>
          <div class="pf-actions-row">
            <button class="btn ghost small" disabled={busy} onClick={() => void followThread(c, !joined)}>
              <Icon name={joined ? 'bellOff' : 'bell'} size={13} /> {joined ? 'Unfollow' : 'Follow'}
            </button>
          </div>
          {joined && (
            <label class="pf-level">
              <select class="select" value={c.thread?.notify ?? t.notify ?? ''} onChange={(e) => void threadNotify(c, { notify: (e.target as HTMLSelectElement).value as P.ThreadNotify })}>
                <option value="" disabled>
                  As its channel
                </option>
                {(['all', 'mentions', 'none'] as const).map((n) => (
                  <option value={n}>{THREAD_NOTIFY_LABEL[n]}</option>
                ))}
              </select>
            </label>
          )}
          {joined && (
            <label class="pf-level">
              <select
                class="select"
                value={(c.thread?.muted ?? t.muted) ? 'on' : ''}
                aria-label="Mute the thread on Discord"
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  void threadNotify(c, v === '' ? { muted: false } : { muted: true, minutes: v === 'forever' ? null : Number(v) });
                }}
              >
                <option value="">Not muted on Discord</option>
                {(c.thread?.muted ?? t.muted) && (
                  <option value="on" disabled>
                    Muted on Discord{c.thread?.mutedUntil ? ` until ${new Date(c.thread.mutedUntil).toLocaleString()}` : ''}
                  </option>
                )}
                {threadMuteChoices().map(([v, label]) => (
                  <option value={v}>{label}</option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      <div class="pf-actions-row">
        <button class="btn ghost small" disabled={busy || !t.canArchive} title={t.canArchive ? undefined : t.reason} onClick={() => void state({ archived: !t.archived }, t.archived ? 'Unarchived' : 'Archived')}>
          <Icon name="archive" size={13} /> {t.archived ? 'Unarchive' : 'Archive'}
        </button>
        <button class="btn ghost small" disabled={busy || !t.canLock} title={t.canLock ? undefined : 'You need the Manage Threads permission.'} onClick={() => void state({ locked: !t.locked }, t.locked ? 'Unlocked' : 'Locked')}>
          <Icon name="lock" size={13} /> {t.locked ? 'Unlock' : 'Lock'}
        </button>
      </div>
      {!t.canArchive && t.reason && (
        <small class="about-reason">
          <Icon name="lock" size={11} /> {t.reason}
        </small>
      )}
    </Card>
  );
}

/** A group's owner card: who owns it, taking someone out or handing it over, its picture. */
export function GroupCard({ c, view, onDone }: { c: P.ConversationView; view: P.AboutView; onDone: (v: P.AboutView) => void }) {
  rev.value;
  const o = view.ownership!;
  const [busy, setBusy] = useState(false);
  const acct = view.accountId ? { accountId: view.accountId } : {};
  const run = async (path: string, body: object, what: string) => {
    setBusy(true);
    try {
      onDone(await api<P.AboutView>(path, { body: { ...body, ...acct } }));
      toast({ kind: 'info', title: what, body: convTitle(c) }, 3000);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not change the group', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const others = (view.members?.list ?? []).filter((m) => !isSelfIdentity(m.identityId) && m.identityId !== o.owner);
  const picture = !!view.fields.avatar?.canEdit && !!ableAccount(c, 'groupPicture');
  const pickPicture = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const up = await uploadFile(f, f.name, f.type);
      setBusy(false);
      await run(`/api/conversations/${c.id}/picture`, { upload: up.id }, 'Picture changed');
    } catch (e) {
      setBusy(false);
      toast({ kind: 'error', title: 'Could not change the picture', body: (e as Error).message });
    }
  };
  return (
    <Card title="Group" icon="users">
      <p class="pf-hint">{o.youOwn ? 'You own this group.' : o.owner ? `${authorName(o.owner)} owns this group.` : 'Its owner left.'}</p>
      {(o.canRemove || o.canTransfer) &&
        others.map((m) => (
          <div class="pf-actions-row">
            <span class="pf-member-name">{authorName(m.identityId)}</span>
            {o.canRemove && (
              <button class="btn ghost small" disabled={busy} onClick={() => confirm(`Remove ${authorName(m.identityId)} from ${convTitle(c)}?`) && void run(`/api/conversations/${c.id}/members/${m.identityId}/remove`, {}, 'Removed')}>
                Remove
              </button>
            )}
            {o.canTransfer && (
              <button class="btn ghost small" disabled={busy} onClick={() => confirm(`Make ${authorName(m.identityId)} the owner of ${convTitle(c)}?\n\nYou can no longer remove people from it, or take it back yourself.`) && void run(`/api/conversations/${c.id}/members/${m.identityId}/owner`, {}, 'Handed over')}>
                Make owner
              </button>
            )}
          </div>
        ))}
      {!o.youOwn && o.reason && <small class="about-reason">{o.reason} Removing people and handing it over are the owner's.</small>}
      {picture && (
        <div class="pf-actions-row">
          <label class="btn ghost small">
            <Icon name="image" size={13} /> Change picture
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => void pickPicture((e.target as HTMLInputElement).files?.[0])} />
          </label>
          {c.avatar && (
            <button class="btn ghost small" disabled={busy} onClick={() => void run(`/api/conversations/${c.id}/picture`, { upload: null }, 'Picture removed')}>
              Remove picture
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
