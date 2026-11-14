/**
 * Translating what people wrote (docs/translate.md). Two providers behind one call:
 *
 * - **network**: a network that translates its own posts (capability 'translate', the `translate` command; X: the
 *   "Translate post" link's call, which X answers with Grok, Google or Papago). Only for a post of that network.
 * - **server**: a LibreTranslate-compatible server the owner runs (POST <url>/translate {q, source, target, format}),
 *   so a local model can stand in for any network, or translate what no network will.
 *
 * Settings say which comes first; the other is the fallback. What was translated is kept in memory (a text and its
 * target), so a thread opened again, or a post in two places, is asked once. Nothing is written to the database.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, TRANSLATE_DEFAULTS } from '@dither-chat/protocol';
import type { Store } from './store.ts';

type Row = Record<string, any>;

export interface TranslateDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: { t: 'translate'; post: string; to: string; lang?: string }, timeoutMs?: number) => Promise<T>;
  /** The server's fetch (a test's fake). */
  fetch?: typeof fetch;
}

export class TranslateError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** At most this many texts in one call, each at most this long. */
export const TRANSLATE_MAX_ITEMS = 40;
export const TRANSLATE_MAX_TEXT = 5000;
/** Translations kept, the oldest dropped first. */
const KEEP = 4000;
/** How many a call translates at once (a network's own call is one post each). */
const AT_ONCE = 3;
const NETWORK_TIMEOUT_MS = 45_000;
const SERVER_TIMEOUT_MS = 30_000;

const caps = (store: Store, accountId: string): P.Capability[] => JSON.parse(store.account(accountId)?.capabilities ?? '[]');

