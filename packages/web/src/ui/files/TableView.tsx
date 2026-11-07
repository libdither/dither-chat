/** CSV and TSV as a table (docs/files.md), parsed by csv.ts. */
import { useMemo, useState } from 'preact/hooks';
import type { FileViewProps } from '../Viewer.tsx';
import { delimiter, parseCsv } from './csv.ts';
import { Failed, Partial, useText, Waiting } from './load.tsx';
import { SourceToggle } from './MarkdownView.tsx';
import { Code } from './TextView.tsx';

const ROWS = 1000;

export default function TableView({ att, info }: FileViewProps) {
  const t = useText(att.url, info?.encoding);
  const [source, setSource] = useState(false);
  const [shown, setShown] = useState(ROWS);
  const d = t.state === 'ok' ? delimiter(t.value, { mime: info?.mime ?? att.mime, name: att.name }) : ',';
  const rows = useMemo(() => (t.state === 'ok' ? parseCsv(t.value, d) : []), [t, d]);
  if (t.state === 'loading') return <Waiting />;
  if (t.state === 'error') return <Failed error={t.error} />;
  const [head, ...body] = rows;
  const cols = Math.max(0, ...rows.slice(0, shown + 1).map((r) => r.length));
  return (
    <>
      <SourceToggle source={source} set={setSource} />
      {t.truncated && <Partial shown={new TextEncoder().encode(t.value).length} total={info?.size ?? att.size} />}
      {source ? (
        <Code text={t.value} language={d === '\t' ? 'tsv' : 'csv'} />
      ) : (
        <div class="fv-table">
          <div class="fv-tools">
            <span class="fv-tools-info">
              {body.length.toLocaleString()} {body.length === 1 ? 'row' : 'rows'} · {cols} {cols === 1 ? 'column' : 'columns'}
            </span>
          </div>
          <div class="fv-table-scroll">
            <table>
              {head && (
                <thead>
                  <tr>
                    <th class="fv-rn" />
                    {Array.from({ length: cols }, (_, j) => (
                      <th key={j}>{head[j] ?? ''}</th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {body.slice(0, shown).map((r, i) => (
                  <tr key={i}>
                    <td class="fv-rn">{i + 1}</td>
                    {Array.from({ length: cols }, (_, j) => (
                      <td key={j}>{r[j] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {body.length > shown && (
            <button class="fv-more" onClick={() => setShown(shown + ROWS)}>
              Show {Math.min(ROWS, body.length - shown).toLocaleString()} more rows ({(body.length - shown).toLocaleString()} left)
            </button>
          )}
        </div>
      )}
    </>
  );
}
