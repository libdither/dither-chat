/**
 * A mail's files, as chat's file cards (docs/mail-design.md §6.3, §7): pictures show in place and open in the image
 * viewer; text, code, PDF, tables and archives open in the file viewers; anything else opens in its app (the desktop
 * helper, the phone) or downloads. The hub fetches a file from the server the first time it is opened, and looks at
 * its bytes, so a card says what the file really is. Pictures the HTML shows itself are not listed.
 */
import type * as P from '@dither-chat/protocol';
import { extOf, showsInline } from '@dither-chat/protocol';
import { android } from '../../android.ts';
import { desk } from '../../desk.ts';
import { fileFacts, fileIcon, fileKind, openFileSource, VIEWABLE, type FileSource } from '../../files.ts';
import { openAttachment } from '../fileopen.tsx';
import { Icon } from '../icons.tsx';
import { viewer } from '../Viewer.tsx';

/** A part as the viewers take it. */
export function partSource(a: P.MailAttachmentView): FileSource {
  const mime = a.info?.mime ?? a.mime;
  const kind: P.AttachmentKind = /^image\/(?!svg)/i.test(mime) ? 'image' : /^video\//i.test(mime) ? 'video' : /^audio\//i.test(mime) ? 'audio' : 'file';
  return { url: a.url, infoUrl: a.infoUrl, name: a.name, mime: a.mime, size: a.size, kind, ...(a.info ? { info: a.info } : {}) };
}

/** Names and types that run when opened: the card says so before you do. */
const RUNS = /^(exe|scr|com|bat|cmd|msi|ps1|vbs|vbe|js|jse|wsf|hta|jar|apk|app|dmg|pkg|sh|lnk|reg|iso|img)$/i;
export function runsCode(f: FileSource): boolean {
  const m = (f.info?.mime ?? '').toLowerCase();
  return /executable|x-mach-binary|x-msdownload|java-archive|android\.package|x-sh\b|x-shellscript|javascript/.test(m) || RUNS.test(extOf(f.name) ?? '');
}

export function MailFiles({ body }: { body: P.MailBodyView }) {
  const files = body.attachments.map(partSource);
  if (!files.length) return null;
  const images = files.filter((f) => f.kind === 'image');
  return (
    <div class="atts mail-files">
      {files.map((f, i) => {
        if (f.kind === 'image') {
          const at = images.indexOf(f);
          return (
            <a
              class="att-img mail-file-img"
              data-att={i}
              href={f.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                e.preventDefault();
                viewer.value = { images: images.map((x) => ({ url: x.url, name: x.name, width: x.info?.width, height: x.info?.height })), index: at };
              }}
            >
              <img src={f.url} alt={f.name ?? ''} loading="lazy" />
            </a>
          );
        }
        const fk = fileKind(f);
        const open = (e: MouseEvent) => {
          if (VIEWABLE.has(fk)) e.preventDefault(), openFileSource(f);
          else if (desk.value?.files || android?.opensFiles()) e.preventDefault(), openAttachment(f);
        };
        const risky = runsCode(f);
        return (
          <a class={`att-file ${risky ? 'risky' : ''}`} data-att={i} data-kind={fk} href={f.url} target="_blank" rel="noreferrer" download={showsInline(f.mime) ? undefined : (f.name ?? true)} onClick={open}>
            <Icon name={risky ? 'alert' : fileIcon(fk, f.info?.language)} size={22} />
            <span>
              <b>{f.name ?? 'file'}</b>
              <small>{fileFacts(f)}</small>
              {risky && <small class="mail-file-warn">A program: open it only if you expected it</small>}
            </span>
          </a>
        );
      })}
    </div>
  );
}
