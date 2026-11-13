/**
 * Bots and apps (docs/apps.md), the chunk loaded when one is wanted (lazy.tsx): the composer's slash commands, the
 * forms bots open, and a message's Apps. Every run and every form goes from one click or Enter of the owner's, once.
 *
 * Slash commands: a body starting with "/" lists the commands the account has there (asked of the hub once per place,
 * as the network's client loads its own index once). Arrows and Enter or Tab pick one, or a tap; its options show as
 * fields over the box, and the composer's send (Enter, or its button on a phone) runs it instead of sending the text.
 * A body that names no picked command is sent as text, as ever.
 */
import type * as P from '@dither-chat/protocol';
import { commandProblem, modalProblem, MODAL_TEXT_MAX, MODAL_TTL_MS } from '@dither-chat/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { appsFor, claimSends, closeForm, commandsOf, forms, interactions, picksOf, run, sendForm, stateWords } from '../../apps.ts';
import { renderMarkdown } from '../../markdown.ts';
import { phone } from '../../phone.ts';
import { api, db, toast } from '../../state.ts';
import { Modal } from '../bits.tsx';
import { Icon } from '../icons.tsx';
import './apps.css';

/** Suggestions and picks wait this long after the last key, as the network's client waits before asking. */
const DEBOUNCE_MS = 300;
const SHOWN = 8;

/** Replaces [start, end) of the box the way typing would, so the composer hears it. */
function replaceRange(el: HTMLTextAreaElement, start: number, end: number, text: string) {
  el.focus();
  el.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
}

/** Says what came of a command once it is known, if it went wrong: a reply or a form shows itself. */
function watch(nonce: string, label: string) {
  const stop = interactions.subscribe((m) => {
    const v = m.get(nonce);
    if (!v || v.state === 'sending') return;
    queueMicrotask(stop);
    if (v.state === 'failed' || v.state === 'timedOut') toast({ kind: 'error', title: label, body: stateWords(v) });
  });
}

// ------------------------------------------------------------------ fields

type Value = string | number | boolean | undefined;

