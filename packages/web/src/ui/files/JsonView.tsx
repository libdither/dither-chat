/**
 * JSON as a tree (docs/files.md): objects and arrays fold, the first two levels open. A file cut short at the cap, or
 * one that isn't valid JSON, is shown as text instead.
 */
import { useMemo, useState } from 'preact/hooks';
import type { FileViewProps } from '../Viewer.tsx';
import { Failed, Partial, useText, Waiting } from './load.tsx';
import { SourceToggle } from './MarkdownView.tsx';
import { Code } from './TextView.tsx';

/** Children shown before a "more" button. */
const SOME = 200;

export default function JsonView({ att, info }: FileViewProps) {
  const t = useText(att.url, info?.encoding);
  const [source, setSource] = useState(false);
  const parsed = useMemo(() => {
    if (t.state !== 'ok' || t.truncated) return { ok: false as const };
    try {
      return { ok: true as const, value: JSON.parse(t.value) as unknown };
    } catch (e: any) {
      return { ok: false as const, error: String(e?.message ?? e) };
    }
  }, [t]);
  const [open, setOpen] = useState<{ all: boolean | null; n: number }>({ all: null, n: 0 });
  if (t.state === 'loading') return <Waiting />;
  if (t.state === 'error') return <Failed error={t.error} />;
  if (!parsed.ok)
    return (
      <>
        {t.truncated ? <Partial shown={new TextEncoder().encode(t.value).length} total={info?.size ?? att.size} /> : <div class="fv-note">Not valid JSON{parsed.error ? `: ${parsed.error}` : ''}. Shown as text.</div>}
        <Code text={t.value} language="json" />
      </>
    );
  return (
    <>
      <SourceToggle source={source} set={setSource} />
      {source ? (
        <Code text={t.value} language="json" />
      ) : (
        <div class="fv-json">
          <div class="fv-tools">
            <button class="chip-btn" onClick={() => setOpen({ all: true, n: open.n + 1 })}>
              Expand all
            </button>
            <button class="chip-btn" onClick={() => setOpen({ all: false, n: open.n + 1 })}>
              Collapse all
            </button>
          </div>
          <div class="fv-json-tree" key={open.n}>
            <Node value={parsed.value} depth={0} all={open.all} />
          </div>
        </div>
      )}
    </>
  );
}

function Leaf({ value }: { value: unknown }) {
  if (value === null) return <span class="hl-k">null</span>;
  if (typeof value === 'string') return <span class="hl-s">{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span class="hl-n">{String(value)}</span>;
  if (typeof value === 'boolean') return <span class="hl-k">{String(value)}</span>;
  return <span>{String(value)}</span>;
}

function Node({ name, value, depth, all }: { name?: string; value: unknown; depth: number; all: boolean | null }) {
  const branch = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(all ?? depth < 2);
  const [shown, setShown] = useState(SOME);
  const label = name !== undefined && <span class="hl-a">{name}</span>;
  if (!branch)
    return (
      <div class="fv-json-row">
        {label}
        {label && ': '}
        <Leaf value={value} />
      </div>
    );
  const array = Array.isArray(value);
  const entries: [string, unknown][] = array ? (value as unknown[]).map((v, i) => [String(i), v]) : Object.entries(value as object);
  const summary = array ? `[${entries.length} ${entries.length === 1 ? 'item' : 'items'}]` : `{${entries.length} ${entries.length === 1 ? 'key' : 'keys'}}`;
  return (
    <div class="fv-json-node">
      <button class="fv-json-toggle" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!entries.length}>
        <span class="fv-json-caret" aria-hidden="true">
          {entries.length ? (open ? '▾' : '▸') : ''}
        </span>
        {label}
        {label && ': '}
        <span class="fv-json-sum">{summary}</span>
      </button>
      {open && entries.length > 0 && (
        <div class="fv-json-kids">
          {entries.slice(0, shown).map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} all={all} />
          ))}
          {entries.length > shown && (
            <button class="fv-more" onClick={() => setShown(shown + SOME * 5)}>
              Show {Math.min(SOME * 5, entries.length - shown)} more ({entries.length - shown} left)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
