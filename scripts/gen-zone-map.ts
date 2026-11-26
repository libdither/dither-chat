/**
 * Makes packages/web/src/ui/zonemap-data.ts, the world map the time zone picker draws (ui/ZoneMap.tsx): land as one SVG
 * path in an equirectangular frame, and each zone's main city with where it is.
 *
 *   bun scripts/gen-zone-map.ts <land-110m.json> <topojson-client.min.js> <zone1970.tab>
 *
 * land-110m.json is Natural Earth's 1:110m land (public domain), as world-atlas@2 publishes it on npm; topojson-client@3
 * turns it into rings; zone1970.tab comes with tzdata (share/zoneinfo).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [landPath, clientPath, tabPath] = process.argv.slice(2);
if (!tabPath) throw new Error('usage: bun scripts/gen-zone-map.ts <land-110m.json> <topojson-client.min.js> <zone1970.tab>');

// The map runs from 180°W to 180°E and from 84°N to 58°S (Antarctica left out), 2 units a degree.
const S = 2;
const N = 84;
const SOUTH = -58;
const x = (lon: number) => Math.round((lon + 180) * S);
const y = (lat: number) => Math.round((N - Math.max(SOUTH, Math.min(N, lat))) * S);

const topo = JSON.parse(readFileSync(landPath, 'utf8'));
const mod: { exports: any } = { exports: {} };
new Function('module', 'exports', readFileSync(clientPath, 'utf8'))(mod, mod.exports);
const land = mod.exports.feature(topo, topo.objects.land);

let d = '';
for (const f of land.features ?? [land]) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      const pts: [number, number][] = [];
      for (const [lon, lat] of ring) {
        const p: [number, number] = [x(lon), y(lat)];
        const last = pts.at(-1);
        if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
      }
      // Rings below the map's bottom edge, or too small to see, are left out.
      if (pts.length < 4 || pts.every((p) => p[1] === y(SOUTH))) continue;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      if ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) < 2) continue;
      // One "l" and then relative steps, a space only where the next number has no minus sign to start it.
      let s = `M${pts[0][0]} ${pts[0][1]}l`;
      for (let i = 1; i < pts.length; i++) {
        for (const v of [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]) s += s.endsWith('l') || v < 0 ? `${v}` : ` ${v}`;
      }
      d += `${s}z`;
    }
  }
}

/** "+3518+13942" or "+404251-0740023": ISO 6709 degrees (and minutes, and seconds) to decimal. */
function coord(s: string): [number, number] {
  const m = s.match(/^([+-]\d+)([+-]\d+)$/)!;
  const part = (v: string, degDigits: number) => {
    const sign = v[0] === '-' ? -1 : 1;
    const t = v.slice(1);
    const deg = +t.slice(0, degDigits);
    const min = +t.slice(degDigits, degDigits + 2);
    const sec = +(t.slice(degDigits + 2, degDigits + 4) || 0);
    return sign * (deg + min / 60 + sec / 3600);
  };
  return [part(m[1], 2), part(m[2], 3)];
}
const zones: [string, number, number][] = [];
for (const line of readFileSync(tabPath, 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const [, c, zone] = line.split('\t');
  if (!zone || zone.startsWith('Antarctica/')) continue;
  const [lat, lon] = coord(c);
  zones.push([zone, Math.round((lon + 180) * S * 10) / 10, Math.round((N - lat) * S * 10) / 10]);
}

const out = `/**
 * Made by scripts/gen-zone-map.ts: don't edit by hand. Land from Natural Earth's 1:110m land (public domain), each zone's
 * main city from tzdata's zone1970.tab. The frame is equirectangular, 2 units a degree, 180°W to 180°E and 84°N to 58°S.
 */
export const MAP_W = ${360 * S};
export const MAP_H = ${(N - SOUTH) * S};
/** Degrees of latitude at the map's top edge, and units a degree. */
export const MAP_NORTH = ${N};
export const MAP_SCALE = ${S};
export const LAND = '${d}';
/** Each zone's main city: its IANA name, and where it sits on the map (x, y). */
export const CITIES: [string, number, number][] = ${JSON.stringify(zones)};
`;
const file = join(import.meta.dir, '../packages/web/src/ui/zonemap-data.ts');
writeFileSync(file, out);
console.log(`${file}: ${out.length} bytes, ${zones.length} zones`);
