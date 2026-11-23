/**
 * Components that render again only when their props change (docs/perf.md). Updates replace the objects they show,
 * never change them in place, so the same object is the same thing; what else they show (names, settings) they read
 * from `metaRev` themselves.
 */
import { Component, createElement, type FunctionComponent } from 'preact';

/** The same props: each value the same, an array the same items. */
export function sameProps(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (k === 'children' || !Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

/** `c`, rendered again when its parent renders only if `same` says the props differ. Its own signals still render it. */
export function memo<P extends object>(c: FunctionComponent<P>, same: (a: P, b: P) => boolean = sameProps as any): FunctionComponent<P> {
  class Memo extends Component<P> {
    shouldComponentUpdate(next: P) {
      return !same(this.props as P, next);
    }
    render() {
      return createElement(c as any, this.props);
    }
  }
  (Memo as any).displayName = `Memo(${c.displayName ?? c.name})`;
  return Memo as unknown as FunctionComponent<P>;
}

/**
 * `c`, drawn again only when what it shows changes, as `look` says in a string: when its parent draws, or when a
 * signal `look` reads moves (it is read while drawing, so the component follows it). For what a parent hands new
 * objects each time (`{ person: id }`) and what reads more than its props (a status dot, a picture from a name).
 */
export function memoOn<P extends object>(c: FunctionComponent<P>, look: (p: P) => string): FunctionComponent<P> {
  class MemoOn extends Component<P> {
    private drawn = '';
    shouldComponentUpdate(next: P) {
      return look(next) !== this.drawn;
    }
    render() {
      this.drawn = look(this.props as P);
      return createElement(c as any, this.props);
    }
  }
  (MemoOn as any).displayName = `Memo(${c.displayName ?? c.name})`;
  return MemoOn as unknown as FunctionComponent<P>;
}
