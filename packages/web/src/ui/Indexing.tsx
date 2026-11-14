/**
 * Index jobs (docs/indexing.md): a server, a folder of servers or one conversation fetched whole through your
 * accounts, its history back to the start, its member list, or both. Started from a server's About page, a folder's
 * menu or a conversation's; followed and changed in Settings → Indexing. The hub does the work and keeps the
 * progress, so this only asks it and draws what it says. Mail has a part of its own there (mail/MailKeep.tsx: keeping
 * all mail, per account), in Mail's chunk.
 */
import type * as P from '@dither-chat/protocol';
import { JOB_PRIORITIES, JOB_REPEATS, NETWORK_META } from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { clock, dayLabel } from '../format.ts';
import { convLabel, convTitle, folderLeaves } from '../model.ts';
import { api, db, go, rev, toast } from '../state.ts';
import { Modal, NetGlyph, showSection } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Loading } from './Loader.tsx';
import { MailKeepLazy } from './mail/lazy.tsx';

/** What the index dialog is open for. */
export const indexing = signal<{ kind: P.JobTargetKind; id: string } | null>(null);
/** Bumped when a job is made here, so the list shows it without waiting for its next look. */
const jobsChanged = signal(0);

const PRIORITY_LABEL: Record<P.JobPriority, string> = { low: 'Low', normal: 'Normal', high: 'High' };
const STATE_LABEL: Record<P.JobState, string> = { queued: 'Queued', running: 'Running', paused: 'Paused', done: 'Done', failed: 'Failed' };

/** Opens Settings at Indexing. */
export function openIndexing() {
  go({ view: 'settings' });
  setTimeout(() => showSection('set-indexing', 'auto'), 120);
}

const able = (ids: Iterable<string>, capability: P.Capability) => [...ids].some((id) => {
  const a = db.accounts.get(id);
  return !!a && a.status !== 'disabled' && a.capabilities.includes(capability);
});

/** What a target is, as the dialog and the menus need it: its name, network, and what your accounts there can fetch. */
function describe(kind: P.JobTargetKind, id: string): { name: string; noun: string; network: P.Network | null; history: boolean; members: boolean; communities: boolean } | null {
  if (kind === 'space') {
    const s = db.spaces.get(id);
    if (!s) return null;
    const community = s.kind === 'community';
    const noun = s.kind === 'section' ? NETWORK_META[s.network].sectionNoun : s.network === 'discord' ? 'server' : NETWORK_META[s.network].spaceNoun;
    return { name: s.name, noun, network: s.network, history: able(s.accountIds, 'history'), members: community && able(s.accountIds, 'walkMembers'), communities: community };
  }
  if (kind === 'conversation') {
    const c = db.conversations.get(id);
    if (!c) return null;
    const accounts = c.vantages.map((v) => v.accountId);
    const channel = c.shape === 'channel' || c.shape === 'thread';
    return { name: c.shape === 'direct' ? convTitle(c) : convLabel(c), noun: channel ? 'channel' : 'chat', network: c.network, history: able(accounts, 'history'), members: false, communities: false };
  }
  const f = db.folders.find((x) => x.id === id);
  if (!f) return null;
  const spaces = folderLeaves(f).filter((i) => i.kind === 'space').map((i) => db.spaces.get(i.id)).filter((s): s is P.SpaceView => !!s);
  const convs = folderLeaves(f).filter((i) => i.kind === 'conversation').map((i) => db.conversations.get(i.id)).filter((c): c is P.ConversationView => !!c);
  const accounts = [...spaces.flatMap((s) => s.accountIds), ...convs.flatMap((c) => c.vantages.map((v) => v.accountId))];
  const communities = spaces.filter((s) => s.kind === 'community');
  const nets = new Set([...spaces.map((s) => s.network), ...convs.map((c) => c.network)]);
  return {
    name: f.name,
    noun: 'folder',
    network: nets.size === 1 ? [...nets][0] : null,
    history: able(accounts, 'history'),
    members: able(communities.flatMap((s) => s.accountIds), 'walkMembers'),
    communities: communities.length > 0,
  };
}

