/**
 * Smoke test for the standalone libdave module written by extract.ts. It loads OUT/libdave.mjs the
 * way the PWA does (loadDave(), default wasm location next to the module) and drives a full DAVE
 * flow locally, with this script playing the voice server's MLS external sender (hand-built RFC 9420
 * messages, WebCrypto ECDSA P-256 signatures). Nothing touches the network.
 *
 *   bun scripts/dave/smoke.ts OUT_DIR
 *
 * Steps:
 *   0  libdave.mjs has no static imports (it must load in a browser worker)
 *   1  instantiate the wasm and list the embind API
 *   2  passthrough: Encryptor/Decryptor with no key ratchet
 *   3  two Sessions (users A, B): Init, SetExternalSender, key packages
 *   4  external sender proposes Add(B); A commits (op 27 -> op 28 payload)
 *   5  A processes its own commit (op 29), B processes the welcome (op 30)
 *   6  epoch authenticators and key ratchets agree on both sides
 *   7  A encrypts an Opus frame, B decrypts it; a tampered frame is rejected; a second frame works
 *   8  third user C joins an established group: both members commit, the "server" picks A's commit
 *
 * Writes OUT_DIR/smoke.json ({ok, maxProtocolVersion, results, api, ...}). Exit 0 when all passed,
 * 1 when a step failed or the module could not be loaded.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) {
  console.error('usage: bun scripts/dave/smoke.ts OUT_DIR');
  process.exit(1);
}
const OUT = resolve(process.argv[2]);
const results: { step: string; ok: boolean; detail?: string }[] = [];
function check(step: string, ok: boolean, detail = '') {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? '  (' + detail + ')' : ''}`);
}
const runtime = typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node ${process.version}`;
function finish(extra: Record<string, unknown> = {}): never {
  const failed = results.filter((r) => !r.ok);
  const ok = results.length > 0 && failed.length === 0;
  console.log(`\n${results.length - failed.length}/${results.length} passed under ${runtime}`);
  writeFileSync(join(OUT, 'smoke.json'), JSON.stringify({ ok, at: new Date().toISOString(), runtime, results, ...extra }, null, 1));
  process.exit(ok ? 0 : 1);
}
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const u8 = (x: ArrayLike<number> | null | undefined) => (x == null ? null : Uint8Array.from(x as ArrayLike<number>));

// ---------------- minimal TLS / MLS encoding (RFC 9420) ----------------
class W {
  parts: number[] = [];
  u8(v: number) { this.parts.push(v & 0xff); return this; }
  u16(v: number) { return this.u8(v >> 8).u8(v); }
  u32(v: number) { return this.u16(v >>> 16).u16(v & 0xffff); }
  u64(v: bigint) { for (let i = 7; i >= 0; i--) this.u8(Number((v >> BigInt(i * 8)) & 0xffn)); return this; }
  raw(b: Uint8Array) { for (const x of b) this.parts.push(x); return this; }
  varint(n: number) {
    if (n < 0x40) return this.u8(n);
    if (n < 0x4000) return this.u16(0x4000 | n);
    return this.u32((0x80000000 | n) >>> 0);
  }
  vec(b: Uint8Array) { return this.varint(b.length).raw(b); }
  bytes() { return Uint8Array.from(this.parts); }
}
class R {
  b: Uint8Array;
  i: number;
  constructor(b: Uint8Array, i = 0) { this.b = b; this.i = i; }
  u8() { if (this.i >= this.b.length) throw new Error("short read"); return this.b[this.i++]; }
  u16() { return (this.u8() << 8) | this.u8(); }
  u32() { return ((this.u16() << 16) | this.u16()) >>> 0; }
  u64() { let v = 0n; for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(this.u8()); return v; }
  varint() {
    const first = this.b[this.i];
    const len = 1 << (first >> 6);
    let v = this.u8() & 0x3f;
    for (let k = 1; k < len; k++) v = (v << 8) | this.u8();
    return v >>> 0;
  }
  vec() { const n = this.varint(); const out = this.b.subarray(this.i, this.i + n); if (out.length !== n) throw new Error("short vec"); this.i += n; return out; }
  rest() { return this.b.subarray(this.i); }
}
const bigEndian64 = (v: bigint) => new W().u64(v).bytes();

// ECDSA P-256: WebCrypto gives r||s, MLS wants DER.
function derFromP1363(sig: Uint8Array) {
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    let v = x.subarray(i);
    if (v[0] & 0x80) v = Uint8Array.from([0, ...v]);
    return Uint8Array.from([0x02, v.length, ...v]);
  };
  const r = int(sig.subarray(0, 32)), s = int(sig.subarray(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

class ExternalSender {
  keys!: CryptoKeyPair;
  pub!: Uint8Array;
  identity = new TextEncoder().encode("smoke-test-voice-server");
  async init() {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    this.pub = new Uint8Array(await crypto.subtle.exportKey("raw", this.keys.publicKey)); // 65-byte uncompressed point
    return this;
  }
  /** op 25 payload: MLS ExternalSender { SignaturePublicKey signature_key; Credential credential (basic) } */
  package() {
    return new W().vec(this.pub).u16(1 /* basic */).vec(this.identity).bytes();
  }
  async signWithLabel(label: string, content: Uint8Array) {
    const tbs = new W().vec(new TextEncoder().encode("MLS 1.0 " + label)).vec(content).bytes();
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, tbs));
    return derFromP1363(sig);
  }
  /** One external Add proposal as an MLSMessage(PublicMessage). */
  async addProposal(groupId: Uint8Array, epoch: bigint, keyPackage: Uint8Array) {
    const framedContent = new W()
      .vec(groupId)
      .u64(epoch)
      .u8(2 /* sender_type external */).u32(0 /* sender_index */)
      .vec(new Uint8Array(0) /* authenticated_data */)
      .u8(2 /* content_type proposal */)
      .u16(1 /* proposal_type add */)
      .raw(keyPackage)
      .bytes();
    const tbs = new W().u16(1 /* mls10 */).u16(1 /* mls_public_message */).raw(framedContent).bytes();
    const signature = await this.signWithLabel("FramedContentTBS", tbs);
    return new W().u16(1).u16(1).raw(framedContent).vec(signature).bytes();
  }
  /** op 27 payload: u8 operation (0 = append) + MLSMessage proposal_messages<V> */
  proposalsAppend(messages: Uint8Array[]) {
    const body = new W();
    for (const m of messages) body.raw(m);
    return new W().u8(0).vec(body.bytes()).bytes();
  }
}

