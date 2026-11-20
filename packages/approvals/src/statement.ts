/**
 * The bytes a device signs (docs/approvals.md, "The statement"), the payloads, and checking a signature with nothing
 * but the device's public key. No I/O: the hub, the CLI, the verifier and the tests all use this.
 */
import { createHash } from 'node:crypto';

export const STATEMENT_V1 = 'dither-approval-v1';
export type Kind = 'alert' | 'rebuild' | 'deploy' | 'merge' | 'policy';
export const KINDS: readonly Kind[] = ['alert', 'rebuild', 'deploy', 'merge', 'policy'];

/** The asker's part of the statement. */
export interface Ask {
  id: string;
  kind: Kind;
  asker: string;
  created: number;
  expires: number;
  payloadSha256: string;
  displaySha256: string;
}

/** The device's part. */
export interface Answer {
  action: string;
  messageSha256: string;
  device: string;
  signed: number;
}

export type Statement = Ask & Answer;

export const ID_RE = /^apv_[A-Za-z0-9_-]{22}$/;
export const NAME_RE = /^[a-z0-9-]{1,32}$/;
export const DEVICE_RE = /^dev_[A-Za-z0-9_-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MS = /^(0|[1-9][0-9]{0,15})$/;

export const sha256hex = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
export const b64u = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');
export const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

export const newId = () => `apv_${b64u(crypto.getRandomValues(new Uint8Array(16)))}`;

/** A title as it is kept and hashed: one line, no control characters, at most 200 characters. */
export const cleanTitle = (t: string) => t.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
export const MAX_BODY = 32 * 1024;
export const MAX_PAYLOAD = 4 * 1024;
export const MAX_MESSAGE = 1000;

/** display-sha256: what the device showed, title and body. */
export const displayHash = (title: string, body: string) => sha256hex(`${title}\n\n${body}`);
export const messageHash = (message: string | null | undefined) => sha256hex(message ?? '');

export function askText(a: Ask): string {
  return [STATEMENT_V1, `id ${a.id}`, `kind ${a.kind}`, `asker ${a.asker}`, `created ${a.created}`, `expires ${a.expires}`, `payload-sha256 ${a.payloadSha256}`, `display-sha256 ${a.displaySha256}`].map((l) => `${l}\n`).join('');
}

export function statementText(s: Statement): string {
  return askText(s) + [`action ${s.action}`, `message-sha256 ${s.messageSha256}`, `device ${s.device}`, `signed ${s.signed}`].map((l) => `${l}\n`).join('');
}

/** The statement's fields, or why it isn't one. Exactly the v1 lines, in order, nothing else. */
export function parseStatement(text: string): Statement | string {
  if (!text.endsWith('\n')) return 'a statement ends with a newline';
  const lines = text.slice(0, -1).split('\n');
  const keys = ['id', 'kind', 'asker', 'created', 'expires', 'payload-sha256', 'display-sha256', 'action', 'message-sha256', 'device', 'signed'];
  if (lines[0] !== STATEMENT_V1) return `not a ${STATEMENT_V1} statement`;
  if (lines.length !== keys.length + 1) return 'a statement has exactly eleven fields';
  const v: Record<string, string> = {};
  for (let i = 0; i < keys.length; i++) {
    const line = lines[i + 1]!;
    const sp = line.indexOf(' ');
    if (sp < 0 || line.slice(0, sp) !== keys[i]) return `field ${i + 1} should be ${keys[i]}`;
    v[keys[i]!] = line.slice(sp + 1);
  }
  if (!ID_RE.test(v.id!)) return 'a bad id';
  if (!KINDS.includes(v.kind as Kind)) return 'an unknown kind';
  if (!NAME_RE.test(v.asker!)) return 'a bad asker';
  if (!NAME_RE.test(v.action!)) return 'a bad action';
  if (!DEVICE_RE.test(v.device!)) return 'a bad device';
  for (const k of ['payload-sha256', 'display-sha256', 'message-sha256']) if (!HEX64.test(v[k]!)) return `a bad ${k}`;
  for (const k of ['created', 'expires', 'signed']) if (!MS.test(v[k]!)) return `a bad ${k}`;
  const s: Statement = {
    id: v.id!,
    kind: v.kind as Kind,
    asker: v.asker!,
    created: Number(v.created),
    expires: Number(v.expires),
    payloadSha256: v['payload-sha256']!,
    displaySha256: v['display-sha256']!,
    action: v.action!,
    messageSha256: v['message-sha256']!,
    device: v.device!,
    signed: Number(v.signed),
  };
  // Round trip: one text per statement, so nothing can hide in the bytes.
  return statementText(s) === text ? s : 'not in canonical form';
}

// ------------------------------------------------------------------ payloads

/** A payload's lines: its format's name first, then `key value` lines (repeatable keys keep their order). */
export interface Payload {
  format: string;
  fields: [string, string][];
}

export function payloadText(p: Payload): string {
  return [p.format, ...p.fields.map(([k, v]) => `${k} ${v}`)].map((l) => `${l}\n`).join('');
}

export function parsePayload(text: string): Payload | string {
  if (text.length > MAX_PAYLOAD) return 'a payload is at most 4 KiB';
  if (!/^[\x20-\x7e\n]*$/.test(text)) return 'a payload is printable ASCII';
  if (!text.endsWith('\n')) return 'a payload ends with a newline';
  const lines = text.slice(0, -1).split('\n');
  const format = lines[0]!;
  if (!/^dither-[a-z]+-v[0-9]+$/.test(format)) return 'a payload starts with its format, like dither-merge-v1';
  const fields: [string, string][] = [];
  for (const l of lines.slice(1)) {
    const m = /^([a-z0-9-]+) (.+)$/.exec(l);
    if (!m) return `a bad payload line: ${l.slice(0, 60)}`;
    fields.push([m[1]!, m[2]!]);
  }
  return { format, fields };
}

export const one = (p: Payload, k: string) => {
  const all = p.fields.filter(([f]) => f === k);
  return all.length === 1 ? all[0]![1] : null;
};
export const many = (p: Payload, k: string) => p.fields.filter(([f]) => f === k).map(([, v]) => v);

const SHA1 = /^[0-9a-f]{40}$/;

export interface MergePayload {
  repo: string;
  target: string;
  branch: string;
  base: string;
  head: string;
  tree: string;
}

export function mergePayload(m: MergePayload): string {
  return payloadText({ format: 'dither-merge-v1', fields: [['repo', m.repo], ['target', m.target], ['branch', m.branch], ['base', m.base], ['head', m.head], ['tree', m.tree]] });
}

export function readMerge(p: Payload): MergePayload | string {
  if (p.format !== 'dither-merge-v1') return 'not a dither-merge-v1 payload';
  const keys = ['repo', 'target', 'branch', 'base', 'head', 'tree'] as const;
  if (p.fields.length !== keys.length || p.fields.some(([k], i) => k !== keys[i])) return 'a merge payload has repo, target, branch, base, head, tree';
  const m = Object.fromEntries(p.fields) as unknown as MergePayload;
  if (!SHA1.test(m.base) || !SHA1.test(m.head) || !SHA1.test(m.tree)) return 'base, head and tree are full commit and tree ids';
  return m;
}

export interface PolicyPayload {
  name: string;
  repo: string;
  target: string;
  paths: string[];
  lines: string[];
  maxLines: number;
}

export function policyPayload(p: PolicyPayload): string {
  return payloadText({
    format: 'dither-policy-v1',
    fields: [['name', p.name], ['repo', p.repo], ['target', p.target], ...p.paths.map((x): [string, string] => ['path', x]), ...p.lines.map((x): [string, string] => ['line', x]), ['max-lines', String(p.maxLines)]],
  });
}

export function readPolicy(p: Payload): PolicyPayload | string {
  if (p.format !== 'dither-policy-v1') return 'not a dither-policy-v1 payload';
  const name = one(p, 'name');
  const repo = one(p, 'repo');
  const target = one(p, 'target');
  const max = one(p, 'max-lines');
  const paths = many(p, 'path');
  const lines = many(p, 'line');
  if (!name || !NAME_RE.test(name) || !repo || !target || !max || !/^[1-9][0-9]{0,5}$/.test(max) || !paths.length || !lines.length) return 'a policy has name, repo, target, path…, line… and max-lines';
  if (p.fields.some(([k]) => !['name', 'repo', 'target', 'path', 'line', 'max-lines'].includes(k))) return 'a policy has only name, repo, target, path, line and max-lines';
  for (const l of lines)
    try {
      new RegExp(l);
    } catch {
      return `a policy line is not a regex: ${l.slice(0, 60)}`;
    }
  return { name, repo, target, paths, lines, maxLines: Number(max) };
}

// ------------------------------------------------------------------ signatures

/** A DER ECDSA signature as WebCrypto's raw r‖s (64 bytes for P-256), or null when it isn't one. */
export function rawSignature(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  let i = 2;
  const int = (): Uint8Array | null => {
    if (der[i] !== 0x02) return null;
    const len = der[i + 1]!;
    if (len < 1 || len > 33 || i + 2 + len > der.length) return null;
    let v = der.subarray(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) return null;
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = int();
  const s = int();
  if (!r || !s || i !== der.length) return null;
  const out = new Uint8Array(64);
  out.set(r);
  out.set(s, 32);
  return out;
}

/** A raw r‖s signature as DER (what devices send and trailers carry). */
export function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let v = b;
    while (v.length > 1 && v[0] === 0 && !(v[1]! & 0x80)) v = v.subarray(1);
    if (v[0]! & 0x80) v = Uint8Array.of(0, ...v);
    return Uint8Array.of(0x02, v.length, ...v);
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32, 64));
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
}

