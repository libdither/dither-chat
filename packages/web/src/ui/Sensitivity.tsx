/**
 * How readily a category (or a "by meaning" filter) matches: a slider over the P(yes) a place needs, on a log scale,
 * because the reranker's answers crowd near zero (0.5 is a strong yes, 0.02 a weak one). Right is more places.
 */

/** Slider position 0…100 ↔ threshold 1 … 0.001. */
export const toThreshold = (v: number) => Math.round(10 ** (-3 * (v / 100)) * 10000) / 10000;
export const toSlider = (t: number) => Math.round((-Math.log10(Math.max(0.001, Math.min(1, t))) / 3) * 100);
export const pct = (p: number) => (p >= 0.1 ? `${Math.round(p * 100)}%` : p >= 0.01 ? `${(p * 100).toFixed(1)}%` : `${(p * 100).toFixed(2)}%`);

export function Sensitivity({ threshold, onInput, onChange, count, label = 'Sensitivity' }: { threshold: number; onInput: (t: number) => void; onChange?: (t: number) => void; count?: string; label?: string }) {
  const read = (e: Event) => toThreshold(+(e.target as HTMLInputElement).value);
  return (
    <label class="sensitivity" title={`A place matches when the model is at least ${pct(threshold)} sure`}>
      <span class="sensitivity-label">{label}</span>
      <span class="sensitivity-end">Fewer</span>
      <input type="range" min={0} max={100} step={1} value={toSlider(threshold)} aria-label={label} aria-valuetext={`${pct(threshold)} or more`} onInput={(e) => onInput(read(e))} onChange={(e) => onChange?.(read(e))} />
      <span class="sensitivity-end">More</span>
      {count && <span class="sensitivity-count">{count}</span>}
    </label>
  );
}