/** A server URL as the owner may give it: http or https, no credentials, no query. Null: not one. */
export function serverUrlOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search) return null;
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export class Translator {
  private kept = new Map<string, P.Translation>();
  private flying = new Map<string, Promise<P.Translation>>();
  constructor(private d: TranslateDeps) {}

  settings(): P.TranslateSettings {
    return { ...TRANSLATE_DEFAULTS, ...(this.d.store.metaValue<Partial<P.TranslateSettings>>('translate') ?? {}) };
  }

  /** Change some settings; checks each. Returns them as they now stand. */
  setSettings(b: Record<string, unknown>): P.TranslateSettings {
    const now = this.settings();
    if ('auto' in b) now.auto = b.auto === true;
    if ('to' in b) {
      if (typeof b.to !== 'string' || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(b.to)) throw new TranslateError('to: a language tag, like en or pt-BR');
      now.to = b.to;
    }
    if ('show' in b) {
      if (b.show !== 'below' && b.show !== 'replace') throw new TranslateError('show: below or replace');
      now.show = b.show;
    }
    if ('provider' in b) {
      if (b.provider !== 'network' && b.provider !== 'server') throw new TranslateError('provider: network or server');
      now.provider = b.provider;
    }
    if ('serverUrl' in b) {
      if (b.serverUrl === null || b.serverUrl === '') now.serverUrl = null;
      else if (!(now.serverUrl = serverUrlOf(b.serverUrl))) throw new TranslateError('serverUrl: an http or https address, like http://127.0.0.1:5000');
    }
    const was = this.settings();
    this.d.store.setMetaValue('translate', now);
    // Another server, target or order: what was kept may not be what it would say.
    if (was.to !== now.to || was.provider !== now.provider || was.serverUrl !== now.serverUrl) this.kept.clear();
    return now;
  }

  /** Which networks can translate their own posts now (for the page: where "Translate post" is offered). */
  networks(): P.Network[] {
    const s = this.d.store;
    const rows = s.db.query('SELECT id, network FROM account WHERE enabled = 1').all() as Row[];
    return [...new Set(rows.filter((r) => this.d.online(r.id) && caps(s, r.id).includes('translate')).map((r) => r.network as P.Network))];
  }

  /** Translate each item into `to` (the settings' when absent), by the provider the settings put first. */
  async translate(items: unknown, to?: unknown): Promise<P.TranslateResult> {
    if (!Array.isArray(items) || !items.length) throw new TranslateError('items: what to translate');
    if (items.length > TRANSLATE_MAX_ITEMS) throw new TranslateError(`at most ${TRANSLATE_MAX_ITEMS} at once`);
    const set = this.settings();
    const target = to === undefined ? set.to : typeof to === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(to) ? to : null;
    if (!target) throw new TranslateError('to: a language tag');
    const clean: P.TranslateItem[] = [];
    for (const i of items as Record<string, unknown>[]) {
      if (!i || typeof i.key !== 'string' || !i.key || i.key.length > 200 || typeof i.text !== 'string') throw new TranslateError('each item: a key and its text');
      if (i.text.length > TRANSLATE_MAX_TEXT) throw new TranslateError(`a text of at most ${TRANSLATE_MAX_TEXT} characters`);
      const network = typeof i.network === 'string' && i.network in NETWORK_META ? (i.network as P.Network) : undefined;
      const post = typeof i.post === 'string' && /^[\w-]{1,40}$/.test(i.post) ? i.post : undefined;
      clean.push({ key: i.key, text: i.text, ...(typeof i.lang === 'string' && i.lang.length <= 20 ? { lang: i.lang } : {}), ...(network ? { network } : {}), ...(post ? { post } : {}) });
    }
    const out: P.TranslateResult = { translations: [], failed: [] };
    let next = 0;
    const work = async () => {
      while (next < clean.length) {
        const item = clean[next++]!;
        try {
          out.translations.push({ ...(await this.one(item, target, set)), key: item.key });
        } catch (e) {
          out.failed.push({ key: item.key, why: (e as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, clean.length) }, work));
    return out;
  }

  private async one(item: P.TranslateItem, to: string, set: P.TranslateSettings): Promise<P.Translation> {
    if (!item.text.trim()) return { key: item.key, text: '', by: '' };
    const id = `${to}\0${item.network ?? ''}\0${item.post ?? ''}\0${Bun.hash(item.text).toString(36)}`;
    const had = this.kept.get(id);
    if (had) return had;
    const going = this.flying.get(id);
    if (going) return going;
    const p = this.fresh(item, to, set).then(
      (t) => {
        this.flying.delete(id);
        this.kept.set(id, t);
        if (this.kept.size > KEEP) this.kept.delete(this.kept.keys().next().value!);
        return t;
      },
      (e) => {
        this.flying.delete(id);
        throw e;
      },
    );
    this.flying.set(id, p);
    return p;
  }

  private async fresh(item: P.TranslateItem, to: string, set: P.TranslateSettings): Promise<P.Translation> {
    const account = item.network && item.post ? this.accountFor(item.network) : null;
    const order: ('network' | 'server')[] = set.provider === 'server' ? ['server', 'network'] : ['network', 'server'];
    const whys: string[] = [];
    for (const how of order) {
      if (how === 'network') {
        if (!account) continue;
        try {
          const r = await this.d.command<P.NetworkTranslation>(account, { t: 'translate', post: item.post!, to, ...(item.lang ? { lang: item.lang } : {}) }, NETWORK_TIMEOUT_MS);
          if (!r || typeof r.text !== 'string') throw new Error('no translation came back');
          const net = NETWORK_META[item.network!].name;
          return { key: item.key, text: r.text, ...(r.from ? { from: r.from } : item.lang ? { from: item.lang } : {}), by: r.by && r.by !== net ? `${r.by} via ${net}` : net };
        } catch (e) {
          whys.push(`${NETWORK_META[item.network!].name}: ${(e as Error).message}`);
        }
      } else if (set.serverUrl) {
        try {
          return { ...(await this.server(set.serverUrl, item, to)), key: item.key };
        } catch (e) {
          whys.push(`the translation server: ${(e as Error).message}`);
        }
      }
    }
    throw new Error(whys.length ? whys.join('; ') : item.network && item.post ? `${NETWORK_META[item.network].name} cannot translate here, and no translation server is set` : 'no translation server is set');
  }

  private accountFor(network: P.Network): string | null {
    const s = this.d.store;
    const rows = s.db.query('SELECT id FROM account WHERE network = ? AND enabled = 1 ORDER BY created_at').all(network) as Row[];
    return rows.map((r) => r.id as string).find((a) => this.d.online(a) && caps(s, a).includes('translate')) ?? null;
  }

  /** A LibreTranslate-compatible server: {translatedText, detectedLanguage?: {language}}. */
  private async server(url: string, item: P.TranslateItem, to: string): Promise<Omit<P.Translation, 'key'>> {
    const f = this.d.fetch ?? fetch;
    const res = await f(`${url}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: item.text, source: item.lang && !/^(und|zxx|q)/.test(item.lang) ? item.lang.split('-')[0] : 'auto', target: to.split('-')[0], format: 'text' }),
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
      redirect: 'error',
    });
    const body = (await res.json().catch(() => null)) as { translatedText?: unknown; detectedLanguage?: { language?: unknown }; error?: unknown } | null;
    if (!res.ok || typeof body?.translatedText !== 'string') throw new Error(typeof body?.error === 'string' ? body.error : `it answered ${res.status}`);
    const from = typeof body.detectedLanguage?.language === 'string' ? body.detectedLanguage.language : item.lang;
    return { text: body.translatedText, ...(from ? { from } : {}), by: 'Translation server' };
  }
}
