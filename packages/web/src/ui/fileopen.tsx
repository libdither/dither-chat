/**
 * Saving a file and opening it outside the app: the desktop helper's apps (desk.ts), the phone's (android.ts), or a
 * tab. Shared by the file menus (menus.tsx) and the file viewer's header (Viewer.tsx).
 */
import type * as P from '@dither-chat/protocol';
import { showsInline } from '@dither-chat/protocol';
import { android } from '../android.ts';
import { appsFor, openFile } from '../desk.ts';
import { fileKind, fileMime, type FileSource } from '../files.ts';
import { toast } from '../state.ts';
import { menuPoint, openMenu } from './ContextMenu.tsx';

type FileRef = Pick<FileSource, 'url' | 'name' | 'mime'> & Partial<Pick<FileSource, 'kind' | 'info'>>;

const GENERIC = /^(application\/(octet-stream|binary|unknown|x-download|force-download)|binary\/octet-stream)?$/;

/** The type the hub serves the file as: the network's, or the bytes' when the network said nothing useful. */
const served = (a: FileRef) => (GENERIC.test((a.mime ?? '').split(';')[0].trim().toLowerCase()) ? (a.info?.mime ?? a.mime) : a.mime);

export function save(url: string, name?: string | null) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name ?? '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Opens a file: through the desktop helper when it is on, else in a tab (a type the browser shows) or as a download. */
export function openAttachment(a: FileRef) {
  const f = { url: a.url, name: a.name, mime: fileMime(a) };
  if (android?.opensFiles()) return android.openFile(f);
  void openFile(f).then((ok) => {
    if (ok) return;
    if (showsInline(served(a))) window.open(a.url, '_blank', 'noopener');
    else save(a.url, a.name);
  });
}

/** The desktop's apps for the file's type, in a menu where the last one was. Text of a type no app claims: text editors. */
export async function openWith(a: FileRef) {
  let mime = fileMime(a);
  let apps = await appsFor(mime);
  if (!apps) return toast({ kind: 'error', title: 'The desktop helper does not answer', body: 'Is dither-desk running? See Settings → Desktop helper.' });
  const kind = a.kind ? fileKind({ kind: a.kind, mime: a.mime, name: a.name, info: a.info }) : null;
  if (!apps.length && kind && ['text', 'markdown', 'json', 'csv'].includes(kind) && mime !== 'text/plain') {
    mime = 'text/plain';
    apps = (await appsFor(mime)) ?? [];
  }
  if (!apps.length) return toast({ kind: 'info', title: `No app opens ${mime}`, body: 'Save it instead.' });
  const f = { url: a.url, name: a.name, mime };
  openMenu(
    { x: menuPoint().x, y: menuPoint().y },
    { label: 'Open with', head: <div class="cm-sheet-title">Open {a.name ?? 'file'} with</div>, items: [{ kind: 'label', label: 'Open with' }, ...apps.map((x, i) => ({ label: i === 0 ? `${x.name} (default)` : x.name, run: () => void openFile(f, x.id) }))] },
  );
}