/** Whether any account of yours could fetch something of it: the menus offer indexing only then. */
export function canIndex(kind: P.JobTargetKind, id: string): boolean {
  const d = describe(kind, id);
  return !!d && (d.history || d.members);
}

/** Opens the index dialog for a target. */
export function startIndexing(kind: P.JobTargetKind, id: string) {
  indexing.value = { kind, id };
}

function IndexDialog({ kind, id, onClose }: { kind: P.JobTargetKind; id: string; onClose: () => void }) {
  const d = describe(kind, id);
  const [history, setHistory] = useState(d?.history ?? false);
  const [members, setMembers] = useState(false);
  const [repeat, setRepeat] = useState<number | null>(null);
  const [priority, setPriority] = useState<P.JobPriority>('normal');
  const [busy, setBusy] = useState(false);
  if (!d) return null;
  const membersHint = !d.communities
    ? kind === 'conversation'
      ? 'A single conversation has no member list of its own to walk.'
      : `This ${d.noun} holds no server or space with a member list.`
    : !d.members
      ? 'None of your accounts there can list members.'
      : 'Walked by name, a few letters at a time; a big server is listed only as far as the network lets it.';
  const submit = async () => {
    if (busy || (!history && !members)) return;
    setBusy(true);
    try {
      const spec: P.JobSpec = { target: { kind, id }, history, members, repeatHours: repeat, priority };
      await api<P.JobView>('/api/jobs', { body: spec });
      jobsChanged.value++;
      toast({ kind: 'info', title: `Indexing ${d.name}`, body: 'Follow it in Settings → Indexing.', action: openIndexing });
      onClose();
    } catch (e: any) {
      toast({ kind: 'error', title: 'Could not start indexing', body: e.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Index ${d.name}`} onClose={onClose}>
      <div class="index-dialog">
        <p class="set-help index-why">Fetched through your accounts at the network's pace; a big server can take hours. Repeats fetch only what is new.</p>
        <label class="toggle-row">
          <input type="checkbox" checked={history} disabled={!d.history} onChange={(e) => setHistory((e.target as HTMLInputElement).checked)} />
          <span>
            <b>Full message history</b>
            <small>{d.history ? 'Every channel and thread back to its start.' : 'None of your accounts there can page back through history.'}</small>
          </span>
        </label>
        <label class="toggle-row">
          <input type="checkbox" checked={members} disabled={!d.members} onChange={(e) => setMembers((e.target as HTMLInputElement).checked)} />
          <span>
            <b>Member list</b>
            <small>{membersHint}</small>
          </span>
        </label>
        <div class="index-fields">
          <label class="job-field">
            <span>Repeat</span>
            <select class="select" value={repeat === null ? '' : String(repeat)} onChange={(e) => setRepeat((e.target as HTMLSelectElement).value ? Number((e.target as HTMLSelectElement).value) : null)}>
              {JOB_REPEATS.map((r) => (
                <option value={r.hours === null ? '' : String(r.hours)}>{r.label}</option>
              ))}
            </select>
          </label>
          <label class="job-field">
            <span>Priority</span>
            <select class="select" value={priority} onChange={(e) => setPriority((e.target as HTMLSelectElement).value as P.JobPriority)}>
              {JOB_PRIORITIES.map((p) => (
                <option value={p}>{PRIORITY_LABEL[p]}</option>
              ))}
            </select>
          </label>
        </div>
        <div class="btn-row index-actions">
          <button class="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary" disabled={busy || (!history && !members)} onClick={() => void submit()}>
            {busy ? 'Starting…' : 'Start indexing'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function IndexLayer() {
  const t = indexing.value;
  return t ? <IndexDialog key={`${t.kind}:${t.id}`} kind={t.kind} id={t.id} onClose={() => (indexing.value = null)} /> : null;
}

// ------------------------------------------------------------------ Settings → Indexing

const KIND_LABEL = (j: P.JobView): string => {
  if (j.target.kind === 'folder') return 'Folder';
  if (j.target.kind === 'conversation') {
    const c = db.conversations.get(j.target.id);
    return c && (c.shape === 'channel' || c.shape === 'thread') ? 'Channel' : 'Conversation';
  }
  const s = db.spaces.get(j.target.id);
  const n = j.target.network;
  const noun = s?.kind === 'section' && n ? NETWORK_META[n].sectionNoun : n === 'discord' || !n ? 'server' : NETWORK_META[n].spaceNoun;
  return noun.replace(/^./, (x) => x.toUpperCase());
};

/** "today at 14:05", "Tuesday at 9:30". */
const when = (ts: number) => `${dayLabel(ts).replace(/^(Today|Yesterday)$/, (d) => d.toLowerCase())} at ${clock(ts)}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function repeatLabel(hours: number): string {
  return JOB_REPEATS.find((r) => r.hours === hours)?.label ?? (hours % 24 ? `Every ${plural(hours, 'hour')}` : `Every ${plural(hours / 24, 'day')}`);
}

function JobRow({ j, reload }: { j: P.JobView; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, what: string) => {
    setBusy(true);
    try {
      await fn();
      reload();
    } catch (e: any) {
      toast({ kind: 'error', title: `Could not ${what}`, body: e.message });
    } finally {
      setBusy(false);
    }
  };
  const patch = (body: { priority?: P.JobPriority; repeatHours?: number | null }) => act(() => api(`/api/jobs/${j.id}`, { method: 'PATCH', body }), 'change that');
  const post = (op: 'pause' | 'resume' | 'run') => act(() => api(`/api/jobs/${j.id}/${op}`, { body: {} }), op === 'run' ? 'run it' : op);
  const what = j.history && j.members ? 'History and members' : j.history ? 'History' : 'Members';
  const pct = j.tasks ? Math.round((j.done / j.tasks) * 100) : j.state === 'done' ? 100 : 0;
  const counts = [j.history && `${plural(j.fetched, 'message')} fetched in ${plural(j.pages, 'page')}`, j.members && `${plural(j.membersListed, 'member')} listed`].filter(Boolean).join(' · ');
  const repeats = JOB_REPEATS.some((r) => r.hours === j.repeatHours) ? JOB_REPEATS : [...JOB_REPEATS, { hours: j.repeatHours, label: repeatLabel(j.repeatHours!) }];
  return (
    <li class={`job ${j.state}`} data-job={j.id}>
      <div class="job-head">
        {j.target.network ? <NetGlyph network={j.target.network} size={14} /> : <Icon name="folder" size={14} />}
        <b class="job-name">{j.target.name}</b>
        <span class="job-kind">
          {KIND_LABEL(j)} · {what}
        </span>
        <span class={`job-pill ${j.state}`}>{STATE_LABEL[j.state]}</span>
      </div>
      <div class="job-bar" role="progressbar" aria-label={`${j.target.name}: ${j.done} of ${j.tasks} done`} aria-valuemin={0} aria-valuemax={j.tasks || 1} aria-valuenow={j.tasks ? j.done : j.state === 'done' ? 1 : 0}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <p class="job-line">
        {j.done.toLocaleString()} of {plural(j.tasks, 'place')} done{j.failed > 0 && `, ${j.failed.toLocaleString()} failed`}
        {counts && ` · ${counts}`}
      </p>
      {j.state === 'running' && j.current && (
        <div class="job-line job-now">
          <Loading inline label={`Now: ${j.current}`} />
        </div>
      )}
      {j.skipped > 0 && <p class="job-line job-skipped">{plural(j.skipped, 'place')} no account can fetch</p>}
      {j.error && (
        <p class="job-line job-error" role="alert">
          {j.error}
        </p>
      )}
      {(j.finishedAt || j.nextRunAt) && (
        <p class="job-line job-when">
          {j.finishedAt && `Finished ${when(j.finishedAt)}`}
          {j.finishedAt && j.nextRunAt && ' · '}
          {j.nextRunAt && `next run ${when(j.nextRunAt)}`}
        </p>
      )}
      <div class="job-controls">
        <label class="job-field">
          <span>Repeat</span>
          <select class="select" disabled={busy} value={j.repeatHours === null ? '' : String(j.repeatHours)} onChange={(e) => void patch({ repeatHours: (e.target as HTMLSelectElement).value ? Number((e.target as HTMLSelectElement).value) : null })}>
            {repeats.map((r) => (
              <option value={r.hours === null ? '' : String(r.hours)}>{r.label}</option>
            ))}
          </select>
        </label>
        <label class="job-field">
          <span>Priority</span>
          <select class="select" disabled={busy} value={j.priority} onChange={(e) => void patch({ priority: (e.target as HTMLSelectElement).value as P.JobPriority })}>
            {JOB_PRIORITIES.map((p) => (
              <option value={p}>{PRIORITY_LABEL[p]}</option>
            ))}
          </select>
        </label>
        <div class="job-buttons">
          {(j.state === 'running' || j.state === 'queued') && (
            <button class="btn ghost small" disabled={busy} onClick={() => void post('pause')}>
              Pause
            </button>
          )}
          {j.state === 'paused' && (
            <button class="btn ghost small" disabled={busy} onClick={() => void post('resume')}>
              Resume
            </button>
          )}
          {(j.state === 'done' || j.state === 'failed') && (
            <button class="btn ghost small" disabled={busy} onClick={() => void post('run')}>
              <Icon name="refresh" size={13} /> Run now
            </button>
          )}
          <button
            class="btn ghost small danger"
            disabled={busy}
            aria-label={`Delete the job for ${j.target.name}`}
            onClick={() => {
              if (confirm(`Delete the index job for ${j.target.name}? What it fetched stays.`)) void act(() => api(`/api/jobs/${j.id}`, { method: 'DELETE' }), 'delete it');
            }}
          >
            <Icon name="trash" size={13} /> Delete
          </button>
        </div>
      </div>
    </li>
  );
}

/** Settings → Indexing: every job, looked at every 2 s while one is working, every 20 s otherwise. */
export function IndexingSettings() {
  rev.value;
  const [jobs, setJobs] = useState<P.JobView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  const working = !!jobs?.some((j) => j.state === 'running' || j.state === 'queued');
  useEffect(() => {
    let live = true;
    api<{ jobs: P.JobView[] }>('/api/jobs').then(
      (r) => {
        if (!live) return;
        setJobs(r.jobs);
        setError(null);
      },
      (e) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [tick, jobsChanged.value]);
  useEffect(() => {
    const t = setTimeout(reload, working ? 2000 : 20_000);
    return () => clearTimeout(t);
  }, [tick, working]);
  return (
    <section class="set-block" id="set-indexing">
      <h3>Indexing</h3>
      <p class="set-help">
        A server, a folder or a conversation fetched whole: its history back to the start, its member list, or both, so this hub's search finds what was said before your accounts were watching. Start one from a server's About page, a folder's menu or a
        channel's.
      </p>
      {error && !jobs && (
        <p class="set-help job-error" role="alert">
          Could not load the jobs: {error}
        </p>
      )}
      {!jobs && !error && <Loading inline label="Loading…" />}
      {jobs && !jobs.length && <p class="set-help">Nothing being indexed.</p>}
      {jobs && jobs.length > 0 && (
        <ul class="jobs">
          {jobs.map((j) => (
            <JobRow key={j.id} j={j} reload={reload} />
          ))}
        </ul>
      )}
      <MailKeepLazy />
    </section>
  );
}
