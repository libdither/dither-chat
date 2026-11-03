/**
 * Protocol fingerprint of a Discord web build, so a pipeline can tell when Discord changed something
 * our own voice implementation copies by observation. It records only names, numbers and short
 * anchor strings (no code):
 *
 *   gateway.*  the voice gateway socket class (anchor "RTCControlSocket("): opcodes it handles, the
 *              JSON keys it sends per opcode, binary opcodes, snake_case fields it reads, the ?v=
 *              choices and the close-code enum
 *   sdp.*      the SDP helper module (anchor "Remote SDP does not include fingerprint!"): the filter
 *              regex for the select-protocol SDP, extmap URIs, fmtp strings, codec preference lists
 *              and a few rules the remote-answer synthesis depends on
 *   bridge.*   what the in-page bridge relies on: store display names, Flux action names, the
 *              Dispatcher interceptor loop, the selectVoiceChannel/disconnect action creators
 *   dave.*     libdave names the client calls and the wasm registers (filled in from extract.ts)
 *
 *   bun scripts/dave/fingerprint.ts --assets DIR [--previous fingerprint.json]
 *
 * diffFingerprints() classifies changes: something new is "additive", something gone or changed
 * is "breaking" (meaning: re-check the notes before trusting the old behaviour).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkModules } from './extract.ts';

export type Value = string[] | string | boolean | number | null;
export interface Fingerprint {
  version: 1;
  build?: string;
  values: Record<string, Value>;
  missing: string[];
}

const STORES = ['RTCConnectionStore', 'GatewayConnectionStore', 'AuthenticationStore', 'MediaEngineStore', 'SelectedChannelStore', 'VoiceStateStore', 'ChannelStore'];
const ACTIONS = ['VOICE_CHANNEL_SELECT', 'VOICE_SERVER_UPDATE', 'VOICE_STATE_UPDATES', 'CONNECTION_OPEN', 'RTC_CONNECTION_STATE', 'LOGOUT'];

function walk(node: any, fn: (n: any) => void) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n.type !== 'string') continue;
    fn(n);
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) stack.push(c);
      else if (v && typeof v === 'object' && typeof v.type === 'string') stack.push(v);
    }
  }
}
const uniqSorted = (xs: Iterable<string>) => [...new Set(xs)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
const propName = (p: any) => (p.type === 'SpreadElement' ? '...' : String(p.key?.name ?? p.key?.value));

/** Source of the module (in any of `files`) whose text contains `anchor`, plus its AST node. */
function findModule(files: string[], anchor: string): { src: string; node: any } | null {
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (!src.includes(anchor)) continue;
    for (const [, p] of chunkModules(src)) {
      if (p.value.end < src.indexOf(anchor)) continue;
      const body = src.slice(p.value.start, p.value.end);
      if (body.includes(anchor)) return { src, node: p.value };
    }
  }
  return null;
}