/** Split the op 28 payload (MLSMessage commit [+ Welcome]) by walking the commit's TLS structure. */
function splitCommitWelcome(buf: Uint8Array) {
  const r = new R(buf);
  if (r.u16() !== 1) throw new Error("commit: bad version");
  if (r.u16() !== 1) throw new Error("commit: not a PublicMessage");
  r.vec(); // group_id
  const epoch = r.u64();
  const senderType = r.u8();
  if (senderType === 1 || senderType === 2) r.u32();
  r.vec(); // authenticated_data
  if (r.u8() !== 3) throw new Error("commit: content_type is not commit");
  r.vec(); // proposals<V>
  const hasPath = r.u8();
  if (hasPath) {
    // LeafNode
    r.vec(); r.vec(); // encryption_key, signature_key
    const credType = r.u16();
    r.vec(); // identity (basic) or certificates (x509): both one vector
    if (credType !== 1 && credType !== 2) throw new Error("commit: unknown credential type");
    for (let k = 0; k < 5; k++) r.vec(); // capabilities
    const src = r.u8();
    if (src === 1) { r.u64(); r.u64(); } else if (src === 3) r.vec();
    r.vec(); r.vec(); // extensions, signature
    r.vec(); // nodes<V>
  }
  r.vec(); // signature
  r.vec(); // confirmation_tag
  if (senderType === 1) r.vec(); // membership_tag
  const commit = buf.subarray(0, r.i);
  const welcome = r.rest();
  return { commit, welcome: welcome.length ? welcome : null, epoch, hasPath: !!hasPath };
}

