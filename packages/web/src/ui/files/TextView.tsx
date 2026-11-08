/**
 * Text and code (docs/files.md): monospace, line numbers, light highlighting (highlight.ts). HTML, SVG and XML come
 * here too and are shown as their source. Long files show a few thousand lines at a time.
 */
import { useMemo, useState } from 'preact/hooks';
import type { FileViewProps } from '../Viewer.tsx';
import { highlight, toLines, type Token } from './highlight.ts';
import { Failed, Partial, useText, Waiting } from './load.tsx';

const PAGE = 3000;
/** Highlighting a bigger text than this is left out: plain lines are quicker. */
const HIGHLIGHT_MAX = 512 * 1024;

export default function TextView({ att, info, language }: FileViewProps) {
  const t = useText(att.url, info?.encoding);
  if (t.state === 'loading') return <Waiting />;
  if (t.state === 'error') return <Failed error={t.error} />;
  return (
    <>
      {t.truncated && <Partial shown={new TextEncoder().encode(t.value).length} total={info?.size ?? att.size} />}
      <Code text={t.value} language={language} />
    </>
  );
}

/** Lines of text with numbers; also the "Source" of the Markdown, JSON and table viewers. */
export function Code({ text, language }: { text: string; language?: string | null }) {
  // Wrapped for prose and on a phone; code keeps its lines.
  const [wrap, setWrap] = useState(() => !language || !!globalThis.matchMedia?.('(max-width: 700px)').matches);
  const [shown, setShown] = useState(PAGE);
  const all = useMemo(() => {
    const tokens = text.length <= HIGHLIGHT_MAX ? highlight(text, language) : null;
    return tokens ? toLines(tokens) : text.split('\n').map((l): Token[] => (l ? [['', l]] : []));
  }, [text, language]);
  // A file ending in a newline has no empty last line.
  const lines = all.length > 1 && !all[all.length - 1].length ? all.slice(0, -1) : all;
  const width = String(lines.length).length;
  return (
    <div class="fv-text">
      <div class="fv-tools">
        <span class="fv-tools-info">
          {lines.length.toLocaleString()} {lines.length === 1 ? 'line' : 'lines'}
          {language && language !== 'plain' ? ` · ${language}` : ''}
        </span>
        <button class={`chip-btn${wrap ? ' on' : ''}`} aria-pressed={wrap} onClick={() => setWrap(!wrap)} title="Wrap long lines">
          Wrap
        </button>
      </div>
      <div class={`fv-code${wrap ? ' wrap' : ''}`} style={{ '--ln-w': `${width + 1}ch` }}>
        {lines.slice(0, shown).map((l, i) => (
          <div class="fv-line" key={i}>
            <span class="fv-n">{i + 1}</span>
            <span class="fv-src">
              {l.map(([cls, s]) => (cls ? <span class={`hl-${cls}`}>{s}</span> : s))}
              {'\n'}
            </span>
          </div>
        ))}
      </div>
      {lines.length > shown && (
        <button class="fv-more" onClick={() => setShown(shown + PAGE)}>
          Show {Math.min(PAGE, lines.length - shown).toLocaleString()} more lines ({(lines.length - shown).toLocaleString()} left)
        </button>
      )}
    </div>
  );
}
