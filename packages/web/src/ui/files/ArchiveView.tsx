/**
 * What is in a ZIP, tar or gzip, as the hub read it from the headers (packages/hub/src/fileinfo.ts): names and sizes
 * of the first entries. Nothing is extracted, here or on the hub.
 */
import type { FileViewProps } from '../Viewer.tsx';
import { size } from './load.tsx';

export default function ArchiveView({ info }: FileViewProps) {
  if (!info?.list) return <div class="fv-wait">The hub has not looked inside this archive. Download it to see what it holds.</div>;
  const n = info.entries ?? info.list.length;
  const at = info.partial ? 'at least ' : '';
  return (
    <div class="fv-archive">
      <div class="fv-tools">
        <span class="fv-tools-info">
          {at}
          {n.toLocaleString()} {n === 1 ? 'entry' : 'entries'}
          {info.list.length < n ? ` · the first ${info.list.length} shown` : ''}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th class="num">Size</th>
          </tr>
        </thead>
        <tbody>
          {info.list.map((e, i) => (
            <tr key={i}>
              <td>
                <span class={`fv-entry${e.dir ? ' dir' : ''}`} title={e.name}>
                  {e.name}
                </span>
              </td>
              <td class="num">{e.dir ? '' : size(e.size) || '0 B'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="fv-note">Nothing is unpacked here. Download the archive to open what is inside.</div>
    </div>
  );
}
