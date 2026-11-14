/** @jsxRuntime classic */
/** @jsx h */
/**
 * Settings → Translation (docs/translate.md): whether posts in another language are translated by themselves, into
 * what, shown under the original or in its place, and who translates: the network's own (X) or a translation server
 * the owner runs (LibreTranslate's API: a local model can stand behind it), each the other's fallback.
 */
import { h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { languageName, NETWORK_META, TRANSLATE_TARGETS } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { api, loadTranslation, setTranslation, translation } from '../state.ts';

export function TranslateSettings() {
  useEffect(() => void loadTranslation(true), []);
  const tr = translation.value;
  const [url, setUrl] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!tr)
    return (
      <section class="set-block" id="set-translate">
        <h3>Translation</h3>
        <p class="set-help">Asking the hub…</p>
      </section>
    );
  const s = tr.settings;
  const change = (patch: Partial<P.TranslateSettings>) => {
    setSaid(null);
    setTranslation(patch).catch((e) => setSaid({ ok: false, text: (e as Error).message }));
  };
  const nets = tr.networks.map((n) => NETWORK_META[n].name);
  const typed = url ?? s.serverUrl ?? '';
  const saveUrl = () => {
    setSaid(null);
    setTranslation({ serverUrl: typed.trim() || null }).then(
      () => setUrl(null),
      (e) => setSaid({ ok: false, text: (e as Error).message }),
    );
  };
  // Asks the server itself (a text with no post goes to it alone).
  const test = () => {
    setBusy(true);
    setSaid(null);
    api<P.TranslateResult>('/api/translate', { method: 'POST', body: { items: [{ key: 'test', text: 'Bonjour, comment ça va ?', lang: 'fr' }] } }).then(
      (r) => {
        setBusy(false);
        const t = r.translations[0];
        setSaid(t ? { ok: true, text: `“Bonjour, comment ça va ?” → “${t.text}”` } : { ok: false, text: r.failed[0]?.why ?? 'no answer' });
      },
      (e) => (setBusy(false), setSaid({ ok: false, text: (e as Error).message })),
    );
  };
  return (
    <section class="set-block" id="set-translate">
      <h3>Translation</h3>
      <label class="toggle-row">
        <input type="checkbox" checked={s.auto} onChange={(e) => change({ auto: (e.target as HTMLInputElement).checked })} />
        <span>
          <b>Translate posts in other languages by themselves</b>
          <small>Where the network says a post is in another language and a translator can do it. Off: a Translate post link under it.</small>
        </span>
      </label>
      <div class="set-rule">
        <label class="set-rule-label" for="tr-to">
          Into
        </label>
        <select id="tr-to" class="select" value={s.to} onChange={(e) => change({ to: (e.target as HTMLSelectElement).value })}>
          {((TRANSLATE_TARGETS as readonly string[]).includes(s.to) ? TRANSLATE_TARGETS : [s.to, ...TRANSLATE_TARGETS]).map((l) => (
            <option value={l}>{languageName(l)}</option>
          ))}
        </select>
      </div>
      <div class="set-rule">
        <span class="set-rule-label">Show a translation</span>
        <div class="level-picker" role="radiogroup" aria-label="Show a translation">
          {(
            [
              ['below', 'Under the original'],
              ['replace', 'In its place'],
            ] as const
          ).map(([m, label]) => (
            <button role="radio" aria-checked={s.show === m} class={`chip-btn ${s.show === m ? 'on' : ''}`} onClick={() => change({ show: m })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p class="set-help">{s.show === 'below' ? 'The original stays, and the translation follows it, with Hide.' : 'The translation stands in for the text, with Show original to go back.'}</p>
      <div class="set-rule">
        <span class="set-rule-label">Who translates first</span>
        <div class="level-picker" role="radiogroup" aria-label="Who translates first">
          {(
            [
              ['network', "The network's own"],
              ['server', 'Your server'],
            ] as const
          ).map(([m, label]) => (
            <button role="radio" aria-checked={s.provider === m} class={`chip-btn ${s.provider === m ? 'on' : ''}`} onClick={() => change({ provider: m })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p class="set-help">
        {nets.length ? `${nets.join(' and ')} can translate ${nets.length > 1 ? 'their' : 'its'} own posts.` : 'No connected network translates its own posts right now.'} Each falls back on the
        other; a text that is no network's post goes to your server.
      </p>
      <div class="set-rule tr-server">
        <label class="set-rule-label" for="tr-url">
          Translation server
        </label>
        <input
          id="tr-url"
          class="input"
          type="url"
          inputMode="url"
          placeholder="http://127.0.0.1:5000"
          value={typed}
          onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && saveUrl()}
        />
        {url !== null && url !== (s.serverUrl ?? '') ? (
          <button class="btn" onClick={saveUrl}>
            Save
          </button>
        ) : (
          s.serverUrl && (
            <button class="btn" onClick={test} disabled={busy}>
              {busy ? 'Asking…' : 'Test'}
            </button>
          )
        )}
      </div>
      <p class="set-help">Any server with LibreTranslate's API (POST /translate): LibreTranslate itself, or a local model behind the same API. Empty: none.</p>
      {said && (
        <p class={`set-help ${said.ok ? '' : 'error-text'}`} role="status">
          {said.text}
        </p>
      )}
    </section>
  );
}
