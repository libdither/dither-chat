/**
 * The people graph (docs/people-graph.md): everyone and the servers and groups they are in, so you can see who shares
 * a place with whom, across networks and accounts. Opened from the People header; loaded only then (its own chunk).
 */
import type * as P from '@dither-chat/protocol';
import { GRAPH_WEIGHT_KEYS, NETWORK_META } from '@dither-chat/protocol';
import { signal, type Signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { convTitle, netName } from '../model.ts';
import { phone } from '../phone.ts';
import { api, db, go, metaRev, toast, type Route } from '../state.ts';
import { Avatar, Empty, NetBadge, openAdversarial } from '../ui/bits.tsx';
import { Icon } from '../ui/icons.tsx';
import { HeadOrb } from '../ui/Offline.tsx';
import { components } from '../same/merge.ts';
import { Engine } from './engine.ts';
import { DEFAULT_TUNING, fit, importance, monthName, SIGNALS, talkedWith, thisMonth, tiesAt, totals, type Fit, type Importance } from './importance.ts';
import { circles, describe as circlesOf, slices, type Circle, type Ties } from './ties.ts';
import { DEFAULT_FILTERS, index, neighbours, otherAccounts, sharesWith, visible, type Filters, type Index, type Visible } from './model.ts';
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

const RINGS_KEY = 'dither-chat:graph-rings';
const loadRingsOn = () => {
  try {
    return localStorage.getItem(RINGS_KEY) !== '0';
  } catch {
    return true;
  }
};
const saveRingsOn = (on: boolean) => {
  try {
    localStorage.setItem(RINGS_KEY, on ? '1' : '0');
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
  /** `fresh`: start the drawing over; else keep it, and where everything is (after a merge). */
  const load = (fresh = true) => {
    setError(null);
    api<P.PeopleGraph>('/api/graph')
      .then((g) => {
        setGraph(g);
        if (fresh) setGen((n) => n + 1);
      })
      .catch((e) => setError((e as Error).message));
  };
  useEffect(() => load(), []);
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
          <button class="icon-btn small" title="Load again" aria-label="Load again" onClick={() => load()}>
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
        <Stage key={gen} graph={graph} reload={() => load(false)} />
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
  metaRev.value; // your accounts and groups' names; the graph itself comes with `graph`
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
  // Your tuning of importance (kept by the hub), and what it is while being tried in the panel.
  const [tuning, setTuning] = useState<P.GraphTuning>(DEFAULT_TUNING);
  const [saved, setSaved] = useState<P.GraphTuning | null>(null);
  useEffect(() => {
    api<P.GraphTuning | null>('/api/graph/tuning')
      .then((t) => {
        setSaved(t);
        if (t) setTuning(t);
      })
      .catch(() => {});
  }, []);
  const [tuneOpen, setTuneOpen] = useState(false);
  // Ties between people now (circles keep to them as the time bar moves), and at the month replayed.
  const tiesNow = useMemo(() => tiesAt(ix, act, null, tuning), [ix, act, tuning.fade, tuning.voice]);
  const tiesThen = useMemo(() => (asOf === null ? tiesNow : tiesAt(ix, act, asOf, tuning)), [tiesNow, asOf]);
  const impNow = useMemo(() => importance(ix, act, null, tuning, tiesNow), [ix, act, tuning, tiesNow]);
  const imp = useMemo(() => (asOf === null ? impNow : importance(ix, act, asOf, tuning, tiesThen)), [impNow, asOf, tiesThen]);
  // Circles among the people shown, and each one's slice of the rings.
  const [ringsOn, setRingsOn] = useState(loadRingsOn);
  // Worked out after the graph is first drawn (a tenth of a second on thousands of people), then the rings follow.
  const [circ, setCirc] = useState<{ of: Int32Array; list: Circle[]; at: Float32Array; half: Float32Array } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(
      () =>
        (timer = setTimeout(() => {
          const people = [...vis.nodes].filter((g) => g < graph.people.length);
          const of = circles(tiesNow, people);
          const list = circlesOf(ix, of, impNow.score, (p) => personName(graph.people[p]), (q) => placeName(graph.places[q]));
          const loose = people.filter((p) => of[p] < 0).length;
          setCirc({ of, list, ...slices(tiesNow, of, list, loose) });
        })),
    );
    return () => (cancelAnimationFrame(frame), clearTimeout(timer));
  }, [tiesNow, vis, impNow]);
  const [picked, setPicked] = useState<number | null>(null);
  /** A Same person? group picked (an index into groups), for its merge card. */
  const [pickedGroup, setPickedGroup] = useState<number | null>(null);
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
      pick: (node) => {
        setPickedGroup(null);
        setPicked(node);
      },
      open: (node) => open(graph, node),
      label: name,
      group: (gi) => {
        setPicked(null);
        setPickedGroup(gi);
      },
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
  useEffect(() => engine.current?.setScores(imp.score, imp.place), [imp, vis]);
  useEffect(() => {
    saveRingsOn(ringsOn);
    engine.current?.setRings(ringsOn && circ ? { of: circ.of, at: circ.at, half: circ.half, names: circ.list.map((c) => c.name), ties: tiesNow } : null);
  }, [ringsOn, circ, vis]);
  // A new graph (after a merge) numbers everyone afresh.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    setPicked(null);
    setPickedGroup(null);
  }, [graph]);
  // Same person? suggestions as dashed links (docs/same-person.md), when asked for.
  const [sameOn, setSameOn] = useState(loadSameOn);
  const [same, setSame] = useState<P.MatchSuggestion[]>([]);
  useEffect(() => {
    saveSameOn(sameOn);
    if (!sameOn) return setSame([]);
    // While the hub is still working them out, ask again a few times.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const ask = () =>
      api<P.MatchesView>('/api/matches')
        .then((v) => {
          setSame(v.suggestions);
          if (v.running && tries++ < 12) timer = setTimeout(ask, 5000);
        })
        .catch(() => setSame([]));
    void ask();
    return () => clearTimeout(timer);
  }, [sameOn, graph]);
  const byId = useMemo(() => new Map(graph.people.map((p, i) => [p.id, i])), [graph]);
  const sameLinks = useMemo(
    () => same.map((s) => ({ s, a: byId.get(s.a.id), b: byId.get(s.b.id) })).filter((x): x is { s: P.MatchSuggestion; a: number; b: number } => x.a !== undefined && x.b !== undefined),
    [same, byId],
  );
  // Suggestions joined by the people they share: one group each, to merge in full or in part.
  const groups = useMemo(() => {
    const byKey = new Map(same.map((s) => [s.key, s]));
    return components(same)
      .map((c) => {
        const pairs = c.keys.map((k) => byKey.get(k)!);
        const sides = c.sides.map((id) => pairs.flatMap((p) => [p.a, p.b]).find((x) => x.id === id)!);
        return { sides, pairs, p: Math.min(...pairs.map((x) => x.p)), members: c.sides.map((id) => byId.get(id)).filter((g): g is number => g !== undefined) };
      })
      .filter((g) => g.members.length > 0);
  }, [same, byId]);
  useEffect(() => engine.current?.setSame(sameLinks.map((x) => ({ a: x.a, b: x.b, p: x.s.p })), groups.map((g) => ({ members: g.members, n: g.sides.length, p: g.p }))), [sameLinks, groups, vis]);
  useEffect(() => setPickedGroup(null), [groups]);
  const shownSame = groups.filter((g) => g.members.some((m) => vis.nodes.includes(m))).length;
  useEffect(() => engine.current?.select(picked), [picked]);
  useEffect(() => engine.current?.selectGroup(pickedGroup), [pickedGroup]);
  const netOf = (a: number) => db.accounts.get(graph.accounts[a])?.network;

  /** Show a node, widening the filters if it is not shown. */
  const reveal = (g: number) => {
    if (!vis.nodes.includes(g)) {
      // A place shows with its people; a person with the first place they are in.
      const home = g >= np ? g : neighbours(ix, g)[0];
      set({ networks: [], account: null, bots: f.bots || (g < np && !!graph.people[g].bot), shared: false, groups: true, place: home === undefined ? null : home - np });
    }
    setPickedGroup(null);
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
          <button
            class={`chip-btn ${ringsOn ? 'on' : ''}`}
            aria-pressed={ringsOn}
            title="You in the middle, everyone nearer the more they matter to you; circles of people tied to each other, each in a slice"
            onClick={() => setRingsOn(!ringsOn)}
          >
            Rings
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
              · {shownSame.toLocaleString()} {shownSame === 1 ? 'group' : 'groups'} that may be one person, shaded: click one to merge
              {groups.length < components(same).length && (
                <>
                  {` (${(components(same).length - groups.length).toLocaleString()} more off the graph: `}
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
        <Key graph={graph} ix={ix} vis={vis} me={vis.me >= 0} same={sameOn && shownSame > 0} netOf={netOf} rings={ringsOn && vis.me >= 0 ? (circ?.list.length ?? 0) : null} onHow={() => (setPicked(null), setPickedGroup(null), setTuneOpen(true))} />
        <Tip hover={hover} picked={picked} graph={graph} ix={ix} name={name} />
        {tuneOpen && picked === null && pickedGroup === null && (
          <Tuning
            voice={!!act?.ties?.voice}
            tuning={tuning}
            saved={saved}
            onTry={setTuning}
            onSaved={(t) => {
              setSaved(t);
              setTuning(t ?? DEFAULT_TUNING);
            }}
            onClose={() => {
              setTuning(saved ?? DEFAULT_TUNING);
              setTuneOpen(false);
            }}
            fitNow={() => (act ? fit(ix, act, tuning) : null)}
          />
        )}
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
            tuning={tuning}
            circle={circ && picked < graph.people.length && circ.of[picked] >= 0 ? circ.list[circ.of[picked]] : null}
            ties={tiesThen}
            onHow={() => (setPicked(null), setTuneOpen(true))}
            netOf={netOf}
            group={(() => {
              const gi = groups.findIndex((g) => g.members.includes(picked));
              return gi >= 0 && groups[gi].sides.length > 2 ? { n: groups[gi].sides.length, open: () => (setPicked(null), setPickedGroup(gi)) } : null;
            })()}
          />
        )}
        {pickedGroup !== null && groups[pickedGroup] && (
          <SameCard
            group={groups[pickedGroup]}
            at={(id) => byId.get(id)}
            onPick={reveal}
            onClose={() => setPickedGroup(null)}
            onDone={(merged, keys) => {
              setPickedGroup(null);
              if (merged) reload();
              else setSame(same.filter((x) => !keys.includes(x.key)));
            }}
            onUndone={() => void api<P.MatchesView>('/api/matches').then((v) => setSame(v.suggestions), () => {})}
          />
        )}
      </div>
      {act && act.to > act.from && <TimeBar act={act} asOf={asOf} setAsOf={setAsOf} />}
    </>
  );
}

