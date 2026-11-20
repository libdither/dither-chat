/**
 * Talking to the hub's /api/approvals (docs/approvals.md), and checking an answer against keys the caller trusts.
 * Used by dither-ask and the review watcher.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { checkSigned, cleanTitle, type DeviceKey, displayHash, type Kind, parseKeys, sha256hex } from './statement.ts';

export interface ActionSpec {
  id: string;
  label?: string;
  needs: 'signed' | 'any';
}

/** The hub's view of a request (packages/hub/src/approvals.ts ApprovalView), as much as callers read. */
export interface RequestView {
  id: string;
  kind: Kind;
  asker: string;
  title: string;
  body: string;
  payload: string;
  actions: ActionSpec[];
  topic: string | null;
  created: number;
  expires: number;
  state: 'waiting' | 'answered' | 'expired' | 'cancelled' | 'sent';
  action: string | null;
  message: string | null;
  signed: boolean;
  device: { id: string; name: string; kind: string } | null;
  via: 'device' | 'page' | null;
  statement: string | null;
  signature: string | null;
  cancelReason: string | null;
  ask: string;
}

export class HubError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export const expandHome = (p: string) => (p.startsWith('~/') ? `${homedir()}${p.slice(1)}` : p);

export class Hub {
  constructor(
    public url: string,
    private token: string,
  ) {}

  static from(o: { url?: string; tokenFile?: string }): Hub {
    const url = (o.url ?? process.env.DITHER_ASK_URL ?? '').replace(/\/+$/, '');
    if (!url) throw new HubError('no hub: pass --url or set DITHER_ASK_URL', 0);
    const file = o.tokenFile ?? process.env.DITHER_ASK_TOKEN_FILE;
    if (!file) throw new HubError('no token: pass --token-file or set DITHER_ASK_TOKEN_FILE', 0);
    let token: string;
    try {
      token = readFileSync(expandHome(file), 'utf8').trim();
    } catch (e) {
      throw new HubError(`cannot read the token file: ${(e as Error).message}`, 0);
    }
    return new Hub(url, token);
  }

  async call<T>(method: string, path: string, body?: unknown, timeoutMs = 90_000): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${this.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new HubError(`the hub at ${this.url} cannot be reached: ${(e as Error).message}`, 0);
    }
    const text = await r.text();
    let j: any = null;
    try {
      j = JSON.parse(text);
    } catch {}
    if (!r.ok) throw new HubError(j?.error ?? `HTTP ${r.status}: ${text.slice(0, 200)}`, r.status);
    return (j ?? text) as T;
  }

  text(path: string): Promise<string> {
    return this.call<string>('GET', path);
  }

  create(b: { kind: Kind; title: string; body?: string; payload?: string; actions?: ActionSpec[]; urgency?: string; expiresIn?: number; topic?: string; asker?: string }): Promise<RequestView> {
    return this.call('POST', '/api/approvals', b);
  }

  get(id: string, wait = 0): Promise<RequestView> {
    return this.call('GET', `/api/approvals/${id}${wait > 0 ? `?wait=${Math.min(60, Math.ceil(wait))}` : ''}`);
  }

  /** Until it is no longer waiting, or `seconds` pass. */
  async wait(id: string, seconds: number): Promise<RequestView> {
    const end = Date.now() + seconds * 1000;
    let v = await this.get(id);
    while (v.state === 'waiting' && Date.now() < end) v = await this.get(id, Math.max(1, (end - Date.now()) / 1000));
    return v;
  }

  cancel(id: string, reason?: string): Promise<RequestView> {
    return this.call('POST', `/api/approvals/${id}/cancel`, reason ? { reason } : {});
  }

  byTopic(topic: string): Promise<{ items: RequestView[] }> {
    return this.call('GET', `/api/approvals?topic=${encodeURIComponent(topic)}`);
  }
}

export function readKeys(file: string): DeviceKey[] {
  const k = parseKeys(readFileSync(expandHome(file), 'utf8'));
  if (typeof k === 'string') throw new HubError(`the keys file: ${k}`, 0);
  return k;
}

/**
 * Whether an answer holds up against keys the caller trusts, for the request the caller made: the statement is signed
 * by one of those keys, for this id, kind, payload and what was shown, and with the action answered. An unsigned answer
 * holds only for an action the caller itself said needs no signature.
 */
export async function verifyAnswer(v: RequestView, keys: DeviceKey[], expect: { kind?: Kind; title?: string; body?: string; payload?: string; actions?: ActionSpec[] }): Promise<{ ok: boolean; reason?: string }> {
  if (v.state !== 'answered' || !v.action) return { ok: false, reason: `it is ${v.state}` };
  const spec = (expect.actions ?? v.actions).find((a) => a.id === v.action);
  if (v.action === 'deny') return { ok: true };
  if (!v.statement || !v.signature) return spec?.needs === 'any' && expect.actions ? { ok: true } : { ok: false, reason: `${v.action} came without a device's signature` };
  const payload = expect.payload ?? v.payload;
  const c = await checkSigned(v.statement, v.signature, keys, { payload, kind: expect.kind ?? v.kind });
  if (!c.ok) return { ok: false, reason: c.reason };
  const s = c.statement!;
  if (s.id !== v.id) return { ok: false, reason: 'signed for another request' };
  if (s.action !== v.action) return { ok: false, reason: 'the signed action is not the answer' };
  if (sha256hex(v.message ?? '') !== s.messageSha256) return { ok: false, reason: 'the message is not the one signed' };
  const title = expect.title !== undefined ? cleanTitle(expect.title) : v.title;
  if (displayHash(title, expect.body !== undefined ? expect.body.replace(/\r\n/g, '\n') : v.body) !== s.displaySha256) return { ok: false, reason: 'what the device showed is not this request' };
  return { ok: true };
}

