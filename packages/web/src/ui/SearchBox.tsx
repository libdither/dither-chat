import type * as P from '@dither-chat/protocol';
import { NETWORKS, SEARCH_HAS, SEARCH_IS, SEARCH_OPS, SEARCH_SORT, searchValue } from '@dither-chat/protocol';
import type { ComponentChildren, Ref } from 'preact';
import { useState } from 'preact/hooks';
import { retention } from '../history.ts';
import { allCommunities, communitiesOf, convLabel, convTitle, netName, people, visibleConv } from '../model.ts';
import { db } from '../state.ts';
import { Avatar, NetBadge, NetGlyph } from './bits.tsx';
import { Icon } from './icons.tsx';
import { countAt } from '../clicklog.ts';

// ------------------------------------------------------------------ recent searches, on this device

const RECENT_KEY = 'dc.recentSearches';

export function recentSearches(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function rememberSearch(q: string) {
  q = q.trim();
  if (q) localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...recentSearches().filter((r) => r !== q)].slice(0, 8)));
}

export function forgetSearches() {
  localStorage.removeItem(RECENT_KEY);
}

/** A query as people read it: a chat named rather than its id. */
export function readableSearch(q: string): string {
  return q.replace(/(^|\s)in:(cnv_\S+)/g, (all, sp, id) => {
    const c = db.conversations.get(id);
    return c ? `${sp}in:${searchValue(convTitle(c))}` : all;
  });
}

// ------------------------------------------------------------------ suggestions

interface Suggestion {
  key: string;
  icon: ComponentChildren;
  label: string;
  sub?: string;
  /** What replaces the word being typed; ending in ":" keeps the list open for the value. */
  insert?: string;
  /** A whole query, run at once (a recent search). */
  run?: string;
}

/** The word the caret is in: an operator and what of its value is typed, or plain text. */
function wordAt(value: string, caret: number) {
  const head = value.slice(0, caret);
  const op = head.match(/(^|\s)(-?)(\w+):"([^"]*)$/) ?? head.match(/(^|\s)(-?)(\w+):(\S*)$/);
  if (op) return { start: head.length - op[0].length + op[1].length, op: op[3].toLowerCase(), neg: op[2], typed: op[4] };
  const w = head.match(/(^|\s)(\S*)$/)!;
  return { start: caret - w[2].length, op: null, neg: '', typed: w[2] };
}

const has = (s: string, typed: string) => s.toLowerCase().includes(typed.toLowerCase());
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function valuesFor(op: string, typed: string): Suggestion[] {
  const plain = (vals: readonly string[], sub?: (v: string) => string) => vals.filter((v) => has(v, typed)).map((v) => ({ key: v, icon: <Icon name="search" size={14} />, label: v, sub: sub?.(v), insert: v }));
  switch (op) {
    case 'from':
    case 'mentions': {
      const ps = people()
        .map((x) => x.person)
        .filter((p) => !p.isSelf && has(p.name, typed))
        .slice(0, 8)
        .map((p) => ({ key: p.id, icon: <Avatar id={p.id} name={p.name} url={p.avatar} size={22} />, label: p.name, sub: 'Person', insert: p.name }));
      return op === 'mentions' && has('me', typed) ? [{ key: 'me', icon: <Icon name="at" size={14} />, label: 'me', sub: 'Mentions of you', insert: 'me' }, ...ps] : ps;
    }
    case 'in': {
      const spaces = allCommunities()
        .filter((s) => has(s.name, typed))
        .slice(0, 4)
        .map((s) => ({ key: s.id, icon: <Avatar id={s.id} name={s.name} url={s.icon} size={22} square network={s.network} />, label: s.name, sub: `${netName(s.network)} community`, insert: s.name }));
      const convs = [...db.conversations.values()]
        .filter((c) => visibleConv(c) && c.shape !== 'thread' && has(convTitle(c), typed))
        .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
        .slice(0, 8 - spaces.length)
        // A direct chat has no name of its own to search by, and channel names repeat: the id is exact.
        .map((c) => ({ key: c.id, icon: <NetGlyph network={c.network} size={14} />, label: c.shape === 'direct' ? convTitle(c) : convLabel(c), sub: communitiesOf(c)[0]?.name ?? netName(c.network), insert: c.id }));
      return [...spaces, ...convs];
    }
    case 'has':
      return plain(SEARCH_HAS);
    case 'is':
      return plain(SEARCH_IS.filter((v) => v !== 'deleted' || (retention.value.adversarial && retention.value.show !== 'hidden')), (v) => (v === 'deleted' ? 'kept deleted and disappeared messages' : ''));
    case 'network':
      return NETWORKS.filter((n) => has(n, typed) || has(netName(n), typed)).map((n) => ({ key: n, icon: <NetBadge network={n} size={16} />, label: netName(n), insert: n }));
    case 'account':
      return [...db.accounts.values()]
        .filter((a) => has(a.label, typed) || has(netName(a.network), typed))
        .map((a) => ({ key: a.id, icon: <NetBadge network={a.network} size={16} />, label: a.label, sub: netName(a.network), insert: a.label }));
    case 'sort':
      return plain(SEARCH_SORT);
    case 'before':
    case 'after':
    case 'during': {
      const now = new Date();
      return plain(['today', 'yesterday', iso(now), iso(now).slice(0, 7)], (v) => (/^\d{4}-\d{2}$/.test(v) ? 'this month' : /^\d/.test(v) ? 'a day' : ''));
    }
  }
  return [];
}

