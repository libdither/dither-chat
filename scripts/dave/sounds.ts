/**
 * Discord's own call sounds (someone joins, leaves, you mute, a stream starts...), copied from the public web client so
 * a device in a call hears what Discord's own client plays (docs/calls.md "Sounds"). Run by update.ts after it fetched
 * the build; on its own:
 *
 *   bun scripts/dave/sounds.ts --assets DIR --out DIR
 *
 * Found by a stable anchor, never by module ids: the client's sound table is a webpack context module whose keys are
 * the sound files' names ("./user_join.mp3": "<module id>"), and each of those modules exports the file's URL
 * (`n.p+"<hash>.mp3"` or "/assets/<hash>.mp3"). Only the names in protocol's CALL_SOUNDS are downloaded, from
 * https://discord.com/assets/ like the rest of the build.
 *
 * Output: OUT/<name>.mp3 and OUT/sounds.json ({ build, sounds: { name: asset } }). They are Discord's recordings: never
 * commit them.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CALL_SOUNDS } from '../../packages/protocol/src/call.ts';
import { AnchorError, fetchAsset } from './extract.ts';

/** The sound table: name -> asset file name, from the build's scripts. */
export function soundTable(files: string[]): Map<string, string> {
  let table: Record<string, string> | null = null;
  const sources: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    sources.push(src);
    if (table || !src.includes('"./user_join.mp3"')) continue;
    const at = src.indexOf('"./user_join.mp3"');
    const open = src.lastIndexOf('{', at);
    const close = src.indexOf('}', at);
    if (open < 0 || close < 0) continue;
    const t: Record<string, string> = {};
    for (const m of src.slice(open, close).matchAll(/"\.\/([a-z0-9_-]+)\.mp3":"?(\d+)"?/g)) t[m[1]!] = m[2]!;
    if (Object.keys(t).length) table = t;
  }
  if (!table) throw new AnchorError('the sound table ("./user_join.mp3": <module>) was not found');
  const out = new Map<string, string>();
  for (const [name, id] of Object.entries(table)) {
    const re = new RegExp(`[,{\\s]${id}\\(e(?:,t)?(?:,n)?\\)\\{"use strict";?\\s*e\\.exports=(?:[\\w$]+\\.p\\+)?"(?:/assets/)?([0-9a-f]{8,40}\\.mp3)"`);
    for (const src of sources) {
      const m = re.exec(src);
      if (m) {
        out.set(name, m[1]!);
        break;
      }
    }
  }
  return out;
}

/** Download the call sounds into `out`; returns how many it has. Throws AnchorError when the table moved. */
export async function updateSounds(files: string[], cache: string, out: string, build?: string): Promise<number> {
  const table = soundTable(files);
  mkdirSync(out, { recursive: true });
  const kept: Record<string, string> = {};
  for (const name of CALL_SOUNDS) {
    const asset = table.get(name);
    if (!asset) continue;
    const src = await fetchAsset(cache, asset);
    const bytes = readFileSync(src);
    // An mp3 starts with an ID3 tag or a frame sync.
    if (!(bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) && !(bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) continue;
    const dest = join(out, `${name}.mp3`);
    writeFileSync(dest + '.part', bytes);
    renameSync(dest + '.part', dest);
    kept[name] = asset;
  }
  const tmp = join(out, `sounds.json.${process.pid}`);
  writeFileSync(tmp, JSON.stringify({ build: build ?? null, at: new Date().toISOString(), sounds: kept }, null, 1) + '\n');
  renameSync(tmp, join(out, 'sounds.json'));
  return Object.keys(kept).length;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => argv[argv.indexOf(n) + 1];
  if (!argv.includes('--assets') || !argv.includes('--out')) {
    console.error('usage: bun scripts/dave/sounds.ts --assets DIR --out DIR');
    process.exit(1);
  }
  const dir = resolve(opt('--assets')!);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => join(dir, f));
  const n = await updateSounds(files, dir, resolve(opt('--out')!));
  console.log(`${n} sounds`);
  if (!existsSync(join(resolve(opt('--out')!), 'sounds.json'))) process.exit(1);
}