// ---------------- run ----------------
{
  const src = readFileSync(join(OUT, 'libdave.mjs'), 'utf8');
  const statics = src.split('\n').filter((l) => /^\s*import\s[^(]/.test(l) || /^\s*export\s.*\sfrom\s/.test(l));
  check('0 libdave.mjs has no static imports', statics.length === 0, statics.join(' | '));
}
let dave: any;
try {
  const mod = await import(pathToFileURL(join(OUT, 'libdave.mjs')).href);
  dave = await mod.loadDave();
} catch (e) {
  check('1 instantiate + embind API present', false, String(e));
  finish();
}

// 1. API surface
const api: Record<string, any> = {};
for (const k of Object.keys(dave).sort()) {
  const v = dave[k];
  if (/^(HEAP|_|ccall|cwrap|instantiateWasm|onRuntimeInitialized|print)/.test(k)) continue;
  if (typeof v === "function" && v.prototype && Object.getOwnPropertyNames(v.prototype).length > 1)
    api[k] = { kind: "class", methods: Object.getOwnPropertyNames(v.prototype).filter((n) => n !== "constructor") };
  else if (typeof v === "function" && v.values) api[k] = { kind: "enum", values: Object.fromEntries(Object.keys(v).filter((n) => n !== "values" && n !== "argCount").map((n) => [n, v[n].value])) };
  else if (typeof v === "function" && v.prototype && k === "SignaturePrivateKey") api[k] = { kind: "class (opaque handle, no constructor)" };
  else if (typeof v === "function") api[k] = { kind: "function" };
  else api[k] = { kind: typeof v, value: v };
}
const want = ["Session", "Encryptor", "Decryptor", "TransientKeys", "MediaType", "Codec", "kInitTransitionId", "kDisabledVersion", "MaxSupportedProtocolVersion"];
check("1 instantiate + embind API present", want.every((k) => k in api), `MaxSupportedProtocolVersion=${dave.MaxSupportedProtocolVersion()}, kDisabledVersion=${dave.kDisabledVersion}, kInitTransitionId=${dave.kInitTransitionId}`);

const { MediaType, Codec } = dave;
function encrypt(enc: any, ssrc: number, frame: Uint8Array, mediaType = MediaType.Audio) {
  const cap = enc.GetMaxCiphertextByteSize(mediaType, frame.length);
  const p = dave._malloc(cap);
  try {
    dave.HEAPU8.set(frame, p);
    const n = enc.Encrypt(mediaType, ssrc, p, frame.length, cap);
    return n === 0 ? null : dave.HEAPU8.slice(p, p + n);
  } finally { dave._free(p); }
}
function decrypt(dec: any, frame: Uint8Array, mediaType = MediaType.Audio) {
  const cap = dec.GetMaxPlaintextByteSize(mediaType, frame.length);
  const p = dave._malloc(Math.max(cap, frame.length));
  try {
    dave.HEAPU8.set(frame, p);
    const n = dec.Decrypt(mediaType, p, frame.length, cap);
    return n === 0 ? null : dave.HEAPU8.slice(p, p + n);
  } finally { dave._free(p); }
}
// A plausible Opus frame: TOC byte 0xfc (SILK/CELT 20ms) + payload
const opus = Uint8Array.from([0xfc, ...Array.from({ length: 79 }, (_, i) => (i * 37 + 11) & 0xff)]);
const SSRC_A = 0x1234;

// 2. passthrough
{
  const enc = new dave.Encryptor(), dec = new dave.Decryptor();
  enc.SetPassthroughMode(true); enc.SetKeyRatchet(null);
  enc.AssignSsrcToCodec(SSRC_A, Codec.Opus);
  dec.TransitionToPassthroughMode(true); dec.TransitionToKeyRatchet(null);
  const c = encrypt(enc, SSRC_A, opus);
  const p = c && decrypt(dec, c);
  check("2 passthrough encrypt/decrypt round trip", !!c && eq(c, opus) && !!p && eq(p, opus), `enc protocol version ${enc.GetProtocolVersion()}`);
  enc.delete(); dec.delete();
}

// 3. sessions
const CHANNEL = 1234567890123456789n; // the group id is the voice channel id
const groupId = bigEndian64(CHANNEL);
const users = { A: "111111111111111111", B: "222222222222222222", C: "333333333333333333" };
const failures: string[] = [];
const transient: any[] = [];
function mkSession(name: string, self: string) {
  // Like the web client: Session("", "", onMLSFailure), then Init(version, BigInt(channelId), userId, transientKey)
  const tk = new dave.TransientKeys(); // one per simulated client (the web client keeps one per page)
  transient.push(tk);
  const s = new dave.Session("", "", (src: string, msg: string) => failures.push(`${name}: ${src}: ${msg}`));
  s.Init(1, CHANNEL, self, tk.GetTransientPrivateKey(1));
  return s;
}
const xs = await new ExternalSender().init();
const A = mkSession("A", users.A), B = mkSession("B", users.B);
for (const s of [A, B]) s.SetExternalSender(xs.package());
A.AddRecognizedUser(users.B); B.AddRecognizedUser(users.A);
const kpA = u8(A.GetMarshalledKeyPackage())!, kpB = u8(B.GetMarshalledKeyPackage())!;
check("3 Session Init + SetExternalSender + key packages", kpA.length > 100 && kpB.length > 100 && failures.length === 0,
  `key package ${kpB.length} bytes, starts ${hex(kpB.subarray(0, 4))} (version 1, ciphersuite 2), protocol ${A.GetProtocolVersion()}`);

// 4. proposals -> commit/welcome
const propB = await xs.addProposal(groupId, 0n, kpB);
const op27 = xs.proposalsAppend([propB]);
const cwA = u8(A.ProcessProposals(op27));
let split: ReturnType<typeof splitCommitWelcome> | null = null;
try { if (cwA) split = splitCommitWelcome(cwA); } catch (e) { failures.push("split: " + e); }
check("4 external Add proposal -> A returns commit+welcome", !!split && !!split.welcome,
  cwA ? `${cwA.length} bytes: commit ${split?.commit.length}, welcome ${split?.welcome?.length}, path ${split?.hasPath}` : failures.slice(-2).join("; "));

// 5. commit + welcome
let ok5 = false, detail5 = "";
if (split?.welcome) {
  const rc = A.ProcessCommit(split.commit);
  const rw = B.ProcessWelcome(split.welcome);
  ok5 = rc && !rc.failed && !rc.ignored && rc.rosterUpdate != null && rw != null;
  detail5 = `A roster ${Object.keys(rc?.rosterUpdate ?? {}).join(",")}; B roster ${Object.keys(rw ?? {}).join(",")}`;
}
check("5 A ProcessCommit(own commit) + B ProcessWelcome", ok5, detail5 || failures.slice(-2).join("; "));

// 6. agreement
const authA = u8(A.GetLastEpochAuthenticator())!, authB = u8(B.GetLastEpochAuthenticator())!;
const rA_A = A.GetKeyRatchet(users.A), rA_B = B.GetKeyRatchet(users.A);
check("6 epoch authenticator + key ratchet for A agree", authA.length > 0 && eq(authA, authB) && rA_A && rA_B && eq(u8(rA_A.baseSecret)!, u8(rA_B.baseSecret)!),
  `authenticator ${authA.length} bytes; ratchet = {cipherSuite: ${rA_A?.cipherSuite}, baseSecret: ${rA_A?.baseSecret?.length} bytes (plain JS array)}`);

// 7. media
let cipherA: Uint8Array | null = null;
{
  const enc = new dave.Encryptor();
  let versionCb = 0;
  enc.SetProtocolVersionChangedCallback(() => versionCb++);
  enc.SetPassthroughMode(false);
  enc.SetKeyRatchet(rA_A);
  enc.AssignSsrcToCodec(SSRC_A, Codec.Opus);
  cipherA = encrypt(enc, SSRC_A, opus);
  const dec = new dave.Decryptor();
  dec.TransitionToPassthroughMode(false);
  dec.TransitionToKeyRatchet(rA_B);
  const plain = cipherA && decrypt(dec, cipherA);
  const tampered = cipherA && Uint8Array.from(cipherA);
  if (tampered) tampered[3] ^= 0x01;
  const bad = tampered && decrypt(dec, tampered);
  const trailer = cipherA ? hex(cipherA.subarray(cipherA.length - 2)) : "";
  check("7 Opus frame: A encrypts, B decrypts, tamper rejected", !!cipherA && !eq(cipherA, opus) && !!plain && eq(plain, opus) && bad == null,
    `plain ${opus.length} -> cipher ${cipherA?.length} bytes, ends with ${trailer} (magic 0xfafa), protocol ${enc.GetProtocolVersion()}, version callback fired ${versionCb}x`);
  // second frame keeps working (nonce advances)
  const c2 = encrypt(enc, SSRC_A, opus);
  const p2 = c2 && decrypt(dec, c2);
  check("7b second frame decrypts too", !!p2 && eq(p2, opus));
  enc.delete(); dec.delete();
}

// 8. third member joins an established group
{
  const C = mkSession("C", users.C);
  C.SetExternalSender(xs.package());
  C.AddRecognizedUser(users.A); C.AddRecognizedUser(users.B);
  A.AddRecognizedUser(users.C); B.AddRecognizedUser(users.C);
  const kpC = u8(C.GetMarshalledKeyPackage())!;
  const op27b = xs.proposalsAppend([await xs.addProposal(groupId, 1n, kpC)]);
  const cwA2 = u8(A.ProcessProposals(op27b)), cwB2 = u8(B.ProcessProposals(op27b));
  let ok = false, d = "";
  if (cwA2 && cwB2) {
    const s = splitCommitWelcome(cwA2); // server picks A's commit
    const ra = A.ProcessCommit(s.commit), rb = B.ProcessCommit(s.commit), rc = C.ProcessWelcome(s.welcome!);
    const enc = new dave.Encryptor();
    enc.SetKeyRatchet(A.GetKeyRatchet(users.A));
    enc.AssignSsrcToCodec(SSRC_A, Codec.Opus);
    const ct = encrypt(enc, SSRC_A, opus)!;
    const decC = new dave.Decryptor(); decC.TransitionToKeyRatchet(C.GetKeyRatchet(users.A));
    const decB = new dave.Decryptor(); decB.TransitionToKeyRatchet(B.GetKeyRatchet(users.A));
    const pc = decrypt(decC, ct), pb = decrypt(decB, ct);
    ok = !ra.failed && !ra.ignored && !rb.failed && !rb.ignored && rc != null && !!pc && eq(pc, opus) && !!pb && eq(pb, opus)
      && eq(u8(A.GetLastEpochAuthenticator())!, u8(C.GetLastEpochAuthenticator())!);
    d = `epoch ${s.epoch}->${s.epoch + 1n}, path ${s.hasPath}; B handled A's commit (not its own), C roster ${Object.keys(rc ?? {}).join(",")}`;
    enc.delete(); decB.delete(); decC.delete();
  } else d = failures.slice(-3).join("; ");
  check("8 third member: competing commits, B applies A's commit, C welcomed, all decrypt", ok, d);
  C.delete();
}

A.delete(); B.delete(); for (const t of transient) t.delete();
if (failures.length) console.log('MLS failure callbacks:', failures);
finish({ maxProtocolVersion: dave.MaxSupportedProtocolVersion(), mlsFailures: failures, api });