function suggest(value: string, caret: number): { word: ReturnType<typeof wordAt>; items: Suggestion[]; pick: boolean } {
  const word = wordAt(value, caret);
  if (word.op) return { word, items: SEARCH_OPS.some((o) => o.op === word.op) ? valuesFor(word.op, word.typed) : [], pick: true };
  const ops = SEARCH_OPS.filter((o) => o.op.startsWith(word.typed.toLowerCase().replace(/^-/, ''))).map((o) => ({ key: o.op, icon: <Icon name="search" size={14} />, label: `${o.op}:`, sub: o.hint, insert: `${o.op}:` }));
  if (!value.trim()) return { word, items: [...recentSearches().map((r) => ({ key: 'r:' + r, icon: <Icon name="clock" size={14} />, label: readableSearch(r), run: r })), ...ops], pick: false };
  // A plain word suggests the operators it starts, until it is longer than they are.
  return { word, items: word.typed ? ops.slice(0, 4) : [], pick: false };
}

/**
 * The search box, with Discord's operator help: typing from:, in:, has: and the rest lists what may follow (people with
 * their pictures, chats, kinds), and an empty box lists recent searches. Up and Down choose, Tab or Enter takes.
 */
export function SearchBox({
  value,
  setValue,
  submit,
  placeholder,
  inputRef,
  onDown,
  ...rest
}: {
  value: string;
  setValue: (v: string) => void;
  submit: (q: string) => void;
  placeholder: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Down with no list open: into the results. */
  onDown?: () => void;
  class?: string;
  enterkeyhint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(value.length);
  const [sel, setSel] = useState(-1);
  const [, bump] = useState(0);
  const { word, items, pick } = open ? suggest(value, Math.min(caret, value.length)) : { word: null, items: [], pick: false };
  // A value being picked starts on the first; elsewhere Enter searches unless you chose.
  const cur = sel >= 0 ? sel : pick && word?.typed ? 0 : -1;
  const take = (s: Suggestion, input: HTMLInputElement) => {
    if (s.run) {
      setValue(s.run);
      setOpen(false);
      return submit(s.run);
    }
    const end = value.slice(caret).match(/^\S*/)![0].length + caret;
    const ins = word!.op ? `${word!.neg}${word!.op}:${searchValue(s.insert!)} ` : s.insert!;
    const next = value.slice(0, word!.start) + ins + value.slice(end).replace(/^\s+/, '');
    setValue(next);
    setSel(-1);
    const at = word!.start + ins.length;
    setCaret(at);
    requestAnimationFrame(() => input.setSelectionRange(at, at));
  };
  const track = (e: Event) => setCaret((e.target as HTMLInputElement).selectionStart ?? value.length);
  return (
    <form
      class={`search search-box ${rest.class ?? ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        setOpen(false);
        countAt(e.currentTarget as HTMLElement, 'search (Enter)');
        submit(value.trim());
      }}
    >
      <Icon name="search" size={15} />
      <input
        ref={inputRef}
        data-track="search"
        aria-label="Search"
        aria-autocomplete="list"
        aria-expanded={open && items.length > 0}
        placeholder={placeholder}
        enterkeyhint={(rest.enterkeyhint ?? 'search') as any}
        value={value}
        onFocus={(e) => (setOpen(true), track(e))}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onClick={track}
        onKeyUp={track}
        onInput={(e) => {
          setValue((e.target as HTMLInputElement).value);
          setOpen(true);
          setSel(-1);
          track(e);
        }}
        onKeyDown={(e) => {
          const input = e.target as HTMLInputElement;
          if (e.key === 'Escape' && open && items.length) return (e.preventDefault(), e.stopPropagation(), setOpen(false));
          if (e.key === 'ArrowDown' && (!open || !items.length)) return onDown && (e.preventDefault(), onDown());
          if (!open || !items.length) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = items.length;
            setSel(e.key === 'ArrowDown' ? (cur + 1) % n : cur <= 0 ? n - 1 : cur - 1);
          } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing && (cur >= 0 || (e.key === 'Tab' && pick))) {
            e.preventDefault();
            take(items[Math.max(cur, 0)], input);
          }
        }}
      />
      {open && items.length > 0 && (
        <div class="search-suggest" role="listbox" onMouseDown={(e) => e.preventDefault()}>
          {!value.trim() && recentSearches().length > 0 && (
            <div class="search-suggest-head">
              Recent
              <button
                type="button"
                class="link-btn"
                data-track="search (clear recent)"
                onClick={() => {
                  forgetSearches();
                  setSel(-1);
                  bump((n) => n + 1);
                }}
              >
                Clear
              </button>
            </div>
          )}
          {items.map((s, i) => (
            <button type="button" role="option" aria-selected={i === cur} data-track="search (suggestion)" class={`search-suggest-row ${i === cur ? 'active' : ''}`} onClick={(e) => take(s, (e.currentTarget as HTMLElement).closest('form')!.querySelector('input')!)}>
              <span class="search-suggest-icon">{s.icon}</span>
              <span class="search-suggest-label">{s.label}</span>
              {s.sub && <small>{s.sub}</small>}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
