/**
 * Same person? (docs/same-person.md): people the hub thinks may be one person on several accounts, strongest first,
 * each with why. Merge, Not the same, or Later; strong ones can be merged together after a look down the list. Opened
 * from the People header; loaded only then (its own chunk). Nothing is merged without a click.
 */
import type * as P from '@dither-chat/protocol';
import { MATCH_FAINT, MATCH_SHOWN, MATCH_STRONG } from '@dither-chat/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { netName } from '../model.ts';
import { api, go, toast } from '../state.ts';
import { Avatar, Empty, Modal, NetBadge, openAdversarial } from '../ui/bits.tsx';
import { Icon } from '../ui/icons.tsx';
import { Loading } from '../ui/Loader.tsx';
import { components } from './merge.ts';
import { hashPictures } from './pictures.ts';

type Filter = 'all' | 'strong' | 'groups';

const KIND: Record<P.MatchEvidenceKind, { icon: string; label: string }> = {
  claims: { icon: 'link', label: 'Profile link' },
  contact: { icon: 'phone', label: 'Same contact' },
  bridge: { icon: 'merge', label: 'Bridge' },
  picture: { icon: 'image', label: 'Picture' },
  name: { icon: 'idBadge', label: 'Name' },
  friends: { icon: 'users', label: 'Friends' },
  bio: { icon: 'fileText', label: 'Bio' },
  handoff: { icon: 'repeat', label: 'Chats' },
  model: { icon: 'sparkles', label: 'jev' },
  against: { icon: 'alert', label: 'Against' },
};

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** The list's bands, likeliest first: a heading where each starts. */
const BANDS: { min: number; title: string }[] = [
  { min: MATCH_STRONG, title: 'Almost surely one person' },
  { min: 0.6, title: 'Likely' },
  { min: MATCH_SHOWN, title: 'Maybe' },
  { min: MATCH_FAINT, title: 'Faint' },
];
const bandOf = (p: number) => BANDS.findIndex((b) => p >= b.min);
const range = (i: number) => `${pct(BANDS[i].min)}${i ? ` to ${pct(BANDS[i - 1].min)}` : ' or more'}`;

/** Pairs in bands, a heading where each band starts. */
function Banded({ pairs, card }: { pairs: P.MatchSuggestion[]; card: (s: P.MatchSuggestion) => preact.ComponentChildren }) {
  let at = -1;
  return (
    <>
      {pairs.map((s) => {
        const b = bandOf(s.p);
        const head = b !== at;
        at = b;
        return (
          <>
            {head && (
              <h3 class="sp-band">
                {BANDS[b].title} <small>{range(b)}</small>
              </h3>
            )}
            {card(s)}
          </>
        );
      })}
    </>
  );
}

/** A bridge's stand-in on Matrix (@discord_123:server): what it stands for, not its id. */
const BRIDGED: Record<string, P.Network> = { discord: 'discord', telegram: 'telegram', signal: 'signal', whatsapp: 'whatsapp', instagram: 'messenger', facebook: 'messenger', twitter: 'x' };
function idLabel(i: P.MatchSide['identities'][number]): string {
  const b = i.network === 'matrix' ? /^@([a-z]+)_[^:]+:(.+)$/.exec(i.handle ?? '') : null;
  if (b && BRIDGED[b[1]]) return `${netName(BRIDGED[b[1]])}, through a bridge`;
  return i.handle && i.network !== 'email' ? i.handle : (i.name ?? netName(i.network));
}

/** Merge sides into one person; reports and returns whether it worked. */
async function mergeSides(sides: string[], names: string[]): Promise<boolean> {
  try {
    await api('/api/matches/merge', { body: { sides } });
    toast({ kind: 'info', title: 'Merged', body: `${names.join(' and ')} are one person now. Split them again from their profile.` }, 4000);
    return true;
  } catch (e) {
    toast({ kind: 'error', title: 'Could not merge', body: (e as Error).message });
    return false;
  }
}