function gateway(files: string[], v: Record<string, Value>, missing: string[]) {
  const mod = findModule(files, 'RTCControlSocket(');
  if (!mod) return void missing.push('gateway: module containing "RTCControlSocket(" not found');
  const { src } = mod;
  let cls: any = null;
  walk(mod.node, (n) => {
    if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && !cls) {
      const s = src.slice(n.start, n.end);
      if (s.includes('RTCControlSocket(') && s.includes('selectProtocol(')) cls = n;
    }
  });
  if (!cls) return void missing.push('gateway: class with "RTCControlSocket(" and selectProtocol() not found');
  const csrc = src.slice(cls.start, cls.end);
  const recv: string[] = [];
  let best: any = null;
  walk(cls, (n) => {
    if (n.type !== 'SwitchStatement') return;
    const nums = n.cases.filter((c: any) => c.test?.type === 'Literal' && typeof c.test.value === 'number');
    if (!best || nums.length > best.length) best = nums;
  });
  for (const c of best ?? []) recv.push(String(c.test.value));
  v['gateway.recvOps'] = uniqSorted(recv);
  const binary: string[] = [];
  const methods: any[] = cls.body.body.filter((m: any) => m.type === 'MethodDefinition');
  walk(cls, (n) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.object.type !== 'ThisExpression') return;
    const name = n.callee.property.name;
    const op = n.arguments[0];
    if (op?.type !== 'Literal' || typeof op.value !== 'number') return;
    if (name === 'sendBinary') binary.push(String(op.value));
    if (name !== 'send') return;
    const d = n.arguments[1];
    const key = `gateway.send.op${op.value}`;
    let keys: string[] = d?.type === 'ObjectExpression' ? d.properties.map(propName) : [d ? '(scalar)' : '(none)'];
    // A spread (select protocol) pulls its keys from object literals built in the same method.
    if (keys.includes('...')) {
      const method = methods.find((m) => m.start <= n.start && n.end <= m.end);
      if (method) walk(method, (o) => o.type === 'ObjectExpression' && keys.push(...o.properties.filter((p: any) => p.type !== 'SpreadElement').map(propName)));
      keys = keys.filter((k) => k !== '...');
    }
    v[key] = uniqSorted([...((v[key] as string[]) ?? []), ...keys]);
  });
  v['gateway.sendBinaryOps'] = uniqSorted(binary);
  const fields: string[] = [];
  walk(cls, (n) => {
    if (n.type === 'MemberExpression' && !n.computed && /^[a-z0-9]+(_[a-z0-9]+)+$/.test(n.property.name ?? '')) fields.push(n.property.name);
    if (n.type === 'ObjectPattern') for (const p of n.properties) if (p.key && /^[a-z0-9]+(_[a-z0-9]+)+$/.test(p.key.name ?? '')) fields.push(p.key.name);
  });
  v['gateway.readFields'] = uniqSorted(fields);
  const ver = /\?(\d+):(\d+)\}\(\{location:"RTCControlSocket"/.exec(csrc);
  v['gateway.urlVersions'] = ver ? uniqSorted([ver[1], ver[2]]) : null;
  if (!ver) missing.push('gateway: ?v= version choice not found');
  v['gateway.urlHasVersionQuery'] = /\?v=\$\{/.test(csrc);
  const modSrc = src.slice(mod.node.start, mod.node.end);
  v['gateway.closeCodes'] = uniqSorted([...modSrc.matchAll(/\[\w+\.([A-Z_]+)=(4\d{3})\]/g)].map((m) => `${m[2]} ${m[1]}`));
  v['gateway.binaryHeaderSeqU16'] = /parseBinaryMessage/.test(csrc) && /\w+\[\w+\]<<8\|\w+\[\w+\+1\]/.test(modSrc);
}

function sdp(files: string[], v: Record<string, Value>, missing: string[]) {
  const mod = findModule(files, 'Remote SDP does not include fingerprint!');
  if (!mod) return void missing.push('sdp: module containing "Remote SDP does not include fingerprint!" not found');
  const s = mod.src.slice(mod.node.start, mod.node.end);
  const filter = /RegExp\(`(\^a=ice[^`]*)`/.exec(s);
  v['sdp.selectProtocolFilter'] = filter ? filter[1].replace(/\$\{[^}]*\}/g, '${…}') : null;
  if (!filter) missing.push('sdp: select-protocol line filter regex not found');
  v['sdp.extmapUris'] = uniqSorted([...s.matchAll(/"((?:urn:ietf:params:rtp-hdrext|urn:3gpp|https?:\/\/www\.(?:webrtc|ietf)\.org)[^"]*)"/g)].map((m) => m[1]));
  v['sdp.fmtp'] = uniqSorted([...s.matchAll(/[`"]([^`"\n]*(?:minptime=|x-google-max-bitrate=|packetization-mode=|tx-mode=|apt=|sprop-stereo)[^`"\n]*)[`"]/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, '${…}').replace(/\$\{.*$/, '${…}')));
  v['sdp.codecPreference'] = uniqSorted([...s.matchAll(/\[((?:[\w$]+\.[\w$]+\.(?:OPUS|H265|H264|VP8|VP9|AV1),?)+)\]/g)].map((m) => m[1].replace(/[\w$]+\.[\w$]+\./g, '')));
  v['sdp.originSessionId'] = /sessionId:"1420070400000"/.test(s) ? '1420070400000' : null;
  v['sdp.protocol'] = /"UDP\/TLS\/RTP\/SAVPF"/.test(s) ? 'UDP/TLS/RTP/SAVPF' : null;
  v['sdp.rtxSsrcIsVideoPlusOne'] = /semantics:"FID",ssrcs:`\$\{(\w)\} \$\{\1\+1\}`/.test(s);
  v['sdp.answerSetupPassive'] = /"answer"===\w+\?"passive":"actpass"/.test(s);
  v['sdp.msidUserSsrc'] = /value:`\$\{\w+\} \$\{\w+\}`/.test(s) && /`\$\{\w+\}-\$\{\w+\}`/.test(s);
  v['sdp.peerConnectionConfig'] = /bundlePolicy:"max-bundle",sdpSemantics:"unified-plan",encodedInsertableStreams:/.test(s);
  v['sdp.requiredRemoteLines'] = uniqSorted([...s.matchAll(/Remote SDP does not include ([\w -]+)!/g)].map((m) => m[1]));
}

function bridge(files: string[], v: Record<string, Value>) {
  const all = files.map((f) => readFileSync(f, 'utf8'));
  const has = (re: RegExp) => all.some((s) => re.test(s));
  v['bridge.storeDisplayNames'] = STORES.filter((n) => all.some((s) => s.includes(`displayName="${n}"`)));
  v['bridge.actions'] = ACTIONS.filter((a) => has(new RegExp(`\\b${a}:function\\(|"${a}"`)));
  v['bridge.dispatcherInterceptorLoop'] = has(/for\(let \w+ of this\._interceptors\)if\(\w+\(\w+\)\)return!1/);
  v['bridge.addInterceptor'] = has(/addInterceptor\(\w+\)\{this\._interceptors\.push\(\w+\)\}/);
  v['bridge.storeGetAll'] = has(/static getAll\(\)\{return \w+\}/) || has(/getAll\(\)\{return [\w$.]+\}/);
  v['bridge.voiceActionCreators'] = has(/disconnect\(\)\{[^{}]{0,200}this\.selectVoiceChannel\(null\)/);
  v['bridge.rtcStoreConnectsOnServerUpdate'] = has(/VOICE_SERVER_UPDATE:function\(\w\)\{if\(null==\w[^{}]{0,200}\.connect\(\w\.endpoint,\w\.token\)/);
  v['bridge.rtcStoreCreatesWithSession'] = all.some((s) => s.includes('Creating RTCConnection without session.'));
  v['bridge.webpackChunkGlobal'] = all.some((s) => s.includes('webpackChunkdiscord_app'));
}

/** Fingerprint of one build's .js files. DAVE names are added by the caller from extract's manifest. */
export function fingerprint(files: string[], build?: string): Fingerprint {
  const values: Record<string, Value> = {};
  const missing: string[] = [];
  for (const [name, fn] of [['gateway', gateway], ['sdp', sdp]] as const) {
    try {
      fn(files, values, missing);
    } catch (e) {
      missing.push(`${name}: ${(e as Error).message}`);
    }
  }
  bridge(files, values);
  for (const [k, val] of Object.entries(values)) if (val === false || val === null) missing.push(`${k} not found`);
  for (const n of STORES) if (!(values['bridge.storeDisplayNames'] as string[]).includes(n)) missing.push(`bridge: store displayName "${n}" not found`);
  for (const a of ACTIONS) if (!(values['bridge.actions'] as string[]).includes(a)) missing.push(`bridge: action "${a}" not found`);
  return { version: 1, build, values, missing };
}

export interface Diff {
  from?: string;
  to?: string;
  additive: string[];
  breaking: string[];
}

export function diffFingerprints(prev: Fingerprint | null, next: Fingerprint): Diff {
  const d: Diff = { from: prev?.build, to: next.build, additive: [], breaking: [] };
  if (!prev) return d;
  const keys = new Set([...Object.keys(prev.values), ...Object.keys(next.values)]);
  for (const k of [...keys].sort()) {
    const a = prev.values[k];
    const b = next.values[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (Array.isArray(a) || Array.isArray(b)) {
      const A = new Set(Array.isArray(a) ? a : []);
      const B = new Set(Array.isArray(b) ? b : []);
      for (const x of B) if (!A.has(x)) d.additive.push(`${k}: + ${x}`);
      for (const x of A) if (!B.has(x)) d.breaking.push(`${k}: - ${x}`);
      if (a === undefined) d.additive.push(`${k}: new`);
      if (b === undefined) d.breaking.push(`${k}: gone`);
    } else if (a === undefined) d.additive.push(`${k}: new (${JSON.stringify(b)})`);
    else if (a === false && b === true) d.additive.push(`${k}: now true`);
    else d.breaking.push(`${k}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
  return d;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = opt('--assets');
  if (!dir) {
    console.error('usage: bun scripts/dave/fingerprint.ts --assets DIR [--previous fingerprint.json]');
    process.exit(1);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => join(dir, f));
  const fp = fingerprint(files);
  const prevPath = opt('--previous');
  const out = prevPath ? { fingerprint: fp, diff: diffFingerprints(JSON.parse(readFileSync(prevPath, 'utf8')), fp) } : fp;
  console.log(JSON.stringify(out, null, 1));
}
