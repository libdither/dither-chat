/**
 * Picking someone's time zone on a world map (docs/profile.md "Their time"): each zone's main city a dot, night shaded
 * where it is night now, the cities on the clock of the guess (or of the one pointed at) lit. Pointing shows the
 * nearest city and its time, a click or a tap picks it, and Set keeps it; a search finds any zone by name. Its own
 * chunk, loaded when the card's Set time zone opens it.
 */
import type * as P from '@dither-chat/protocol';
import { useMemo, useRef, useState } from 'preact/hooks';
import { zoneOffset } from '../format.ts';
import { wallClock } from '../theirclock.ts';
import { CITIES, LAND, MAP_H, MAP_NORTH, MAP_SCALE, MAP_W } from './zonemap-data.ts';
import './zonemap.css';

const DEG = Math.PI / 180;
/** "Asia/Ho_Chi_Minh" → "Ho Chi Minh". */
const cityOf = (zone: string) => zone.slice(zone.lastIndexOf('/') + 1).replace(/_/g, ' ');
/** "UTC+5:30", "UTC−3", "UTC". */
function utcLabel(min: number): string {
  if (!min) return 'UTC';
  const a = Math.abs(min);
  return `UTC${min < 0 ? '−' : '+'}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
}

/**
 * Where it is night at `ts`, as a polygon on the map: the line where the sun sets, from the sun's declination and the
 * longitude it is overhead at, closed off at the pole that is dark.
 */
function nightPath(ts: number): string {
  const d = new Date(ts);
  const day = (ts - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000;
  let decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (day + 10));
  if (Math.abs(decl) < 0.1) decl = decl < 0 ? -0.1 : 0.1;
  const sunLon = -15 * ((ts % 86_400_000) / 3_600_000 - 12);
  const pts: string[] = [];
  for (let lon = -180; lon <= 180; lon += 4) {
    const lat = Math.atan(-Math.cos((lon - sunLon) * DEG) / Math.tan(decl * DEG)) / DEG;
    pts.push(`${((lon + 180) * MAP_SCALE).toFixed(0)},${((MAP_NORTH - lat) * MAP_SCALE).toFixed(1)}`);
  }
  // Northern summer: the south pole is dark, so the night runs from the line down to the bottom edge.
  const edge = decl > 0 ? MAP_H + 2 : -2;
  return `M${pts.join('L')}L${MAP_W},${edge}L0,${edge}Z`;
}

export function ZoneMap({
  current,
  pinned,
  guess,
  onPick,
}: {
  /** The zone they have now, if it is a named one (set by you or from a profile). */
  current: string | null;
  pinned: boolean;
  /** Their clock as guessed from when they are around: its cities are lit. */
  guess: Extract<P.TheirClock, { source: 'rhythm' }> | null;
  onPick: (zone: string | null) => void;
}) {
  const now = Date.now();
  const svg = useRef<SVGSVGElement>(null);
  const [chosen, setChosen] = useState<string | null>(current);
  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Each city's offset now, worked out once.
  const offsets = useMemo(() => new Map(CITIES.map(([z]) => [z, zoneOffset(z, now)])), []);
  const night = useMemo(() => nightPath(now), []);
  const allZones = useMemo(() => (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? CITIES.map(([z]) => z), []);
  const where = useMemo(() => new Map(CITIES.map(([z, x, y]) => [z, [x, y] as const])), []);

  const shown = hover ?? chosen;
  const shownOffset = shown ? zoneOffset(shown, now) : null;
  // Lit: the cities on the same clock as the one pointed at or picked, else those on the guessed clock.
  const lit = shownOffset ?? guess?.offset ?? null;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/[\s_]+/g, ' ');
    if (!q) return [];
    const hits = allZones.filter((z) => z.toLowerCase().replace(/_/g, ' ').includes(q));
    // A city's own name first ("paris" before "America/Paris…"), then by name.
    return hits.sort((a, b) => +!cityOf(a).toLowerCase().startsWith(q) - +!cityOf(b).toLowerCase().startsWith(q) || a.localeCompare(b)).slice(0, 6);
  }, [query]);

  /** The city nearest a pointer, in map units; none when the nearest is far off (out at sea, say). */
  const nearest = (e: PointerEvent): string | null => {
    const r = svg.current?.getBoundingClientRect();
    if (!r) return null;
    const mx = ((e.clientX - r.left) / r.width) * MAP_W;
    const my = ((e.clientY - r.top) / r.height) * MAP_H;
    let best: string | null = null;
    let bestD = 30 ** 2;
    for (const [z, x, y] of CITIES) {
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < bestD) [best, bestD] = [z, d];
    }
    return best;
  };

  const pick = (z: string) => {
    setChosen(z);
    setHover(null);
    setQuery('');
  };

  const mark = shown ? where.get(shown) : undefined;
  return (
    <div class="td-zone">
      <svg
        ref={svg}
        class="zm-map"
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        role="img"
        aria-label="World map of time zones: point at a city to see its time, click to pick it"
        onPointerMove={(e) => e.pointerType === 'mouse' && setHover(nearest(e))}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          const z = nearest(e as unknown as PointerEvent);
          if (z) pick(z);
        }}
      >
        <path class="zm-land" d={LAND} />
        <path class="zm-night" d={night} />
        {CITIES.map(([z, x, y]) => (
          <circle key={z} class={`zm-city${lit !== null && offsets.get(z) === lit ? ' lit' : ''}`} cx={x} cy={y} r={lit !== null && offsets.get(z) === lit ? 4 : 2.6} />
        ))}
        {mark && <circle class="zm-mark" cx={mark[0]} cy={mark[1]} r={9} />}
      </svg>
      <div class="zm-status" aria-live="polite">
        {shown ? (
          <>
            <b>{cityOf(shown)}</b> {wallClock(now, shownOffset ?? 0, true)} <span>· {utcLabel(shownOffset ?? 0)}</span>
          </>
        ) : guess ? (
          <span>Lit: cities on the guessed clock, {utcLabel(guess.offset)}. Point at one, or search.</span>
        ) : (
          <span>Point at a city, or search.</span>
        )}
      </div>
      <input
        class="zm-search"
        type="search"
        placeholder="Search a city or zone"
        aria-label="Search time zones"
        value={query}
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches[0]) {
            e.preventDefault();
            pick(matches[0]);
          }
        }}
      />
      {matches.length > 0 && (
        <div class="zm-matches" role="listbox" aria-label="Matching time zones">
          {matches.map((z) => (
            <button key={z} type="button" role="option" aria-selected={z === chosen} onClick={() => pick(z)}>
              <b>{cityOf(z)}</b> <span>{z.replace(/_/g, ' ')}</span>
            </button>
          ))}
        </div>
      )}
      <div class="zm-actions">
        <button type="button" class="zm-set" disabled={!chosen || chosen === current} onClick={() => chosen && onPick(chosen)}>
          {chosen ? `Set to ${cityOf(chosen)}` : 'Set'}
        </button>
        {pinned && (
          <button type="button" class="link-btn" onClick={() => onPick(null)}>
            Use what they say, or the guess
          </button>
        )}
      </div>
    </div>
  );
}