/** Not the same, or Later, with Undo on the toast. */
/** `after`: the pair is out of the list; `undone`: Undo put it back. */
async function decide(s: P.MatchSuggestion, decision: P.MatchDecision, after: () => void, undone: () => void) {
  try {
    await api('/api/matches/decide', { body: { key: s.key, decision } });
  } catch (e) {
    toast({ kind: 'error', title: 'Could not save that', body: (e as Error).message });
    return;
  }
  after();
  toast(
    {
      kind: 'info',
      title: decision === 'no' ? 'Not the same' : 'Later',
      body: decision === 'no' ? `${s.a.name} and ${s.b.name} won't be suggested again.` : `Back in a month.`,
      actionLabel: 'Undo',
      action: () => void api('/api/matches/decide', { body: { key: s.key, undo: true } }).then(undone, (e) => toast({ kind: 'error', title: 'Could not undo that', body: (e as Error).message })),
    },
    6000,
  );
}

export default function SamePerson({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<P.MatchesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hashing, setHashing] = useState<number | null>(null);
  const [review, setReview] = useState(false);
  const [faintOpen, setFaintOpen] = useState(false);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = (refresh = false) => {
    if (timer.current) clearTimeout(timer.current);
    (refresh ? api<P.MatchesView>('/api/matches/refresh', { method: 'POST' }) : api<P.MatchesView>('/api/matches'))
      .then((v) => {
        if (!alive.current) return;
        setError(null);
        setView(v);
        setHidden(new Set());
        // While a run is going, look again shortly.
        if (v.running) timer.current = setTimeout(() => load(), 2000);
      })
      .catch((e) => alive.current && setError((e as Error).message));
  };
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  // Pictures the hub wants hashed: done here, a batch at a time, while the page is open.
  useEffect(() => {
    if (!view?.picturesWaiting || hashing !== null) return;
    setHashing(0);
    void hashPictures(
      () => alive.current,
      (n) => alive.current && setHashing(n),
    )
      .catch(() => {})
      .finally(() => {
        if (!alive.current) return;
        setHashing(null);
        load();
      });
  }, [view?.picturesWaiting]);

  const drop = (keys: string[]) => setHidden((h) => new Set([...h, ...keys]));
  const undrop = (keys: string[]) => {
    setHidden((h) => new Set([...h].filter((k) => !keys.includes(k))));
    load();
  };
  const all = (view?.suggestions ?? []).filter((s) => !hidden.has(s.key));
  const needle = q.trim().toLowerCase();
  const hit = (s: P.MatchSuggestion) => !needle || [s.a, s.b].some((x) => x.name.toLowerCase().includes(needle) || x.identities.some((i) => (i.handle ?? '').toLowerCase().includes(needle)));
  const matching = all.filter(hit);
  const strong = all.filter((s) => s.p >= MATCH_STRONG);
  const faint = (view?.faint ?? []).filter((s) => !hidden.has(s.key) && hit(s));
  const groups = (view?.groups ?? []).filter((g) => g.keys.every((k) => !hidden.has(k)));
  const inGroup = new Set(groups.flatMap((g) => g.keys));
  const shown = filter === 'strong' ? matching.filter((s) => s.p >= MATCH_STRONG) : filter === 'groups' ? [] : matching.filter((s) => !inGroup.has(s.key) || filter === 'all');
  const byKey = useMemo(() => new Map(all.map((s) => [s.key, s])), [view, hidden]);

  return (
    <section class="pane sp-pane" aria-label="Same person?">
      <header class="board-head dir-head sp-head">
        <button class="icon-btn dir-back" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
        <div>
          <h2>Same person?</h2>
          <p>People who may be one person with accounts on several networks</p>
        </div>
        <span class="pg-head-tools">
          <button class="icon-btn small" title="Work it out again" aria-label="Work it out again" onClick={() => load(true)}>
            <Icon name="refresh" size={16} />
          </button>
          <button class="icon-btn small" title="The people graph" aria-label="The people graph" onClick={() => go({ view: 'people', graph: true })}>
            <Icon name="graph" size={16} />
          </button>
        </span>
      </header>
      {error ? (
        <Empty icon="alert" title="Could not load suggestions">
          {error}
        </Empty>
      ) : !view ? (
        <Loading fill label="Loading…" />
      ) : (
        <div class="sp-body">
          <Status view={view} hashing={hashing} />
          <div class="dir-controls sp-controls">
            <div class="search dir-search sp-find">
              <Icon name="search" size={15} />
              <input placeholder="Find by name or handle" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Find by name or handle" />
            </div>
            <div class="level-picker" role="group" aria-label="Show">
              {(
                [
                  ['all', `All ${all.length}`],
                  ['strong', `Over ${pct(MATCH_STRONG)} ${strong.length}`],
                  ['groups', `Groups ${groups.length}`],
                ] as const
              ).map(([k, label]) => (
                <button class={`chip-btn ${filter === k ? 'on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                  {label}
                </button>
              ))}
            </div>
            {strong.length > 1 && (
              <button class="btn small" onClick={() => setReview(true)}>
                <Icon name="merge" size={14} /> Merge all over {pct(MATCH_STRONG)}…
              </button>
            )}
          </div>
          {!all.length && !view.running ? (
            <Empty icon="users" title="Nobody to merge">
              {view.at ? 'No pairs look like one person right now.' : 'Working it out…'} More turn up as profiles are opened{view.profiles.collecting ? ' and collected' : ''}, and as pictures are compared.
            </Empty>
          ) : (
            <div class="sp-list">
              {(filter === 'groups' || filter === 'all') &&
                groups
                  .filter((g) => !needle || g.keys.some((k) => matching.some((m) => m.key === k)))
                  .map((g) => <GroupCard group={g} pairs={g.keys.map((k) => byKey.get(k)).filter((x): x is P.MatchSuggestion => !!x)} onDone={drop} onUndo={undrop} />)}
              <Banded pairs={shown.filter((s) => filter !== 'all' || !inGroup.has(s.key))} card={(s) => <PairCard s={s} onDone={() => drop([s.key])} onUndo={() => undrop([s.key])} />} />
              {filter === 'all' && faint.length > 0 && (
                <>
                  {faintOpen && <Banded pairs={faint} card={(s) => <PairCard s={s} onDone={() => drop([s.key])} onUndo={() => undrop([s.key])} />} />}
                  <button class="btn small ghost sp-faint" onClick={() => setFaintOpen(!faintOpen)} aria-expanded={faintOpen}>
                    {faintOpen ? 'Hide the fainter pairs' : `${faint.length} fainter ${faint.length === 1 ? 'pair' : 'pairs'}, ${pct(MATCH_FAINT)} to ${pct(MATCH_SHOWN)}`}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {review && view && (
        <Review
          pairs={strong}
          onClose={() => setReview(false)}
          onMerged={(keys) => {
            drop(keys);
            setReview(false);
            load();
          }}
        />
      )}
    </section>
  );
}

function Status({ view, hashing }: { view: P.MatchesView; hashing: number | null }) {
  const ago = view.at ? Math.max(0, Math.round((Date.now() - view.at) / 60_000)) : null;
  return (
    <div class="sp-status" aria-live="polite">
      <span>
        {view.running ? 'Working it out…' : ago === null ? 'Not worked out yet' : `Worked out ${ago < 1 ? 'just now' : `${ago} min ago`}`}
        {' · '}
        {view.profiles.kept.toLocaleString()} profiles kept
        {' · '}
        {view.learned.fitted ? `weighted by your ${view.learned.yes + view.learned.no} decisions` : `learns once you have merged and turned down a few (${view.learned.yes} merged, ${view.learned.no} turned down)`}
      </span>
      {hashing !== null && <span> · comparing pictures, {hashing.toLocaleString()} done</span>}
      {!view.profiles.collecting && (
        <span class="sp-note">
          Only profiles someone opened are compared. <button class="link-btn" onClick={openAdversarial}>Collect profiles</button> to find more.
        </span>
      )}
    </div>
  );
}

function SideView({ side }: { side: P.MatchSide }) {
  const open = () => go(side.id.startsWith('per_') ? { view: 'profile', person: side.id } : { view: 'profile', identity: side.id });
  return (
    <button class="sp-side" onClick={open} title="Open their profile">
      <Avatar id={side.id} name={side.name} url={side.avatar} size={40} network={side.identities.length === 1 ? side.identities[0].network : undefined} />
      <span class="sp-side-text">
        <b>{side.name}</b>
        <span class="sp-ids">
          {side.identities.slice(0, 3).map((i) => (
            <span class="sp-id">
              <NetBadge network={i.network} size={12} />
              <span title={i.handle ?? undefined}>{idLabel(i)}</span>
            </span>
          ))}
          {side.identities.length > 3 && <span class="sp-id">+{side.identities.length - 3}</span>}
        </span>
        {side.direct && <small>You have a direct chat</small>}
      </span>
    </button>
  );
}

/** How much a piece of evidence counts, in three steps, for the meter beside it. */
const STEPS = ['a little', 'some', 'a lot'];
const stepOf = (w: number) => (Math.abs(w) >= 4.5 ? 2 : Math.abs(w) >= 2.5 ? 1 : 0);

function Evidence({ e }: { e: P.MatchEvidence }) {
  const k = KIND[e.kind];
  const n = stepOf(e.weight);
  return (
    <li class={`sp-ev ${e.weight < 0 ? 'against' : e.weight >= 4 ? 'strong' : ''}`}>
      <Icon name={k.icon} size={13} />
      <span>{e.text}</span>
      <span class="sp-ev-w" title={`${k.label}: counts ${e.weight < 0 ? 'against, ' : 'for '}${STEPS[n]}`} aria-label={`counts ${e.weight < 0 ? 'against' : 'for'} ${STEPS[n]}`}>
        {[0, 1, 2].map((i) => (
          <i class={i <= n ? 'on' : ''} />
        ))}
      </span>
    </li>
  );
}

function Odds({ p }: { p: number }) {
  return (
    <span class={`sp-odds ${p >= MATCH_STRONG ? 'strong' : p >= 0.6 ? 'mid' : 'weak'}`} style={{ '--p': String(p) }} title={`${pct(p)} likely one person`}>
      {pct(p)}
    </span>
  );
}

function PairCard({ s, onDone, onUndo }: { s: P.MatchSuggestion; onDone: () => void; onUndo: () => void }) {
  const [busy, setBusy] = useState(false);
  const merge = async () => {
    setBusy(true);
    if (await mergeSides([s.a.id, s.b.id], [s.a.name, s.b.name])) onDone();
    setBusy(false);
  };
  return (
    <article class="sp-card">
      <div class="sp-pair">
        <SideView side={s.a} />
        <Odds p={s.p} />
        <SideView side={s.b} />
      </div>
      <ul class="sp-evs">
        {s.evidence.map((e) => (
          <Evidence e={e} />
        ))}
      </ul>
      <div class="sp-actions">
        <button class="btn small" disabled={busy} onClick={merge}>
          <Icon name="merge" size={14} /> Merge
        </button>
        <button class="btn small ghost" disabled={busy} onClick={() => void decide(s, 'no', onDone, onUndo)}>
          Not the same
        </button>
        <button class="btn small ghost" disabled={busy} onClick={() => void decide(s, 'later', onDone, onUndo)}>
          Later
        </button>
      </div>
    </article>
  );
}

/** Three or more joined by pairs: merge them all, or look at each pair. */
function GroupCard({ group, pairs, onDone, onUndo }: { group: P.MatchGroup; pairs: P.MatchSuggestion[]; onDone: (keys: string[]) => void; onUndo: (keys: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const sides = group.sides.map((id) => pairs.flatMap((p) => [p.a, p.b]).find((x) => x.id === id)).filter((x): x is P.MatchSide => !!x);
  const merge = async () => {
    setBusy(true);
    if (await mergeSides(sides.map((x) => x.id), sides.map((x) => x.name))) onDone(group.keys);
    setBusy(false);
  };
  return (
    <article class="sp-card sp-group">
      <div class="sp-group-head">
        <b>{sides.length} accounts that may be one person</b>
        <Odds p={group.p} />
      </div>
      <div class="sp-group-sides">
        {sides.map((x) => (
          <SideView side={x} />
        ))}
      </div>
      <div class="sp-actions">
        <button class="btn small" disabled={busy} onClick={merge}>
          <Icon name="merge" size={14} /> Merge all {sides.length}
        </button>
        <button class="btn small ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide pairs' : `Each pair (${pairs.length})`}
        </button>
      </div>
      {open && (
        <div class="sp-group-pairs">
          {pairs.map((p) => (
            <PairCard s={p} onDone={() => onDone([p.key])} onUndo={() => onUndo([p.key])} />
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * Merge all over the strong mark, after a look down the list: each pair ticked, untick any that are wrong. Pairs that
 * share someone become one merge.
 */
function Review({ pairs, onClose, onMerged }: { pairs: P.MatchSuggestion[]; onClose: () => void; onMerged: (keys: string[]) => void }) {
  const [on, setOn] = useState<Set<string>>(() => new Set(pairs.map((p) => p.key)));
  const [busy, setBusy] = useState(false);
  const picked = pairs.filter((p) => on.has(p.key));
  const sets = components(picked);
  const go = async () => {
    setBusy(true);
    const done: string[] = [];
    for (const c of sets) {
      const names = c.sides.map((id) => picked.flatMap((p) => [p.a, p.b]).find((x) => x.id === id)?.name ?? 'someone');
      try {
        await api('/api/matches/merge', { body: { sides: c.sides } });
        done.push(...c.keys);
      } catch (e) {
        toast({ kind: 'error', title: `Could not merge ${names.join(', ')}`, body: (e as Error).message });
      }
    }
    setBusy(false);
    if (done.length) toast({ kind: 'info', title: `Merged ${sets.length === 1 ? 'one person' : `${sets.length} people`}`, body: 'Split any of them again from their profile.' }, 4000);
    onMerged(done);
  };
  return (
    <Modal title={`Merge ${picked.length} of ${pairs.length} over ${pct(MATCH_STRONG)}`} onClose={onClose} wide>
      <p class="set-help">Each is ticked. Untick any that are not one person; then merge. Pairs that share someone become one person together.</p>
      <div class="sp-review">
        {pairs.map((p) => (
          <label class="sp-review-row">
            <input
              type="checkbox"
              checked={on.has(p.key)}
              onChange={(e) => {
                const n = new Set(on);
                if ((e.target as HTMLInputElement).checked) n.add(p.key);
                else n.delete(p.key);
                setOn(n);
              }}
            />
            <span class="sp-review-names">
              <span class="sp-review-pair">
                <ReviewSide side={p.a} /> <span class="sp-review-and">and</span> <ReviewSide side={p.b} />
              </span>
              <small>{p.evidence.filter((e) => e.weight > 0)[0]?.text}</small>
            </span>
            <Odds p={p.p} />
          </label>
        ))}
      </div>
      <div class="btn-row">
        <button class="btn" disabled={busy || !picked.length} onClick={go}>
          <Icon name="merge" size={14} /> {busy ? 'Merging…' : `Merge ${picked.length}`}
        </button>
        <button class="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

/** A name with the networks it is on, so two of one name can be told apart. */
function ReviewSide({ side }: { side: P.MatchSide }) {
  return (
    <span class="sp-review-side">
      <b>{side.name}</b>
      {[...new Set(side.identities.map((i) => i.network))].slice(0, 4).map((n) => (
        <NetBadge network={n} size={12} />
      ))}
    </span>
  );
}
