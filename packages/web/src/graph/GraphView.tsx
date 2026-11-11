/**
 * The people graph (docs/people-graph.md): everyone and the servers and groups they are in, so you can see who shares
 * a place with whom, across networks and accounts. Opened from the People header; loaded only then (its own chunk).
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { signal, type Signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { convTitle, netName } from '../model.ts';
import { api, db, go, type Route } from '../state.ts';
import { Empty, NetBadge, openAdversarial } from '../ui/bits.tsx';
import { Icon } from '../ui/icons.tsx';
import { Engine } from './engine.ts';
import { DEFAULT_FILTERS, index, neighbours, sharesWith, visible, type Filters, type Index } from './model.ts';
import { Loading } from '../ui/Loader.tsx';

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

const placeName = (p: P.GraphPlace) => p.name ?? (p.kind === 'group' ? convTitle(db.conversations.get(p.id)) || 'Group' : 'Server');

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
        <Stage key={gen} graph={graph} />
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

function Stage({ graph }: { graph: P.PeopleGraph }) {
  const ix = useMemo(() => index(graph), [graph]);
  const [f, setF] = useState<Filters>(loadFilters);
  const vis = useMemo(() => visible(ix, f), [ix, f]);
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
  const name = (g: number) => (g < np ? graph.people[g].name : placeName(graph.places[g - np]));

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
        <Tip hover={hover} picked={picked} graph={graph} ix={ix} name={name} />
        {picked !== null && <Card graph={graph} ix={ix} node={picked} name={name} onPick={reveal} onClose={() => setPicked(null)} onFocus={(q) => set({ place: q })} focused={f.place} bots={f.bots} />}
      </div>
    </>
  );
}

type Hover = { node: number; x: number; y: number };

function Tip({ hover, picked, graph, ix, name }: { hover: Signal<Hover | null>; picked: number | null; graph: P.PeopleGraph; ix: Index; name: (g: number) => string }) {
  const h = hover.value;
  if (!h || h.node === picked) return null;
  return (
    <div class="pg-tip" style={{ left: `${h.x + 14}px`, top: `${h.y + 10}px` }}>
      <b>{name(h.node)}</b>
      <span>{describe(graph, ix, h.node)}</span>
    </div>
  );
}

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

function Card({ graph, ix, node, name, onPick, onClose, onFocus, focused, bots }: { graph: P.PeopleGraph; ix: Index; node: number; name: (g: number) => string; onPick: (g: number) => void; onClose: () => void; onFocus: (q: number | null) => void; focused: number | null; bots: boolean }) {
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
        <button class="pg-card-name" onClick={() => go(r.profile)} title="Open their page">
          {name(node)}
        </button>
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
      {isPerson && near.length > 0 && (
        <>
          <h4>In {near.length === 1 ? 'one place' : `${near.length} places`}</h4>
          <div class="pg-card-list">
            {near.slice(0, 12).map((g) => (
              <button class="pg-row" onClick={() => onPick(g)}>
                <NetBadge network={graph.places[g - np].network} size={13} />
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