/** What the colours, sizes and shapes mean, with how many of each are shown. Folds away. */
function Key({
  graph,
  ix,
  vis,
  me,
  same,
  netOf,
  rings,
  onHow,
}: {
  graph: P.PeopleGraph;
  ix: Index;
  vis: Visible;
  me: boolean;
  same: boolean;
  netOf: (a: number) => P.Network | undefined;
  /** With rings on: how many circles; null with rings off. */
  rings: number | null;
  onHow: () => void;
}) {
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
  const { nets, known, multi, crossed } = useMemo(() => {
    const nets = new Map<P.Network, number>();
    let known = 0;
    let multi = 0;
    let crossed = 0;
    for (const g of vis.nodes) {
      if (g >= np) continue;
      const p = graph.people[g];
      for (const n of p.networks) nets.set(n, (nets.get(n) ?? 0) + 1);
      if (p.dm.length) known++;
      if (p.networks.length > 1) multi++;
      if (p.friend?.length && otherAccounts(ix, g, netOf).length) crossed++;
    }
    return { nets: [...nets].sort((a, b) => b[1] - a[1]), known, multi, crossed };
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
        <i class="pg-key-dot big" />
        <span>
          Bigger{rings !== null ? ' and nearer you' : ''} the more they matter to you: talk, places and friends you share, and ties to your people.{' '}
          <button class="link-btn" onClick={onHow}>
            How, and tune it
          </button>
        </span>
      </div>
      {rings !== null && (
        <div class="pg-key-row">
          <i class="pg-key-ring" /> Rings: the 10, 50, 250 nearest. Slices: circles of people tied to each other (replies, reactions, time in voice, friends, small places), named by the place they share <em>{rings.toLocaleString()}</em>
        </div>
      )}
      <div class="pg-key-row">
        <i class="pg-key-dot" /> Only seen in a server or group <em>{(vis.shown.people - known).toLocaleString()}</em>
      </div>
      {me && (
        <div class="pg-key-row">
          <i class="pg-key-line" /> You, in the middle, linked to who you talk with; brighter the more you do
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
        <i class="pg-key-shape square" /> Server <i class="pg-key-shape diamond" /> Group, bigger the more you are there and the more who matter to you are
      </div>
      {crossed > 0 && (
        <div class="pg-key-row">
          <i class="pg-key-dot" /> Friends on one account seen in a server of another <em>{crossed.toLocaleString()}</em>
        </div>
      )}
      {same && (
        <div class="pg-key-row">
          <i class="pg-key-blob" /> Shaded together: may be one person. Click the shading to merge
        </div>
      )}
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
  tuning,
  circle,
  ties,
  onHow,
  netOf,
  group,
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
  tuning: P.GraphTuning;
  /** The circle they are in, if any. */
  circle: Circle | null;
  ties: Ties;
  onHow: () => void;
  netOf: (a: number) => P.Network | undefined;
  /** The Same person? group they are in, when it joins more than two: its card. */
  group: { n: number; open: () => void } | null;
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
      {isPerson && graph.people[node].friend?.length ? <div class="pg-card-sub">Friend on {graph.people[node].friend!.map(accountName).join(', ')}</div> : null}
      {isPerson &&
        otherAccounts(ix, node, netOf).map(([a, n]) => (
          <div class="pg-card-sub">
            Also in {n === 1 ? 'a place' : `${n} places`} only {accountName(a)} sees
          </div>
        ))}
      {isPerson ? (
        <Talk act={act} flat={act?.people[graph.people[node].id]} friends={imp.friends[node]} what="between you" />
      ) : (
        <Talk act={act} flat={act?.places?.[graph.places[placeIx].id]} friends={0} what="of yours here (messages and minutes)" />
      )}
      {isPerson && <Why imp={imp} node={node} tuning={tuning} circle={circle} ties={ties} name={name} onPick={onPick} onHow={onHow} />}
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
          {group && (
            <button class="btn small" onClick={group.open}>
              <Icon name="merge" size={14} /> All {group.n} together…
            </button>
          )}
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

/**
 * Why someone is the size they are: each signal's part of their importance, as a bar against the most anyone has, with
 * what it counted; their circle, and who they are most tied to.
 */
function Why({ imp, node, tuning, circle, ties, name, onPick, onHow }: { imp: Importance; node: number; tuning: P.GraphTuning; circle: Circle | null; ties: Ties; name: (g: number) => string; onPick: (g: number) => void; onHow: () => void }) {
  const K = GRAPH_WEIGHT_KEYS.length;
  const parts = GRAPH_WEIGHT_KEYS.map((k, i) => ({ k, v: imp.parts[node * K + i] })).filter((x) => x.v > 0.005);
  const top = imp.top || 1;
  const tied = useMemo(() => {
    const out: [number, number, number][] = [];
    for (let k = ties.start[node]; k < ties.start[node + 1]; k++) out.push([ties.to[k], ties.w[k], ties.voice[k]]);
    return out.sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [ties, node]);
  const what: Record<P.GraphWeightKey, string> = {
    talk: `${Math.round(imp.talk[node]).toLocaleString()} counted`,
    places: '',
    friends: `${imp.friends[node]}`,
    listed: '',
    networks: '',
    circle: '',
  };
  return (
    <div class="pg-why">
      <h4>
        Why this size <span class="pg-n">{Math.round(imp.score[node] * 100)}% of the most</span>
      </h4>
      {parts.length === 0 ? (
        <div class="pg-card-sub">Nothing counted for them yet: no talk with you, and nothing shared but this place.</div>
      ) : (
        parts.map(({ k, v }) => (
          <div class="pg-why-row" title={SIGNALS[k].about}>
            <span class="pg-why-label">{SIGNALS[k].label}</span>
            <span class="pg-why-bar">
              <i style={{ width: `${Math.min(100, (v / top) * 100).toFixed(1)}%` }} />
            </span>
            <span class="pg-n">{what[k] || `+${Math.round((v / top) * 100)}`}</span>
          </div>
        ))
      )}
      {circle && <div class="pg-card-sub">In the circle {circle.name} ({circle.members.length.toLocaleString()} people)</div>}
      {tied.length > 0 && (
        <div class="pg-card-sub">
          Most tied to{' '}
          {tied.map(([g, , voice], i) => (
            <>
              {i > 0 && ', '}
              <button class="link-btn" onClick={() => onPick(g)}>
                {name(g)}
              </button>
              {voice >= 0.5 && <span class="pg-n" title="Mostly time in a voice channel together"> (voice)</span>}
            </>
          ))}
        </div>
      )}
      <button class="link-btn pg-why-how" onClick={onHow}>
        How importance works{tuning.fitted ? ' (fitted to you)' : ''}
      </button>
    </div>
  );
}

/**
 * How importance is worked out, and your weights for it: a slider per signal and for how fast talk fades, tried on the
 * graph as they move; Fit to me finds the weights that best picked out, six months ago, who you went on to talk with.
 * Save keeps them on the hub; Defaults forgets them. With the voice log on, how much time in voice together ties two people.
 */
function Tuning({ voice, tuning, saved, onTry, onSaved, onClose, fitNow }: { voice: boolean; tuning: P.GraphTuning; saved: P.GraphTuning | null; onTry: (t: P.GraphTuning) => void; onSaved: (t: P.GraphTuning | null) => void; onClose: () => void; fitNow: () => Fit | null }) {
  const [fitting, setFitting] = useState(false);
  const [result, setResult] = useState<Fit | null | 'none'>(null);
  const changed = JSON.stringify(tuning) !== JSON.stringify(saved ?? DEFAULT_TUNING);
  const save = (t: P.GraphTuning | null) =>
    void api<P.GraphTuning | null>('/api/graph/tuning', { method: 'PUT', body: { tuning: t } })
      .then((v) => {
        onSaved(v);
        toast({ kind: 'info', title: t ? 'Importance tuned' : 'Importance back to the defaults', body: t ? 'Your weights are kept on the hub, for every device.' : 'The weights everyone starts with.' });
      })
      .catch((e) => toast({ kind: 'error', title: 'Could not save', body: (e as Error).message }));
  const runFit = () => {
    setFitting(true);
    // Let the button show it is working before the fit holds the page for a moment.
    setTimeout(() => {
      const f = fitNow();
      setFitting(false);
      setResult(f ?? 'none');
      if (f) onTry(f.tuning);
    }, 30);
  };
  return (
    <aside class="pg-card pg-tune" aria-label="How importance works">
      <div class="pg-card-head">
        <span class="pg-card-title">
          <b class="pg-card-name">How importance works</b>
        </span>
        <button class="icon-btn small" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div class="pg-card-sub">
        Each person's importance adds up these signals, each times its weight, and is shown against the most anyone has. It sizes them, and on rings puts them nearer you. Move a weight to try it on the
        graph.
      </div>
      {result === 'none' && <div class="pg-card-sub">Too little talk in the last six months to fit to.</div>}
      {result && result !== 'none' && (
        <div class="pg-card-sub pg-tune-fit">
          Of the {result.of} people you talked with most in the last six months, the weights you had put {result.before} of them in the top {result.of} six months before; these put {result.after}. Save to keep
          them.
        </div>
      )}
      {!result && tuning.fitted && (
        <div class="pg-card-sub pg-tune-fit">
          Fitted {new Date(tuning.fitted.at).toLocaleDateString()}: they found {Math.round(tuning.fitted.after * 100)}% of who you went on to talk with most, against {Math.round(tuning.fitted.before * 100)}% before.
        </div>
      )}
      <div class="pg-card-actions">
        <button class="btn small" disabled={fitting} onClick={runFit} title="Find the weights that best picked out, six months ago, who you went on to talk with most">
          {fitting ? 'Fitting…' : 'Fit to me'}
        </button>
        <button class="btn small" disabled={!changed} onClick={() => save(tuning)}>
          Save
        </button>
        <button class="btn small ghost" disabled={!saved} onClick={() => save(null)}>
          Defaults
        </button>
      </div>
      {GRAPH_WEIGHT_KEYS.map((k) => (
        <label class="pg-tune-row">
          <span class="pg-tune-head">
            <b>{SIGNALS[k].label}</b>
            <span class="pg-n">{tuning.weights[k].toFixed(2)}</span>
          </span>
          <input type="range" min={0} max={3} step={0.05} value={tuning.weights[k]} aria-label={`${SIGNALS[k].label} weight`} onInput={(e) => onTry({ ...tuning, weights: { ...tuning.weights, [k]: Number((e.target as HTMLInputElement).value) }, fitted: undefined })} />
          <span class="pg-tune-about">{SIGNALS[k].about}</span>
        </label>
      ))}
      {voice && (
        <label class="pg-tune-row">
          <span class="pg-tune-head">
            <b>Voice together</b>
            <span class="pg-n">{(tuning.voice ?? 1).toFixed(2)}</span>
          </span>
          <input type="range" min={0} max={3} step={0.05} value={tuning.voice ?? 1} aria-label="Voice together weight" onInput={(e) => onTry({ ...tuning, voice: Number((e.target as HTMLInputElement).value), fitted: undefined })} />
          <span class="pg-tune-about">How much time two people spend in a voice channel together ties them, against their replies and reactions (from the voice log).</span>
        </label>
      )}
      <label class="pg-tune-row">
        <span class="pg-tune-head">
          <b>Talk fades</b>
          <span class="pg-n">by two thirds every {tuning.fade} months</span>
        </span>
        <input type="range" min={3} max={60} step={1} value={tuning.fade} aria-label="Months for talk to fade" onInput={(e) => onTry({ ...tuning, fade: Number((e.target as HTMLInputElement).value), fitted: undefined })} />
      </label>
    </aside>
  );
}

/** A Same person? group: the people it joins, their accounts, why. */
interface Group {
  sides: P.MatchSide[];
  pairs: P.MatchSuggestion[];
  p: number;
}

/** One of a side's accounts, short: its handle, else its name, else its network. */
const accountLabel = (i: P.MatchSide['identities'][number]) => (i.handle && i.network !== 'email' ? i.handle : (i.name ?? netName(i.network)));
const pct = (p: number) => `${Math.round(p * 100)}%`;

/**
 * The merge card for a Same person? group: everyone in it, ticked. Merge them all, or untick some and merge the rest
 * (the unticked stay suggested); "Not them" turns down every pair with one person in it, and "Not the same" all of
 * them, each with Undo.
 */
function SameCard({ group, at, onPick, onClose, onDone, onUndone }: { group: Group; at: (id: string) => number | undefined; onPick: (g: number) => void; onClose: () => void; onDone: (merged: boolean, keys: string[]) => void; onUndone: () => void }) {
  const [ticked, setTicked] = useState(() => new Set(group.sides.map((x) => x.id)));
  const [busy, setBusy] = useState(false);
  useEffect(() => setTicked(new Set(group.sides.map((x) => x.id))), [group]);
  const chosen = group.sides.filter((x) => ticked.has(x.id));
  const all = chosen.length === group.sides.length;
  const n = group.sides.length;
  const merge = async () => {
    setBusy(true);
    try {
      await api('/api/matches/merge', { body: { sides: chosen.map((x) => x.id) } });
      toast({ kind: 'info', title: 'Merged', body: `${chosen.map((x) => x.name).join(' and ')} are one person now. Split them again from their profile.` }, 4000);
      onDone(true, []);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not merge', body: (e as Error).message });
    }
    setBusy(false);
  };
  const turnDown = async (keys: string[], body: string) => {
    setBusy(true);
    try {
      for (const key of keys) await api('/api/matches/decide', { body: { key, decision: 'no' } });
    } catch (e) {
      toast({ kind: 'error', title: 'Could not save that', body: (e as Error).message });
      setBusy(false);
      return;
    }
    setBusy(false);
    onDone(false, keys);
    toast(
      {
        kind: 'info',
        title: 'Not the same',
        body,
        actionLabel: 'Undo',
        action: () =>
          void Promise.all(keys.map((key) => api('/api/matches/decide', { body: { key, undo: true } }))).then(onUndone, (e) => toast({ kind: 'error', title: 'Could not undo that', body: (e as Error).message })),
      },
      6000,
    );
  };
  const notThem = (side: P.MatchSide) =>
    turnDown(
      group.pairs.filter((p) => p.a.id === side.id || p.b.id === side.id).map((p) => p.key),
      `${side.name} won't be suggested with ${n === 2 ? group.sides.find((x) => x.id !== side.id)!.name : 'the others'} again.`,
    );
  return (
    <aside class="pg-card pg-same-card" aria-label="May be one person">
      <div class="pg-card-head">
        <span class="pg-same-icon">
          <Icon name="merge" size={20} />
        </span>
        <span class="pg-card-title">
          <b class="pg-card-name">May be one person</b>
          <span class="pg-card-sub">
            {n === 2 ? `2 accounts · ${pct(group.p)} likely` : `${n} accounts · each pair ${pct(group.p)} likely or more`}
          </span>
        </span>
        <button class="icon-btn small" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div class="pg-same-sides">
        {group.sides.map((side) => {
          const g = at(side.id);
          return (
            <div class="pg-same-side">
              <input
                type="checkbox"
                checked={ticked.has(side.id)}
                aria-label={`Merge ${side.name}`}
                onChange={(e) => {
                  const next = new Set(ticked);
                  if ((e.target as HTMLInputElement).checked) next.add(side.id);
                  else next.delete(side.id);
                  setTicked(next);
                }}
              />
              <button class="pg-row" title={g !== undefined ? 'Show them on the graph' : 'Open their profile'} onClick={() => (g !== undefined ? onPick(g) : go(side.id.startsWith('per_') ? { view: 'profile', person: side.id } : { view: 'profile', identity: side.id }))}>
                <Avatar id={side.id} name={side.name} url={side.avatar} size={28} network={side.identities.length === 1 ? side.identities[0].network : undefined} />
                <span class="pg-same-name">
                  <span class="pg-row-name">{side.name}</span>
                  <small>
                    {side.identities.slice(0, 3).map((i) => (
                      <span>
                        <NetBadge network={i.network} size={11} /> {accountLabel(i)}
                      </span>
                    ))}
                    {side.identities.length > 3 && <span>+{side.identities.length - 3}</span>}
                    {g === undefined && <span>not on the graph</span>}
                  </small>
                </span>
              </button>
              {n > 2 && (
                <button class="btn small ghost" disabled={busy} title={`${side.name} is not the same person as the others`} onClick={() => void notThem(side)}>
                  Not them
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div class="pg-card-actions">
        <button class="btn small" disabled={busy || chosen.length < 2} onClick={() => void merge()}>
          <Icon name="merge" size={14} /> {all ? (n === 2 ? 'Merge' : `Merge all ${n}`) : `Merge the ${chosen.length} ticked`}
        </button>
        <button class="btn small ghost" disabled={busy} onClick={() => void turnDown(group.pairs.map((p) => p.key), n === 2 ? `${group.sides[0].name} and ${group.sides[1].name} won't be suggested again.` : `None of these ${n} will be suggested together again.`)}>
          {n === 2 ? 'Not the same' : 'None are the same'}
        </button>
      </div>
      {!all && chosen.length >= 2 && <div class="pg-card-sub">The unticked stay suggested; turn them down with Not them.</div>}
      <h4>Why</h4>
      <div class="pg-same-why">
        {group.pairs.map((p) => (
          <div class="pg-same-pair">
            <div class="pg-same-pair-head">
              <span>
                {p.a.name} and {p.b.name}
              </span>
              <span class="pg-n">{pct(p.p)}</span>
            </div>
            <ul>
              {p.evidence.slice(0, 4).map((e) => (
                <li class={e.weight < 0 ? 'against' : ''}>{e.text}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
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

/**
 * How much you have talked with someone, or been in a place, and when: a bar a year, the past year's count, and
 * friends you share.
 */
function Talk({ act, flat, friends, what }: { act: P.GraphActivity | null; flat: number[] | undefined; friends: number; what: string }) {
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
          About {n(total)} {what}
          {year >= 1 ? `, ${n(year)} in the past year` : ', none in the past year'}
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
