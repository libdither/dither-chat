/**
 * The people graph (docs/people-graph.md): everyone and the servers and groups they are in, so you can see who shares
 * a place with whom, across networks and accounts. Opened from the People header; loaded only then (its own chunk).
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { signal, type Signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { convTitle, netName } from '../model.ts';
import { phone } from '../phone.ts';
import { api, db, go, toast, type Route } from '../state.ts';
import { Avatar, Empty, NetBadge, openAdversarial } from '../ui/bits.tsx';
import { Icon } from '../ui/icons.tsx';
import { HeadOrb } from '../ui/Offline.tsx';
import { Engine } from './engine.ts';
import { importance, monthName, talkedWith, thisMonth, totals, type Importance } from './importance.ts';
import { DEFAULT_FILTERS, index, neighbours, sharesWith, visible, type Filters, type Index, type Visible } from './model.ts';
import { Loading } from '../ui/Loader.tsx';
import './graph.css';

const KEY = 'dither-chat:graph';
const CAPS = [2000, 6000, 20000];

function loadFilters(): Filters {
  try {
    const f = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { ...DEFAULT_FILTERS, ...f, account: null, place: null };
  } catch {
    return DEFAULT_FILTERS;
  }
}
function saveFilters(f: Filters) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ networks: f.networks, groups: f.groups, bots: f.bots, shared: f.shared, cap: f.cap }));
  } catch {}
}

const SAME_KEY = 'dither-chat:graph-same';
const loadSameOn = () => {
  try {
    return localStorage.getItem(SAME_KEY) === '1';
  } catch {
    return false;
  }
};
const saveSameOn = (on: boolean) => {
  try {
    localStorage.setItem(SAME_KEY, on ? '1' : '0');
  } catch {}
};

const isId = (name: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name);
/** A group's own name, else who is in it; a name that is only an id (a Signal group with none) counts as none. */
const placeName = (p: P.GraphPlace) => (p.name && !isId(p.name) ? p.name : null) ?? (p.kind === 'group' ? convTitle(db.conversations.get(p.id)) || 'Group' : 'Server');
/** A person's name; one that is only an id (someone on Signal with no profile name) as who they are. */
const personName = (p: P.GraphPerson) => (p.name && !isId(p.name) ? p.name : `${p.bot ? 'Bot' : 'Someone'} on ${netName(p.networks[0] ?? 'signal')}`);

const KEY_OPEN = 'dither-chat:graph-key';

export default function GraphView({ onBack }: { onBack: () => void }) {
  const [graph, setGraph] = useState<P.PeopleGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gen, setGen] = useState(0);
  const load = () => {
    setError(null);
    api<P.PeopleGraph>('/api/graph')
      .then((g) => {
        setGraph(g);
        setGen((n) => n + 1);
      })
      .catch((e) => setError((e as Error).message));
  };
  useEffect(load, []);
  return (
    <section class="pane pg-pane" aria-label="People graph">
      <header class="board-head dir-head pg-head">
        <button class="icon-btn dir-back" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
        <div>
          <h2>Who shares what</h2>
          <p>People and the servers and groups they are in, across your accounts</p>
        </div>
        <span class="pg-head-tools">
          <HeadOrb />
          <button class="icon-btn small" title="Load again" aria-label="Load again" onClick={load}>
            <Icon name="refresh" size={16} />
          </button>
          <button class="icon-btn small pg-close" title="Close" aria-label="Close" onClick={() => go({ view: 'people' })}>
            <Icon name="x" size={16} />
          </button>
        </span>
      </header>
      {error ? (
        <Empty icon="alert" title="Could not load the graph">
          {error}
        </Empty>
      ) : !graph ? (
        <Loading fill label="Loading…" />
      ) : !graph.links.length ? (
        <Sparse graph={graph} />
      ) : (
        <Stage key={gen} graph={graph} reload={load} />
      )}
    </section>
  );
}