/** Picking a person, role or channel the hub knows here, or typing a name the network resolves. */
function PickField({ convId, select, value, label, onChange, id }: { convId: string; select: 'user' | 'role' | 'channel' | 'mentionable'; value: string; label: string; onChange: (value: string, label: string) => void; id?: string }) {
  const [q, setQ] = useState(label);
  const [list, setList] = useState<P.AppPickView[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => setQ(label), [label]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void picksOf(convId, select, q.startsWith('@') || q.startsWith('#') ? q.slice(1) : q).then(setList, () => setList([])), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, open]);
  return (
    <div class="ac-pick">
      <input
        id={id}
        type="search"
        value={q}
        placeholder={select === 'channel' ? '#channel' : select === 'role' ? '@role' : '@name'}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          setQ(v);
          // A typed name goes as it is; the network's own client resolves it.
          onChange(v, v);
        }}
      />
      {open && list.length > 0 && (
        <ul class="ac-pick-list" role="listbox">
          {list.map((p) => (
            <li>
              <button
                type="button"
                role="option"
                aria-selected={p.value === value}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(p.value, p.kind === 'channel' ? `#${p.name}` : `@${p.name}`);
                  setOpen(false);
                }}
              >
                <span style={p.color ? { color: p.color } : undefined}>{p.kind === 'channel' ? '#' : '@'}</span>
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One option of a command: its field, with the app's suggestions where it has them. */
function OptionField({ convId, cmd, o, value, label, onChange, all, accountId }: { convId: string; cmd: P.AppCommandFact; o: P.AppOptionFact; value: Value; label?: string; onChange: (v: Value, label?: string) => void; all: Record<string, Value>; accountId?: string }) {
  const [suggest, setSuggest] = useState<P.AppChoiceFact[] | null>(null);
  const [typed, setTyped] = useState(label ?? (value === undefined ? '' : String(value)));
  const id = `ac-opt-${o.name}`;
  useEffect(() => {
    if (!o.autocomplete) return;
    const t = setTimeout(() => {
      const options = Object.entries(all)
        .filter(([k, v]) => k !== o.name && v !== undefined && v !== '')
        .map(([name, v]) => ({ name, value: v }));
      void api<P.AppAutocompleteResult>(`/api/conversations/${convId}/apps/autocomplete`, { body: { command: cmd.id, app: cmd.app, focused: o.name, query: typed, options, ...(accountId ? { accountId } : {}) } }).then(
        (r) => setSuggest(r.choices),
        () => setSuggest(null),
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed]);
  const head = (
    <label for={id}>
      {o.name}
      {o.required && <b class="ac-req"> *</b>}
      {o.description && <small>{o.description}</small>}
    </label>
  );
  let field;
  if (o.type === 'attachment') field = <p class="ac-note">Files are given on the network: run this command there.</p>;
  else if (o.choices?.length)
    field = (
      <select id={id} value={value === undefined ? '' : String(value)} onChange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        const c = o.choices!.find((x) => String(x.value) === v);
        onChange(c ? c.value : undefined);
      }}>
        <option value="">{o.required ? 'Choose…' : '(none)'}</option>
        {o.choices.map((c) => (
          <option value={String(c.value)}>{c.name}</option>
        ))}
      </select>
    );
  else if (o.type === 'boolean')
    field = (
      <select id={id} value={value === undefined ? '' : value ? 'yes' : 'no'} onChange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        onChange(v === '' ? undefined : v === 'yes');
      }}>
        <option value="">{o.required ? 'Choose…' : '(none)'}</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  else if (o.type === 'user' || o.type === 'role' || o.type === 'channel' || o.type === 'mentionable') field = <PickField id={id} convId={convId} select={o.type} value={typeof value === 'string' ? value : ''} label={label ?? ''} onChange={(v, l) => onChange(v || undefined, l)} />;
  else
    field = (
      <>
        {o.type === 'string' ? (
          <input
            id={id}
            type="text"
            maxLength={o.maxLength}
            value={typed}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              setTyped(v);
              onChange(v === '' ? undefined : v);
            }}
          />
        ) : (
          <input
            id={id}
            type="number"
            inputMode={o.type === 'integer' ? 'numeric' : 'decimal'}
            step={o.type === 'integer' ? 1 : 'any'}
            min={o.min}
            max={o.max}
            value={typed}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              setTyped(v);
              onChange(v === '' ? undefined : Number(v));
            }}
          />
        )}
        {o.autocomplete && suggest && suggest.length > 0 && (
          <ul class="ac-pick-list inline" role="listbox">
            {suggest.map((c) => (
              <li>
                <button type="button" role="option" aria-selected={c.value === value} onClick={() => {
                  setTyped(c.name);
                  onChange(c.value, c.name);
                  setSuggest(null);
                }}>
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  return (
    <div class="ac-field">
      {head}
      {field}
    </div>
  );
}

// ------------------------------------------------------------------ the composer's slash commands

export function SlashCommands({ ta, convId, accountId, text }: { ta: { current: HTMLTextAreaElement | null }; convId: string; accountId?: string; text: string }) {
  const [view, setView] = useState<P.AppCommandsView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [picked, setPicked] = useState<P.AppCommandFact | null>(null);
  const [values, setValues] = useState<Record<string, Value>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setView(null);
    setFailed(null);
    setPicked(null);
    commandsOf(convId, 'chat', accountId).then(setView, (e) => setFailed((e as Error).message));
  }, [convId, accountId]);

  // Picked, the body is "/name …"; editing the name away puts the command down.
  useEffect(() => {
    if (picked && !(text === `/${picked.name}` || text.startsWith(`/${picked.name} `))) {
      setPicked(null);
      setValues({});
      setLabels({});
      setProblem(null);
    }
  }, [text]);

  const query = text.slice(1).toLowerCase();
  const matches = useMemo(() => {
    if (!view || picked || text.includes('\n')) return [];
    const all = view.commands;
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(query));
    const inner = query ? all.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(query)) : [];
    return [...starts, ...inner].slice(0, SHOWN);
  }, [view, query, picked]);
  const listOpen = !picked && dismissed !== text && matches.length > 0;
  const appOf = (id: string) => view?.apps.find((a) => a.id === id);

  const pick = (c: P.AppCommandFact) => {
    const el = ta.current;
    if (!el) return;
    setPicked(c);
    setValues({});
    setLabels({});
    setProblem(null);
    replaceRange(el, 0, el.value.length, `/${c.name} `);
  };

  /** The values as sent: the words typed after the command fill its first option when that field is empty. */
  const given = (): { name: string; value: string | number | boolean }[] => {
    if (!picked) return [];
    const rest = text.slice(picked.name.length + 1).trim();
    const v = { ...values };
    const first = picked.options[0];
    if (rest && first && v[first.name] === undefined && first.type === 'string' && !first.choices?.length) v[first.name] = rest;
    return Object.entries(v)
      .filter(([, x]) => x !== undefined && x !== '')
      .map(([name, value]) => ({ name, value: value as string | number | boolean }));
  };

  const go = async (): Promise<void> => {
    if (!picked || busy) return;
    const opts = given();
    const p = commandProblem(picked, opts);
    if (p) return setProblem(p);
    setBusy(true);
    setProblem(null);
    try {
      const nonce = await run(convId, { kind: 'command', command: picked.id, app: picked.app, options: opts }, accountId);
      watch(nonce, `/${picked.name}`);
      const el = ta.current;
      if (el) replaceRange(el, 0, el.value.length, '');
      setPicked(null);
      setValues({});
      setLabels({});
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // The composer's send runs a picked command (Enter, or the send button on a phone).
  const live = useRef({ picked, go });
  live.current = { picked, go };
  useEffect(() => {
    claimSends(convId, () => {
      if (!live.current.picked) return false;
      void live.current.go();
      return true;
    });
    return () => claimSends(convId, null);
  }, [convId]);

  // The list's keys, ahead of the composer's own (as the emoji list takes them).
  const keys = useRef({ listOpen, matches, sel, pick, picked });
  keys.current = { listOpen, matches, sel, pick, picked };
  useEffect(() => {
    const el = ta.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const onKey = (e: KeyboardEvent) => {
      const s = keys.current;
      if (e.isComposing || e.target !== el) return;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (s.listOpen) {
        const n = s.matches.length;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          stop();
          setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        } else if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
          stop();
          s.pick(s.matches[Math.min(s.sel, n - 1)]);
        } else if (e.key === 'Escape') {
          stop();
          setDismissed(el.value);
        }
      } else if (s.picked && e.key === 'Escape') {
        stop();
        setPicked(null);
      }
    };
    box.addEventListener('keydown', onKey, true);
    return () => box.removeEventListener('keydown', onKey, true);
  }, [ta.current, convId]);
  useEffect(() => setSel(0), [query]);

  if (failed && text === '/') return <div class="ec-pop ac-pop"><p class="ac-note">Commands could not be listed: {failed}</p></div>;
  if (view?.reason && text === '/') return <div class="ec-pop ac-pop"><p class="ac-note">{view.reason}</p></div>;
  if (listOpen)
    return (
      <div class="ec-pop ac-pop" role="listbox" aria-label="Commands" onMouseDown={(e) => e.preventDefault()}>
        <div class="ec-head">Commands {query && <b>/{query}</b>}</div>
        {matches.map((c, i) => (
          <button class={`ec-opt ac-cmd ${i === sel ? 'on' : ''}`} role="option" aria-selected={i === sel} tabIndex={-1} onMouseMove={() => i !== sel && setSel(i)} onClick={() => pick(c)} data-track="slash command (pick)">
            <span class="ac-name">/{c.name}</span>
            <span class="ac-desc">{c.description}</span>
            <span class="ac-app">{appOf(c.app)?.name}</span>
          </button>
        ))}
      </div>
    );
  if (!picked) return null;
  const app = appOf(picked.app);
  return (
    <div class="ec-pop ac-pop ac-panel" data-track-area="slash command">
      <div class="ac-title">
        <b>/{picked.name}</b>
        <span>{picked.description}</span>
        {app && <small>{app.name}</small>}
        <button class="icon-btn small" aria-label="Put the command down" onClick={() => setPicked(null)}>
          <Icon name="x" size={13} />
        </button>
      </div>
      {picked.options.map((o) => (
        <OptionField
          convId={convId}
          cmd={picked}
          o={o}
          all={values}
          accountId={accountId}
          value={values[o.name]}
          label={labels[o.name]}
          onChange={(v, l) => {
            setValues((x) => ({ ...x, [o.name]: v }));
            if (l !== undefined) setLabels((x) => ({ ...x, [o.name]: l }));
          }}
        />
      ))}
      {problem && <p class="ac-problem">{problem}</p>}
      <div class="ac-actions">
        <small>{phone.value ? 'The send button runs it' : 'Enter runs it · Esc puts it down'}</small>
        <button class="btn primary small" disabled={busy} onClick={() => void go()} data-track="slash command (run)">
          Run
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ forms

function FormField({ f, conv, value, set }: { f: P.ModalFieldFact; conv: P.AppModalView; value: P.ModalValue | undefined; set: (v: P.ModalValue) => void }) {
  if (f.kind === 'display') return <div class="ac-display" dangerouslySetInnerHTML={{ __html: renderMarkdown(f.text, { network: conv.network, user: () => null, room: () => null }) }} />;
  const id = `ac-form-${f.id}`;
  const head = (
    <label for={id}>
      {f.label ?? f.id}
      {'required' in f && f.required && <b class="ac-req"> *</b>}
      {f.description && <small>{f.description}</small>}
    </label>
  );
  let field;
  switch (f.kind) {
    case 'text':
      field =
        f.style === 'paragraph' ? (
          <textarea id={id} rows={4} placeholder={f.placeholder} maxLength={Math.min(f.maxLength ?? MODAL_TEXT_MAX, MODAL_TEXT_MAX)} value={value?.value ?? ''} onInput={(e) => set({ field: f.id, value: (e.target as HTMLTextAreaElement).value })} />
        ) : (
          <input id={id} type="text" placeholder={f.placeholder} maxLength={Math.min(f.maxLength ?? MODAL_TEXT_MAX, MODAL_TEXT_MAX)} value={value?.value ?? ''} onInput={(e) => set({ field: f.id, value: (e.target as HTMLInputElement).value })} />
        );
      break;
    case 'select':
      if (f.select !== 'string') {
        const [v, l] = [value?.values?.[0] ?? '', (value as { label?: string } | undefined)?.label ?? ''];
        field = <PickField id={id} convId={conv.conversationId} select={f.select} value={v} label={l} onChange={(x, lbl) => set({ field: f.id, values: x ? [x] : [], label: lbl } as P.ModalValue)} />;
        break;
      }
      if ((f.max ?? 1) > 1) {
        field = (
          <div class="ac-checks" id={id}>
            {(f.options ?? []).map((o) => {
              const on = value?.values?.includes(o.value) ?? false;
              return (
                <label>
                  <input type="checkbox" checked={on} onChange={() => set({ field: f.id, values: on ? (value?.values ?? []).filter((x) => x !== o.value) : [...(value?.values ?? []), o.value] })} />
                  {o.label}
                  {o.description && <small>{o.description}</small>}
                </label>
              );
            })}
          </div>
        );
        break;
      }
      field = (
        <select id={id} value={value?.values?.[0] ?? ''} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          set({ field: f.id, values: v ? [v] : [] });
        }}>
          <option value="">{f.placeholder ?? 'Choose…'}</option>
          {(f.options ?? []).map((o) => (
            <option value={o.value}>{o.label}</option>
          ))}
        </select>
      );
      break;
    case 'radio':
      field = (
        <div class="ac-checks" id={id} role="radiogroup">
          {f.options.map((o) => (
            <label>
              <input type="radio" name={id} checked={value?.value === o.value} onChange={() => set({ field: f.id, value: o.value })} />
              {o.label}
              {o.description && <small>{o.description}</small>}
            </label>
          ))}
        </div>
      );
      break;
    case 'checkboxes':
      field = (
        <div class="ac-checks" id={id}>
          {f.options.map((o) => {
            const on = value?.values?.includes(o.value) ?? false;
            return (
              <label>
                <input type="checkbox" checked={on} onChange={() => set({ field: f.id, values: on ? (value?.values ?? []).filter((x) => x !== o.value) : [...(value?.values ?? []), o.value] })} />
                {o.label}
                {o.description && <small>{o.description}</small>}
              </label>
            );
          })}
        </div>
      );
      break;
    case 'checkbox':
      return (
        <label class="ac-field ac-check">
          <input type="checkbox" checked={value?.checked ?? false} onChange={(e) => set({ field: f.id, checked: (e.target as HTMLInputElement).checked })} />
          {f.label ?? f.id}
          {f.description && <small>{f.description}</small>}
        </label>
      );
    case 'file':
      field = <p class="ac-note">Files are given on the network: answer this form there{f.required ? '' : ', or send it without one'}.</p>;
      break;
  }
  return (
    <div class="ac-field">
      {head}
      {field}
    </div>
  );
}

/** A form a bot opened: its fields as it gave them, checked as they are filled in, sent once. */
function FormDialog({ f }: { f: P.AppModalView }) {
  const start = (): Record<string, P.ModalValue> => {
    const v: Record<string, P.ModalValue> = {};
    for (const x of f.fields) {
      if (x.kind === 'text' && x.value) v[x.id] = { field: x.id, value: x.value };
      if (x.kind === 'select' && x.select === 'string') {
        const d = (x.options ?? []).filter((o) => o.default).map((o) => o.value);
        if (d.length) v[x.id] = { field: x.id, values: d };
      }
      if (x.kind === 'checkbox' && x.default) v[x.id] = { field: x.id, checked: true };
    }
    return v;
  };
  const [values, setValues] = useState<Record<string, P.ModalValue>>(start);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const closed = Date.now() - f.at > MODAL_TTL_MS;
  const answers = () => Object.values(values).map(({ label: _l, ...v }: P.ModalValue & { label?: string }) => v);
  const problem = modalProblem(f.fields, answers());
  const conv = db.conversations.get(f.conversationId);
  const submit = async () => {
    if (problem || busy || closed) return setError(problem ?? (closed ? 'This form has closed' : null));
    setBusy(true);
    setError(null);
    try {
      const nonce = await sendForm(f, answers());
      watch(nonce, f.title);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 410) {
        closeForm(f);
        toast({ kind: 'error', title: f.title, body: err.message });
      } else setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={f.title} onClose={() => closeForm(f)}>
      <div class="ac-form">
        <p class="ac-from">
          {f.app.icon && <img src={f.app.icon} alt="" width={16} height={16} />}
          {f.app.name} asks{conv?.name ? <> in #{conv.name}</> : null}. What you send goes to the app.
        </p>
        {f.fields.map((x) => (
          <FormField f={x} conv={f} value={x.kind === 'display' ? undefined : values[x.id]} set={(v) => setValues((s) => ({ ...s, [v.field]: v }))} />
        ))}
        {(error || closed) && <p class="ac-problem">{closed ? 'This form has closed: do what opened it again.' : error}</p>}
        <div class="ac-actions">
          <button class="btn" onClick={() => closeForm(f)}>
            Cancel
          </button>
          <button class="btn primary" disabled={busy || closed || !!problem} title={problem ?? undefined} onClick={() => void submit()} data-track="bot form (send)">
            Send
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ a message's Apps

function MessageApps({ m }: { m: P.MessageView }) {
  const [view, setView] = useState<P.AppCommandsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    commandsOf(m.conversationId, 'message').then(setView, (e) => setError((e as Error).message));
  }, [m.id]);
  const close = () => (appsFor.value = null);
  const go = async (c: P.AppCommandFact) => {
    setBusy(true);
    try {
      const nonce = await run(m.conversationId, { kind: 'command', command: c.id, app: c.app, options: [], targetMessageId: m.id });
      watch(nonce, c.name);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Apps" onClose={close}>
      <div class="ac-apps">
        {error && <p class="ac-problem">{error}</p>}
        {!view && !error && <p class="ac-note">Asking the network…</p>}
        {view?.reason && <p class="ac-note">{view.reason}</p>}
        {view && !view.reason && !view.commands.length && <p class="ac-note">No app here has a command for messages.</p>}
        {view?.commands.map((c) => (
          <button class="ac-app-row" disabled={busy} onClick={() => void go(c)} data-track="message app (run)">
            <b>{c.name}</b>
            <small>{view.apps.find((a) => a.id === c.app)?.name}</small>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** The forms bots opened and a message's Apps, over everything. */
export function AppsHost() {
  const f = forms.value[0];
  const m = appsFor.value;
  return (
    <>
      {f && <FormDialog key={`${f.accountId}:${f.id}`} f={f} />}
      {m && !f && <MessageApps m={m} />}
    </>
  );
}
