/**
 * Which desktop apps open a MIME type: what `gio mime <type>` reports (default first, then registered and
 * recommended), named from their .desktop files.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface App {
  id: string;
  name: string;
}

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const ID = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*\.desktop$/;

export const validMime = (m: unknown): m is string => typeof m === 'string' && m.length <= 200 && MIME.test(m);
export const validAppId = (id: unknown): id is string => typeof id === 'string' && id.length <= 200 && ID.test(id);

/** The ids in `gio mime` output, default first, each once. */
export function parseGioMime(out: string): string[] {
  const ids: string[] = [];
  const add = (id: string) => validAppId(id) && !ids.includes(id) && ids.push(id);
  for (const line of out.split('\n')) {
    const def = line.match(/^Default application.*:\s*(\S+\.desktop)\s*$/);
    if (def) add(def[1]);
    else if (/^\s+\S+\.desktop\s*$/.test(line)) add(line.trim());
  }
  return ids;
}

/** Where .desktop files live, most specific first (XDG base directories). */
export function applicationDirs(env: Record<string, string | undefined> = process.env): string[] {
  const home = env.HOME ?? '';
  const dataHome = env.XDG_DATA_HOME || join(home, '.local/share');
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [dataHome, ...dataDirs].map((d) => join(d, 'applications'));
}

/** The file for a desktop id. `a-b.desktop` may also be `a/b.desktop` (the spec's subdirectory rule). */
export function desktopFile(id: string, dirs: string[]): string | null {
  if (!validAppId(id)) return null;
  const names = [id];
  const dash = id.indexOf('-');
  if (dash > 0) names.push(id.slice(0, dash) + '/' + id.slice(dash + 1));
  for (const d of dirs) for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  return null;
}

/** Name= from the [Desktop Entry] group; null for a hidden entry. */
export function desktopName(text: string): string | null {
  let inEntry = false;
  let name: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) inEntry = line === '[Desktop Entry]';
    else if (inEntry && line.startsWith('Name=') && name === null) name = line.slice(5).trim();
    else if (inEntry && /^Hidden\s*=\s*true$/.test(line)) return null;
  }
  return name;
}

export async function listApps(mime: string, gio: string[], dirs: string[]): Promise<App[]> {
  if (!validMime(mime)) return [];
  const proc = Bun.spawn([...gio, 'mime', mime], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env: { ...process.env, LC_ALL: 'C' } });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const apps: App[] = [];
  for (const id of parseGioMime(out)) {
    const file = desktopFile(id, dirs);
    if (!file) continue;
    let name: string | null;
    try {
      name = desktopName(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (name) apps.push({ id, name });
  }
  return apps;
}