/** Nothing to draw yet: what fills it in. */
function Sparse({ graph }: { graph: P.PeopleGraph }) {
  return (
    <div class="pg-empty">
      <Empty icon="users" title="No shared places yet">
        Group chats show who is in them as soon as an account syncs them. Servers fill in from the profiles you open
        {graph.members ? ', and from the members your accounts see.' : ', and from server members once “Record server members” is on.'}
      </Empty>
      {!graph.members && (
        <button class="btn small" onClick={openAdversarial}>
          Adversarial features
        </button>
      )}
    </div>
  );
}

function Stage({ graph, reload }: { graph: P.PeopleGraph; reload: () => void }) {
  const ix = useMemo(() => index(graph), [graph]);
  const [f, setF] = useState<Filters>(loadFilters);
  // How much you have talked with each person, by month: asked for after the graph, as it takes the hub a while.
  const [act, setAct] = useState<P.GraphActivity | null>(null);
  useEffect(() => {
    api<P.GraphActivity>('/api/graph/activity')
      .then((a) => setAct(a && typeof a.from === 'number' && a.people && a.mutual ? a : null))
      .catch(() => setAct(null));
  }, [graph]);
  const talked = useMemo(() => talkedWith(graph, act), [graph, act]);
  const vis = useMemo(() => visible(ix, f, talked), [ix, f, talked]);
  /** The month the graph is replayed at (the time bar); null for now. */
  const [asOf, setAsOf] = useState<number | null>(null);
  const imp = useMemo(() => importance(ix, act, asOf), [ix, act, asOf]);
  const [picked, setPicked] = useState<number | null>(null);
  // Hovering changes often: only the tip redraws for it.
  const hover = useMemo(() => signal<Hover | null>(null), []);
  const [kind, setKind] = useState<'webgl' | '2d' | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const glc = useRef<HTMLCanvasElement>(null);
  const txt = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const np = graph.people.length;
  const set = (p: Partial<Filters>) => {
    const next = { ...f, ...p };
    saveFilters(next);
    setF(next);
  };
  const nq = graph.places.length;
  const name = (g: number) => (g < np ? personName(graph.people[g]) : g < np + nq ? placeName(graph.places[g - np]) : 'You');

  useEffect(() => {
    const e = new Engine(host.current!, glc.current!, txt.current!, {
      hover: (node, x, y) => (hover.value = node === null ? null : { node, x, y }),
      pick: (node) => setPicked(node),
      open: (node) => open(graph, node),
      label: name,
    });
    engine.current = e;
    setKind(e.kind);
    // Colours follow the theme.
    const mo = new MutationObserver(() => e.theme());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'class'] });
    return () => {
      mo.disconnect();
      e.destroy();
      engine.current = null;
    };
  }, []);
  useEffect(() => engine.current?.setData(ix, vis), [ix, vis]);
  useEffect(() => engine.current?.setScores(imp.score), [imp, vis]);
  // Same person? suggestions as dashed links (docs/same-person.md), when asked for.
  const [sameOn, setSameOn] = useState(loadSameOn);
  const [same, setSame] = useState<P.MatchSuggestion[]>([]);
  useEffect(() => {
    saveSameOn(sameOn);
    if (!sameOn) return setSame([]);
    api<P.MatchesView>('/api/matches')
      .then((v) => setSame(v.suggestions))
      .catch(() => setSame([]));
  }, [sameOn]);
  const byId = useMemo(() => new Map(graph.people.map((p, i) => [p.id, i])), [graph]);
  const sameLinks = useMemo(
    () => same.map((s) => ({ s, a: byId.get(s.a.id), b: byId.get(s.b.id) })).filter((x): x is { s: P.MatchSuggestion; a: number; b: number } => x.a !== undefined && x.b !== undefined),
    [same, byId],
  );
  useEffect(() => engine.current?.setSame(sameLinks.map((x) => ({ a: x.a, b: x.b, p: x.s.p }))), [sameLinks]);
  const shownSame = sameLinks.filter((x) => vis.nodes.includes(x.a) && vis.nodes.includes(x.b)).length;
  useEffect(() => engine.current?.select(picked), [picked]);

  /** Show a node, widening the filters if it is not shown. */
  const reveal = (g: number) => {
    if (!vis.nodes.includes(g)) {
      // A place shows with its people; a person with the first place they are in.
      const home = g >= np ? g : neighbours(ix, g)[0];
      set({ networks: [], account: null, bots: f.bots || (g < np && !!graph.people[g].bot), shared: false, groups: true, place: home === undefined ? null : home - np });
    }
    setPicked(g);
    requestAnimationFrame(() => requestAnimationFrame(() => engine.current?.center(g)));
  };

  const networks = [...new Set([...graph.places.map((p) => p.network), ...graph.people.flatMap((p) => p.networks)])];
  const accounts = graph.accounts.map((id, i) => ({ i, a: db.accounts.get(id) })).filter((x) => x.a && graph.places.some((p) => p.accounts.includes(x.i)));
  const places = useMemo(
    () => graph.places.map((p, q) => ({ q, p, label: placeName(p) })).filter((x) => f.groups || x.p.kind !== 'group').sort((a, b) => a.label.localeCompare(b.label)),
    [graph, f.groups],
  );
  const capped = vis.shown.people < vis.matching.people || vis.shown.places < vis.matching.places;
  const showing = `${vis.shown.people.toLocaleString()} of ${graph.people.length.toLocaleString()} people · ${vis.shown.places.toLocaleString()} of ${graph.places.length.toLocaleString()} places · ${(vis.edges.length / 2).toLocaleString()} links`;

  return (
    <>
      <div class="dir-controls pg-controls">
        <Finder graph={graph} name={name} onPick={reveal} />
        <div class="level-picker" role="group" aria-label="Network">
          {networks.map((n) => {
            const on = f.networks.includes(n);
            return (
              <button class={`chip-btn ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => set({ networks: on ? f.networks.filter((x) => x !== n) : [...f.networks, n] })}>
                <NetBadge network={n} size={14} /> {netName(n)}
              </button>
            );
          })}
        </div>
        <select class="input pg-select" aria-label="Account" value={f.account ?? ''} onChange={(e) => set({ account: (e.target as HTMLSelectElement).value === '' ? null : Number((e.target as HTMLSelectElement).value) })}>
          <option value="">Every account</option>
          {accounts.map(({ i, a }) => (
            <option value={i}>
              {NETWORK_META[a!.network].name} · {a!.label}
            </option>
          ))}
        </select>
        <select class="input pg-select" aria-label="Server or group" value={f.place ?? ''} onChange={(e) => set({ place: (e.target as HTMLSelectElement).value === '' ? null : Number((e.target as HTMLSelectElement).value) })}>
          <option value="">Every server and group</option>
          {places.map(({ q, p, label }) => (
            <option value={q}>
              {label} ({NETWORK_META[p.network].name}
              {p.kind === 'group' ? ' group' : ''})
            </option>
          ))}
        </select>
        <div class="level-picker" role="group" aria-label="Show">
          <button class={`chip-btn ${f.groups ? 'on' : ''}`} aria-pressed={f.groups} onClick={() => set({ groups: !f.groups })}>
            Groups
          </button>
          <button class={`chip-btn ${f.shared ? 'on' : ''}`} aria-pressed={f.shared} title="Only people in two places or more" onClick={() => set({ shared: !f.shared })}>
            In 2+ places
          </button>
          <button class={`chip-btn ${f.bots ? 'on' : ''}`} aria-pressed={f.bots} onClick={() => set({ bots: !f.bots })}>
            Bots
          </button>
          <button class={`chip-btn ${sameOn ? 'on' : ''}`} aria-pressed={sameOn} title="People who may be one person on several accounts, as dashed links" onClick={() => setSameOn(!sameOn)}>
            <Icon name="merge" size={13} /> Same person?
          </button>
          <select class="input pg-select pg-cap" aria-label="At most" value={f.cap} onChange={(e) => set({ cap: Number((e.target as HTMLSelectElement).value) })}>
            {CAPS.map((c) => (
              <option value={c}>Up to {c.toLocaleString()}</option>
            ))}
          </select>
        </div>
      </div>
      <div class="pg-stage">
        <div class="pg-canvas" ref={host} tabIndex={0} aria-label="Graph: drag to move, scroll or pinch to zoom, click a node for who or what it is, double-click to open it">
          <canvas ref={glc} class="pg-gl" />
          <canvas ref={txt} class="pg-text" />
        </div>
        <div class="pg-status" aria-live="polite">
          <span class="pg-showing">{capped ? `Showing ${showing}, the busiest` : `Showing ${showing}`}</span>
          {kind === '2d' && <span> · simple drawing (no WebGL)</span>}
          {sameOn && (
            <span>
              {' '}
              · {shownSame.toLocaleString()} possible same-person {shownSame === 1 ? 'link' : 'links'} dashed
              {same.length > shownSame && (
                <>
                  {` (${(same.length - shownSame).toLocaleString()} more off the graph: `}
                  <button class="link-btn" onClick={() => go({ view: 'people', same: true })}>
                    see all
                  </button>
                  )
                </>
              )}
            </span>
          )}
        </div>
        {!graph.members && (
          <div class="pg-note">
            Servers show only who profiles and channels named. <button class="link-btn" onClick={openAdversarial}>Record server members</button> to see more.
          </div>
        )}
        <div class="pg-zoom">
          <button class="icon-btn small" aria-label="Zoom in" title="Zoom in" onClick={() => engine.current?.zoom(1.4)}>
            <Icon name="plus" size={16} />
          </button>
          <button class="icon-btn small" aria-label="Zoom out" title="Zoom out" onClick={() => engine.current?.zoom(1 / 1.4)}>
            <span class="pg-minus">−</span>
          </button>
          <button class="icon-btn small" aria-label="Fit" title="Fit everything" onClick={() => engine.current?.refit()}>
            <Icon name="grid" size={15} />
          </button>
        </div>
        <Key graph={graph} vis={vis} me={vis.me >= 0} />
        <Tip hover={hover} picked={picked} graph={graph} ix={ix} name={name} />
        {picked !== null && (
          <Card
            graph={graph}
            ix={ix}
            node={picked}
            name={name}
            onPick={reveal}
            onClose={() => setPicked(null)}
            onFocus={(q) => set({ place: q })}
            focused={f.place}
            bots={f.bots}
            same={same
              .filter((x) => x.a.id === graph.people[picked]?.id || x.b.id === graph.people[picked]?.id)
              .map((x) => {
                const side = x.a.id === graph.people[picked]?.id ? x.b : x.a;
                return { s: x, side, at: byId.get(side.id) };
              })}
            onSameDone={(key, merged) => (merged ? reload() : setSame(same.filter((x) => x.key !== key)))}
            act={act}
            imp={imp}
          />
        )}
      </div>
      {act && act.to > act.from && <TimeBar act={act} asOf={asOf} setAsOf={setAsOf} />}
    </>
  );
}

/** What the colours, sizes and shapes mean, with how many of each are shown. Folds away. */
function Key({ graph, vis, me }: { graph: P.PeopleGraph; vis: Visible; me: boolean }) {
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(KEY_OPEN);
      return v === null ? !phone.value : v === '1';
    } catch {
      return !phone.value;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(KEY_OPEN, open ? '0' : '1');
    } catch {}
  };
  const np = graph.people.length;
  const { nets, known, multi } = useMemo(() => {
    const nets = new Map<P.Network, number>();
    let known = 0;
    let multi = 0;
    for (const g of vis.nodes) {
      if (g >= np) continue;
      const p = graph.people[g];
      for (const n of p.networks) nets.set(n, (nets.get(n) ?? 0) + 1);
      if (p.dm.length) known++;
      if (p.networks.length > 1) multi++;
    }
    return { nets: [...nets].sort((a, b) => b[1] - a[1]), known, multi };
  }, [graph, vis]);
  if (!open)
    return (
      <button class="pg-key pg-key-closed" onClick={toggle} title="What the colours and shapes mean">
        Key
      </button>
    );
  return (
    <div class="pg-key" role="group" aria-label="Key">
      <div class="pg-key-head">
        <b>Key</b>
        <button class="icon-btn small" aria-label="Fold the key" onClick={toggle}>
          <Icon name="x" size={12} />
        </button>
      </div>
      <div class="pg-key-nets">
        {nets.map(([n, c]) => (
          <span class="pg-key-net" style={{ '--net': NETWORK_META[n].color } as Record<string, string>}>
            <i />
            {netName(n)} <em>{c.toLocaleString()}</em>
          </span>
        ))}
      </div>
      <div class="pg-key-row">
        <i class="pg-key-dot big" /> Bigger the more they matter to you: talk, places and friends you share
      </div>
      <div class="pg-key-row">
        <i class="pg-key-dot" /> Only seen in a server or group <em>{(vis.shown.people - known).toLocaleString()}</em>
      </div>
      {me && (
        <div class="pg-key-row">
          <i class="pg-key-line" /> You, in the middle, linked to who you talk with; nearer and brighter the more you do
        </div>
      )}
      <div class="pg-key-row">
        <i class="pg-key-line net" /> Links in the colour of the place's network
      </div>
      {multi > 0 && (
        <div class="pg-key-row">
          <i class="pg-key-dot two" /> On two networks or more <em>{multi.toLocaleString()}</em>
        </div>
      )}
      <div class="pg-key-row">
        <i class="pg-key-shape square" /> Server <i class="pg-key-shape diamond" /> Group, bigger the more people
      </div>
    </div>
  );
}

type Hover = { node: number; x: number; y: number };

function Tip({ hover, picked, graph, ix, name }: { hover: Signal<Hover | null>; picked: number | null; graph: P.PeopleGraph; ix: Index; name: (g: number) => string }) {
  const h = hover.value;
  if (!h || h.node === picked) return null;
  return (
    <div class="pg-tip" style={{ left: `${h.x + 14}px`, top: `${h.y + 10}px` }}>
      <Avatar id={h.node < graph.people.length ? graph.people[h.node].id : graph.places[h.node - graph.people.length].id} name={name(h.node)} url={pic(graph, h.node)} size={32} square={h.node >= graph.people.length} />
      <span class="pg-tip-text">
        <b>{name(h.node)}</b>
        <span>{describe(graph, ix, h.node)}</span>
      </span>
    </div>
  );
}

/** A node's picture: a person's, a server's icon, a group's. */
const pic = (graph: P.PeopleGraph, g: number) => (g < graph.people.length ? graph.people[g].pic : graph.places[g - graph.people.length].pic);

/** One line on what a node is. */
function describe(graph: P.PeopleGraph, ix: Index, g: number): string {
  const np = graph.people.length;
  const n = neighbours(ix, g).length;
  if (g < np) {
    const p = graph.people[g];
    return `${p.bot ? 'Bot' : 'Person'} · ${p.networks.map(netName).join(', ')} · in ${n} ${n === 1 ? 'place' : 'places'}`;
  }
  const pl = graph.places[g - np];
  const noun = pl.kind === 'group' ? 'Group' : NETWORK_META[pl.network].spaceNoun[0].toUpperCase() + NETWORK_META[pl.network].spaceNoun.slice(1);
  return `${noun} · ${netName(pl.network)} · ${n.toLocaleString()} ${n === 1 ? 'person' : 'people'} known${pl.total ? ` of ${pl.total.toLocaleString()}` : ''}`;
}

function routeOf(graph: P.PeopleGraph, g: number): { profile: Route; chats?: Route } {
  const np = graph.people.length;
  if (g < np) {
    const p = graph.people[g];
    return p.identity ? { profile: { view: 'profile', identity: p.id } } : { profile: { view: 'profile', person: p.id }, ...(p.dm.length ? { chats: { view: 'people', person: p.id } } : {}) };
  }
  const pl = graph.places[g - np];
  return pl.kind === 'group'
    ? { profile: { view: 'profile', conv: pl.id }, ...(db.conversations.has(pl.id) ? { chats: { view: 'inbox', conv: pl.id } } : {}) }
    : { profile: { view: 'profile', space: pl.id }, ...(db.spaces.has(pl.id) ? { chats: { view: 'space', space: pl.id } } : {}) };
}

function open(graph: P.PeopleGraph, g: number) {
  go(routeOf(graph, g).profile);
}

function Card({
  graph,
  ix,
  node,
  name,
  onPick,
  onClose,
  onFocus,
  focused,
  bots,
  same,
  onSameDone,
  act,
  imp,
}: {
  graph: P.PeopleGraph;
  ix: Index;
  node: number;
  name: (g: number) => string;
  onPick: (g: number) => void;
  onClose: () => void;
  onFocus: (q: number | null) => void;
  focused: number | null;
  bots: boolean;
  /** Suggestions with this person in them: the other side, and its node when it is on the graph. */
  same: { s: P.MatchSuggestion; side: P.MatchSide; at: number | undefined }[];
  onSameDone: (key: string, merged: boolean) => void;
  act: P.GraphActivity | null;
  imp: Importance;
}) {
  const np = graph.people.length;
  const isPerson = node < np;
  const r = routeOf(graph, node);
  const near = neighbours(ix, node);
  const accountName = (i: number) => {
    const a = db.accounts.get(graph.accounts[i]);
    return a ? `${NETWORK_META[a.network].name} · ${a.label}` : 'an account';
  };
  const accts = isPerson ? graph.people[node].dm : graph.places[node - np].accounts;
  // The others most alike: people sharing places with this person, or places sharing people with this one.
  const alike = useMemo(() => {
    if (isPerson)
      return sharesWith(ix, node, 40)
        .filter((s) => bots || !graph.people[s.person].bot)
        .slice(0, 12)
        .map((s) => ({ g: s.person, n: s.shared, other: s.otherAccount }));
    const count = new Map<number, number>();
    for (const p of near) for (const q of neighbours(ix, p)) if (q !== node) count.set(q, (count.get(q) ?? 0) + 1);
    return [...count]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([g, n]) => ({ g, n, other: false }));
  }, [ix, node, bots]);
  const placeIx = node - np;
  return (
    <aside class="pg-card" aria-label={name(node)}>
      <div class="pg-card-head">
        <span class="pg-card-pic">
          <Avatar id={isPerson ? graph.people[node].id : graph.places[placeIx].id} name={name(node)} url={pic(graph, node)} size={44} square={!isPerson} />
        </span>
        <span class="pg-card-title">
          <button class="pg-card-name" onClick={() => go(r.profile)} title="Open their page">
            {name(node)}
          </button>
          <span class="pg-card-nets">
            {(isPerson ? graph.people[node].networks : [graph.places[placeIx].network]).map((n) => (
              <NetBadge network={n} size={15} />
            ))}
          </span>
        </span>
        <button class="icon-btn small" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div class="pg-card-sub">{describe(graph, ix, node)}</div>
      {accts.length > 0 && (
        <div class="pg-card-sub">
          {isPerson ? 'Direct chats on ' : 'Seen by '}
          {accts.map(accountName).join(', ')}
        </div>
      )}
      {isPerson && <Talk act={act} imp={imp} node={node} id={graph.people[node].id} />}
      <div class="pg-card-actions">
        <button class="btn small" onClick={() => go(r.profile)}>
          {isPerson ? 'Profile' : 'About'}
        </button>
        {r.chats && (
          <button class="btn small ghost" onClick={() => go(r.chats!)}>
            {isPerson ? 'Chats' : 'Open'}
          </button>
        )}
        {!isPerson && (
          <button class="btn small ghost" onClick={() => onFocus(focused === placeIx ? null : placeIx)}>
            {focused === placeIx ? 'Show all' : 'Only this'}
          </button>
        )}
      </div>
      {isPerson && same.length > 0 && (
        <>
          <h4>Maybe the same person as</h4>
          <div class="pg-card-list">
            {same.map(({ s, side, at }) => {
              return (
                <div class="pg-same">
                  <button
                    class="pg-row"
                    onClick={() => (at !== undefined ? onPick(at) : go(side.id.startsWith('per_') ? { view: 'profile', person: side.id } : { view: 'profile', identity: side.id }))}
                    title={s.evidence.map((e) => e.text).join('\n')}
                  >
                    {side.identities[0] && <NetBadge network={side.identities[0].network} size={13} />}
                    <span class="pg-row-name">{side.name}</span>
                    <span class="pg-n">{Math.round(s.p * 100)}%</span>
                  </button>
                  <span class="pg-same-actions">
                    <button
                      class="btn small"
                      onClick={() =>
                        void api('/api/matches/merge', { body: { sides: [s.a.id, s.b.id] } })
                          .then(() => onSameDone(s.key, true))
                          .catch((e) => toast({ kind: 'error', title: 'Could not merge', body: (e as Error).message }))
                      }
                    >
                      Merge
                    </button>
                    <button class="btn small ghost" onClick={() => void api('/api/matches/decide', { body: { key: s.key, decision: 'no' } }).then(() => onSameDone(s.key, false))}>
                      Not the same
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
      {isPerson && near.length > 0 && (
        <>
          <h4>In {near.length === 1 ? 'one place' : `${near.length} places`}</h4>
          <div class="pg-card-list">
            {near.slice(0, 12).map((g) => (
              <button class="pg-row" onClick={() => onPick(g)}>
                <Avatar id={graph.places[g - np].id} name={name(g)} url={pic(graph, g)} size={20} square network={graph.places[g - np].network} />
                <span class="pg-row-name">{name(g)}</span>
              </button>
            ))}
            {near.length > 12 && <span class="pg-more">and {near.length - 12} more</span>}
          </div>
        </>
      )}
      {alike.length > 0 && (
        <>
          <h4>{isPerson ? 'Shares places with' : 'Shares people with'}</h4>
          <div class="pg-card-list">
            {alike.map((s) => (
              <button class="pg-row" onClick={() => onPick(s.g)}>
                <Avatar id={s.g < np ? graph.people[s.g].id : graph.places[s.g - np].id} name={name(s.g)} url={pic(graph, s.g)} size={20} square={s.g >= np} />
                <span class="pg-row-name">{name(s.g)}</span>
                {s.other && (
                  <span class="pg-tag" title="You have direct chats with each of them, on different accounts">
                    other account
                  </span>
                )}
                <span class="pg-n">{s.n}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

/** Find someone or somewhere by name. */
function Finder({ graph, name, onPick }: { graph: P.PeopleGraph; name: (g: number) => string; onPick: (g: number) => void }) {
  const [q, setQ] = useState('');
  const np = graph.people.length;
  const total = np + graph.places.length;
  const needle = q.trim().toLowerCase();
  const hits = useMemo(() => {
    if (!needle) return [];
    const out: number[] = [];
    for (let g = 0; g < total && out.length < 8; g++) if (name(g).toLowerCase().includes(needle)) out.push(g);
    return out;
  }, [needle, graph]);
  const pick = (g: number) => {
    setQ('');
    onPick(g);
  };
  return (
    <div class="search dir-search pg-find">
      <Icon name="search" size={15} />
      <input placeholder="Find a person, server or group" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && hits.length && pick(hits[0])} aria-label="Find in the graph" />
      {hits.length > 0 && (
        <div class="pg-hits" role="listbox">
          {hits.map((g) => (
            <button role="option" class="pg-row" onClick={() => pick(g)}>
              <NetBadge network={g < np ? graph.people[g].networks[0] : graph.places[g - np].network} size={13} />
              <span class="pg-row-name">{name(g)}</span>
              <span class="pg-n">{g < np ? 'person' : graph.places[g - np].kind === 'group' ? 'group' : 'server'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** How much you have talked with someone, and when: a bar a year, the past year's count, and friends you share. */
function Talk({ act, imp, node, id }: { act: P.GraphActivity | null; imp: Importance; node: number; id: string }) {
  const flat = act?.people[id];
  const friends = imp.friends[node];
  const years = useMemo(() => {
    if (!act || !flat) return null;
    const y0 = Math.floor(act.from / 12);
    const out = new Float32Array(Math.floor(act.to / 12) - y0 + 1);
    for (let k = 0; k < flat.length; k += 2) out[Math.floor(flat[k] / 12) - y0] += flat[k + 1] / 10;
    return { y0, out };
  }, [act, flat]);
  if (!flat && !friends) return null;
  const now = thisMonth();
  let total = 0;
  let year = 0;
  for (let k = 0; flat && k < flat.length; k += 2) {
    total += flat[k + 1] / 10;
    if (flat[k] > now - 12) year += flat[k + 1] / 10;
  }
  const n = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v).toLocaleString());
  const max = years ? Math.max(...years.out, 1) : 1;
  return (
    <div class="pg-talk">
      {flat && (
        <div class="pg-card-sub">
          About {n(total)} messages between you{year >= 1 ? `, ${n(year)} in the past year` : ', none in the past year'}
        </div>
      )}
      {years && years.out.length > 1 && (
        <div class="pg-talk-years" aria-hidden="true">
          {[...years.out].map((v, i) => (
            <span title={`${years.y0 + i}: about ${n(v)}`}>
              <i style={{ height: `${v > 0 ? Math.max(8, (100 * Math.sqrt(v)) / Math.sqrt(max)) : 0}%` }} />
            </span>
          ))}
          <em>{years.y0}</em>
          <em>{years.y0 + years.out.length - 1}</em>
        </div>
      )}
      {friends > 0 && (
        <div class="pg-card-sub">
          {friends.toLocaleString()} {friends === 1 ? 'friend' : 'friends'} in common
        </div>
      )}
    </div>
  );
}

/**
 * Replay the graph at a month in the past: who you talked with then is big and near, fading from then. Over all the
 * talk there is, month by month, with a play button that runs through it.
 */
function TimeBar({ act, asOf, setAsOf }: { act: P.GraphActivity; asOf: number | null; setAsOf: (m: number | null) => void }) {
  const sums = useMemo(() => totals(act), [act]);
  const [playing, setPlaying] = useState(false);
  const at = asOf ?? act.to;
  useEffect(() => {
    if (!playing) return;
    let m = asOf === null || asOf >= act.to ? act.from : asOf;
    const t = setInterval(() => {
      m += 1;
      if (m >= act.to) {
        setAsOf(null);
        setPlaying(false);
      } else setAsOf(m);
    }, 90);
    return () => clearInterval(t);
  }, [playing]);
  // The sparkline: square roots, so a quiet year still shows beside a busy one.
  const w = 1000;
  const h = 100;
  const max = Math.sqrt(Math.max(...sums, 1));
  const step = w / Math.max(sums.length - 1, 1);
  const path = `M0,${h} ` + [...sums].map((v, i) => `L${(i * step).toFixed(1)},${(h - (h * Math.sqrt(v)) / max).toFixed(1)}`).join(' ') + ` L${w},${h} Z`;
  const x = ((at - act.from) / Math.max(act.to - act.from, 1)) * w;
  const y0 = Math.ceil(act.from / 12);
  const ticks: number[] = [];
  for (let y = y0; y * 12 <= act.to; y++) ticks.push(y);
  const every = Math.ceil(ticks.length / 8);
  return (
    <div class="pg-time" role="group" aria-label="Over time">
      <button class="icon-btn small" aria-label={playing ? 'Pause' : 'Play through the years'} title={playing ? 'Pause' : 'Play through the years'} onClick={() => setPlaying(!playing)}>
        {playing ? <span class="pg-pause" /> : <span class="pg-play" />}
      </button>
      <div class="pg-time-track">
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
          <path d={path} class="pg-time-area" />
          <path d={`M0,${h} ` + [...sums].slice(0, at - act.from + 1).map((v, i) => `L${(i * step).toFixed(1)},${(h - (h * Math.sqrt(v)) / max).toFixed(1)}`).join(' ') + ` L${x.toFixed(1)},${h} Z`} class="pg-time-past" />
        </svg>
        <div class="pg-time-ticks" aria-hidden="true">
          {ticks
            .filter((_, i) => i % every === 0)
            .map((y) => (
              <span style={{ left: `${(((y * 12 - act.from) / Math.max(act.to - act.from, 1)) * 100).toFixed(2)}%` }}>{y}</span>
            ))}
        </div>
        <input
          type="range"
          min={act.from}
          max={act.to}
          step={1}
          value={at}
          aria-label="Month"
          aria-valuetext={asOf === null ? 'Now' : monthName(at)}
          onInput={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            setPlaying(false);
            setAsOf(v >= act.to ? null : v);
          }}
        />
      </div>
      <span class="pg-time-at">{asOf === null ? 'Now' : monthName(at)}</span>
      {asOf !== null && (
        <button class="btn small ghost" onClick={() => (setPlaying(false), setAsOf(null))}>
          Now
        </button>
      )}
    </div>
  );
}