/** SHA-256 of an SPKI's bytes, the first 8 as colon-joined hex: the fingerprint a device shows. */
export const fingerprint = (spkiB64: string) => sha256hex(Buffer.from(spkiB64, 'base64')).slice(0, 16).match(/../g)!.join(':');

export async function importKey(spkiB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', Buffer.from(spkiB64, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

/** Whether `signature` (base64url DER) is the key's over `text`. */
export async function verifySignature(spkiB64: string, text: string, signature: string): Promise<boolean> {
  try {
    const raw = rawSignature(fromB64u(signature));
    if (!raw) return false;
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await importKey(spkiB64), raw as BufferSource, new TextEncoder().encode(text) as BufferSource);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ keys files

export interface DeviceKey {
  id: string;
  kind: string;
  key: string;
  fingerprint: string;
  name: string;
}

/** A keys file: `dev_… kind spki fingerprint name…` a line, `#` comments. A line whose fingerprint doesn't match its key is refused. */
export function parseKeys(text: string): DeviceKey[] | string {
  const out: DeviceKey[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [id, kind, key, fp, ...name] = line.split(/\s+/);
    if (!id || !DEVICE_RE.test(id) || !kind || !key || !fp) return `line ${i + 1}: want "dev_… kind key fingerprint name"`;
    if (fingerprint(key) !== fp) return `line ${i + 1}: the fingerprint doesn't match the key`;
    out.push({ id, kind, key, fingerprint: fp, name: name.join(' ') });
  }
  return out;
}

export const keysLine = (k: DeviceKey) => `${k.id} ${k.kind} ${k.key} ${k.fingerprint} ${k.name}`.trim();

export interface Checked {
  ok: boolean;
  statement?: Statement;
  device?: DeviceKey;
  reason?: string;
}

/**
 * A signed statement checked against `keys`: well formed, signed by the device it names with a key listed for it,
 * and (when given) for the payload and the request the caller expects.
 */
export async function checkSigned(text: string, signature: string, keys: DeviceKey[], expect: { payload?: string; ask?: Ask; kind?: Kind } = {}): Promise<Checked> {
  const s = parseStatement(text);
  if (typeof s === 'string') return { ok: false, reason: s };
  const device = keys.find((k) => k.id === s.device);
  if (!device) return { ok: false, statement: s, reason: `device ${s.device} is not in the keys` };
  if (!(await verifySignature(device.key, text, signature))) return { ok: false, statement: s, device, reason: 'the signature does not check out' };
  if (expect.payload !== undefined && sha256hex(expect.payload) !== s.payloadSha256) return { ok: false, statement: s, device, reason: 'the payload is not the one signed' };
  if (expect.kind && s.kind !== expect.kind) return { ok: false, statement: s, device, reason: `signed for a ${s.kind}, not a ${expect.kind}` };
  if (expect.ask && askText(expect.ask) !== askText(s)) return { ok: false, statement: s, device, reason: 'signed for another request' };
  return { ok: true, statement: s, device };
}

/** The commit trailers that carry an approval (docs/approvals.md, "Approvals in commits"), a line each. */
export function approvalTrailers(a: { statement: string; payload: string; signature: string; policy?: string }): string {
  return [...(a.policy ? [`Approval-Policy: ${a.policy}`] : []), `Approval-Statement: ${b64u(a.statement)}`, `Approval-Payload: ${b64u(a.payload)}`, `Approval-Signature: ${a.signature}`].join('\n') + '\n';
}
