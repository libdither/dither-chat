/**
 * Call lab: measures call quality, latency and cost between two Discord accounts the hub runs,
 * with real media flowing both ways.
 *
 *   bun scripts/call-lab.ts <config.json>
 *
 * config.json: { hub, dataDir, conversation, channelId, guildId, device: <account id>, peer: <account id>,
 *                speech: <ogg/opus file>, reference: <48 kHz mono s16 wav of the same speech>,
 *                scenarios?: string[], seconds?: number, out?: <json path> }
 *
 * Needs a hub started with DITHER_LAB=1 on loopback, whose two Discord accounts have `"lab": true` in
 * their config (see docs/calls.md, "Call lab"). Use a separate hub and data dir, never the one your
 * devices use: lab sandboxes accept arbitrary lab commands.
 *
 * Scenarios:
 *   native   both accounts' own Discord clients in the channel (the baseline: Discord to Discord)
 *   bridge   `device` joins from a test browser in bridge mode; `peer`'s client is the far end
 *   direct   the same in direct mode
 *   video    both clients with a camera on, each watching the other
 *   golive   `peer` shares its screen (Go Live) and `device` watches it
 *
 * Every sender loops the same speech recording (Discord's default noise cancellation and VAD pass only
 * speech) or draws a time-coded test card; every receiver records what arrives. Both ends run on this
 * machine, so latency is arrival time minus send time on one clock. Audio latency comes from
 * correlating 2 s windows of the received loudness envelope against the recording's.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './browser.ts';

const cfg = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  hub: string;
  dataDir: string;
  conversation: string;
  channelId: string;
  guildId: string;
  device: string;
  peer: string;
  speech: string;
  reference: string;
  scenarios?: string[];
  seconds?: number;
  out?: string;
};
const SECS = cfg.seconds ?? 40;
const HUB = cfg.hub.replace(/\/$/, '');
// The probe the running adapter has: dither-accounts' copy when it sits next to this checkout (supervisor.ts adapterEntry).
const probeAt = [join(import.meta.dir, '../../dither-accounts/extractors/discord/src/lab/probe.js'), join(import.meta.dir, '../packages/adapter-discord/src/lab/probe.js')];
const PROBE = readFileSync(probeAt.find((p) => existsSync(p)) ?? probeAt[1], 'utf8');
const SPEECH_B64 = readFileSync(cfg.speech).toString('base64');

async function lab<T = any>(account: string, body: Record<string, unknown>): Promise<T> {
  const r = (await fetch(`${HUB}/api/lab/${account}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())) as any;
  if (!r.ok) throw new Error(`lab ${account} ${body.op}: ${r.error}`);
  return r.result as T;
}
const evalIn = (account: string, code: string) => lab(account, { op: 'eval', code, timeout: 30_000 });

// ---------------------------------------------------------------- processes
const TICK = 100;
type Proc = { pid: number; cmd: string; ppid: number };
function procs(): Proc[] {
  const out: Proc[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ');
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      out.push({ pid: Number(d), cmd, ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) });
    } catch {}
  }
  return out;
}
const readEnv = (pid: number) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8') + readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return '';
  }
};
function cpuTicks(pid: number) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]);
  } catch {
    return 0;
  }
}
function pssKb(pid: number) {
  try {
    const m = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}
function tree(all: Proc[], roots: number[]) {
  const out = new Set(roots);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) if (!out.has(p.pid) && out.has(p.ppid)) (out.add(p.pid), (grew = true));
  }
  return [...out];
}
function groups(deviceDir: string | null) {
  const all = procs();
  const find = (re: RegExp) => all.filter((p) => re.test(p.cmd)).map((p) => p.pid);
  const adapter = (acc: string) => find(/(?:adapter-discord|extractors\/discord)\/src\/main\.ts/).filter((pid) => readEnv(pid).includes(acc));
  const sandbox = (acc: string) => tree(all, adapter(acc)).filter((pid) => !adapter(acc).includes(pid));
  const dev = deviceDir ? find(new RegExp(deviceDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).filter((pid) => !all.find((p) => p.pid === pid)?.cmd.includes('--type=')) : [];
  return {
    device: tree(all, dev),
    'device sandbox': sandbox(cfg.device),
    'peer sandbox': sandbox(cfg.peer),
    hub: find(/hub\/src\/main\.ts/).filter((pid) => readEnv(pid).includes(cfg.dataDir)),
    turn: find(/turnserver/),
  } as Record<string, number[]>;
}
async function hold(deviceDir: string | null, ms: number) {
  const g0 = groups(deviceDir);
  const cpu0 = Object.fromEntries(Object.entries(g0).map(([k, p]) => [k, p.reduce((a, x) => a + cpuTicks(x), 0)]));
  const pss: Record<string, number[]> = {};
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await Bun.sleep(Math.min(5000, ms - (Date.now() - t0)));
    for (const [k, p] of Object.entries(groups(deviceDir))) (pss[k] ??= []).push(p.reduce((a, x) => a + pssKb(x), 0));
  }
  const g1 = groups(deviceDir);
  const secs = (Date.now() - t0) / 1000;
  return Object.fromEntries(
    Object.entries(g1).map(([k, p]) => [k, { cpuPct: Math.round(((p.reduce((a, x) => a + cpuTicks(x), 0) - (cpu0[k] ?? 0)) / TICK / secs) * 1000) / 10, pssMB: Math.round((pss[k] ?? [0]).reduce((a, b) => a + b, 0) / (pss[k]?.length || 1) / 102.4) / 10 }]),
  );
}

// ---------------------------------------------------------------- analysis
const BLOCK = 256;
/** Loudness envelope of the reference recording, one value per 256 samples at 48 kHz. */
function referenceEnvelope(path: string): Float64Array {
  const b = readFileSync(path);
  let off = 12;
  while (off < b.length && b.toString('ascii', off, off + 4) !== 'data') off += 8 + b.readUInt32LE(off + 4);
  const n = b.readUInt32LE(off + 4) / 2;
  const s = new Int16Array(b.buffer.slice(b.byteOffset + off + 8, b.byteOffset + off + 8 + n * 2));
  const out = new Float64Array(Math.floor(n / BLOCK));
  for (let i = 0; i < out.length; i++) {
    let e = 0;
    for (let j = 0; j < BLOCK; j++) e += (s[i * BLOCK + j]! / 32768) ** 2;
    out[i] = Math.sqrt(e / BLOCK);
  }
  return out;
}
/** A 43 ms moving average: the raw envelope differs too much after Discord's noise cancellation and AGC to correlate well. */
function smooth(x: Float64Array, k = 8): Float64Array {
  const o = new Float64Array(x.length);
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i]!;
    if (i >= k) acc -= x[i - k]!;
    o[i] = acc / Math.min(i + 1, k);
  }
  return o;
}
const REF_RAW = referenceEnvelope(cfg.reference);
const REF = smooth(REF_RAW);
const STEP = (BLOCK / 48000) * 1000;

function pearson(a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number, n: number) {
  let sa = 0,
    sb = 0,
    saa = 0,
    sbb = 0,
    sab = 0;
  for (let i = 0; i < n; i++) {
    const x = a[ao + i]!;
    const y = b[bo + i]!;
    sa += x;
    sb += y;
    saa += x * x;
    sbb += y * y;
    sab += x * y;
  }
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  return va <= 0 || vb <= 0 ? 0 : (sab - (sa * sb) / n) / Math.sqrt(va * vb);
}
const q = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 10) / 10;
};

/** Mouth-to-ear latency of one received envelope against a sender's speech loop. */
function speechLatency(env: { t: number[]; v: number[] }, speech: { t: number; dur: number }, from: number, to: number) {
  if (!env?.t.length) return null;
  const g0 = env.t[0]!;
  const len = Math.ceil((env.t.at(-1)! - g0) / STEP) + 1;
  const R = new Float64Array(len);
  for (let i = 0; i < env.t.length; i++) R[Math.round((env.t[i]! - g0) / STEP)] = env.v[i]!;
  const RS = smooth(R);
  const W = Math.round(2000 / STEP);
  const lats: number[] = [];
  const rs: number[] = [];
  for (let k = Math.max(0, Math.floor((from - speech.t) / speech.dur)); speech.t + k * speech.dur < to; k++) {
    for (let o = 0; o + 2000 < speech.dur - 50; o += 500) {
      const e = speech.t + k * speech.dur + o;
      if (e < from || e + 3500 > to) continue;
      const ro = Math.round(o / STEP);
      let sd = 0;
      for (let i = 0; i < W; i++) sd += REF_RAW[ro + i]!;
      if (sd / W < 0.01) continue; // a pause in the recording: nothing to match
      let best = -1,
        bestLag = 0;
      for (let lag = 0; lag <= 1500; lag += STEP) {
        const bo = Math.round((e + lag - g0) / STEP);
        if (bo < 0 || bo + W >= len) continue;
        const r = pearson(REF, ro, RS, bo, W);
        if (r > best) (best = r), (bestLag = lag);
      }
      rs.push(best);
      if (best >= 0.6) lats.push(bestLag);
    }
  }
  return { windows: rs.length, matched: lats.length, p10: q(lats, 0.1), median: q(lats, 0.5), p90: q(lats, 0.9), meanR: rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100 : null };
}
/** The best-matching received track: the one carrying the other side's speech. */
function bestSpeech(rep: any, speech: any, from: number, to: number) {
  let best: any = null;
  for (const [k, env] of Object.entries(rep.env ?? {})) {
    const r = speechLatency(env as any, speech, from, to);
    if (r && (!best || r.matched > best.matched)) best = { track: k, ...r };
  }
  return best;
}

/** Rates and averages from the first and last stats samples of the window, per pc. */
function rtpSummary(rep: any, from: number) {
  const samples = rep.stats.filter((s: any) => s.t >= from);
  const out: any[] = [];
  for (const pc of new Set(samples.map((s: any) => s.pc))) {
    const ss = samples.filter((s: any) => s.pc === pc);
    if (ss.length < 2) continue;
    const a = ss[0],
      b = ss.at(-1);
    const secs = (b.t - a.t) / 1000;
    const byId = (s: any) => Object.fromEntries(s.items.map((i: any) => [i.id, i]));
    const A = byId(a),
      Bm = byId(b);
    const codec = (id?: string) => (id && Bm[id]?.mimeType) || undefined;
    const pair = b.items.find((i: any) => i.type === 'candidate-pair');
    const local = pair && Bm[pair.localCandidateId];
    for (const x of b.items) {
      const y = A[x.id] ?? {};
      const d = (k: string) => (x[k] ?? 0) - (y[k] ?? 0);
      if (x.type === 'outbound-rtp') {
        if (!d('bytesSent')) continue;
        out.push({ pc, dir: 'send', kind: x.kind, codec: codec(x.codecId), kbps: Math.round((d('bytesSent') * 8) / secs / 100) / 10, ...(x.kind === 'video' ? { res: `${x.frameWidth}x${x.frameHeight}`, fps: x.framesPerSecond, rid: x.rid, limit: x.qualityLimitationReason, encoder: x.encoderImplementation, encodeMsPerFrame: d('framesEncoded') ? Math.round((d('totalEncodeTime') / d('framesEncoded')) * 10000) / 10 : null, keyframes: d('keyFramesEncoded'), pli: d('pliCount'), nack: d('nackCount'), retransmitKbps: null } : {}) });
      }
      if (x.type === 'inbound-rtp') {
        if (!d('bytesReceived')) continue;
        const lost = d('packetsLost'),
          got = d('packetsReceived');
        const common = { pc, dir: 'recv', kind: x.kind, codec: codec(x.codecId), kbps: Math.round((d('bytesReceived') * 8) / secs / 100) / 10, lossPct: got + lost > 0 ? Math.round((lost / (got + lost)) * 10000) / 100 : 0, jitterMs: Math.round((x.jitter ?? 0) * 10000) / 10, jitterBufferMs: d('jitterBufferEmittedCount') ? Math.round((d('jitterBufferDelay') / d('jitterBufferEmittedCount')) * 10000) / 10 : null, jitterBufferTargetMs: d('jitterBufferEmittedCount') ? Math.round((d('jitterBufferTargetDelay') / d('jitterBufferEmittedCount')) * 10000) / 10 : null };
        if (x.kind === 'audio') out.push({ ...common, concealedPct: d('totalSamplesReceived') ? Math.round((d('concealedSamples') / d('totalSamplesReceived')) * 10000) / 100 : null, concealmentEvents: d('concealmentEvents') });
        else out.push({ ...common, res: `${x.frameWidth}x${x.frameHeight}`, fps: x.framesPerSecond, decoder: x.decoderImplementation, decodeMsPerFrame: d('framesDecoded') ? Math.round((d('totalDecodeTime') / d('framesDecoded')) * 10000) / 10 : null, framesDropped: d('framesDropped'), freezes: d('freezeCount'), freezeSecs: Math.round(d('totalFreezesDuration') * 10) / 10, keyframes: d('keyFramesDecoded'), pli: d('pliCount'), nack: d('nackCount') });
      }
    }
    if (pair) out.push({ pc, path: `${local?.candidateType ?? '?'}${local?.relayProtocol ? '/' + local.relayProtocol : ''}/${local?.protocol ?? '?'}`, rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null, outKbps: pair.availableOutgoingBitrate ? Math.round(pair.availableOutgoingBitrate / 1000) : null });
  }
  return out;
}
function videoLatency(rep: any, from: number) {
  const fr = rep.frames.filter((f: any) => f.t >= from);
  const ok = fr.filter((f: any) => f.lat != null);
  const lats = ok.map((f: any) => f.lat);
  const secs = fr.length ? (fr.at(-1).t - fr[0].t) / 1000 : 0;
  const sizes = [...new Set(fr.map((f: any) => `${f.w}x${f.h}`))];
  return { frames: fr.length, fps: secs ? Math.round((fr.length / secs) * 10) / 10 : null, decoded: ok.length, p10: q(lats, 0.1), median: q(lats, 0.5), p90: q(lats, 0.9), sizes };
}

// ---------------------------------------------------------------- scenarios
const peerJoin = async () => {
  await lab(cfg.peer, { op: 'join', channelId: cfg.channelId });
  await Bun.sleep(3000);
  return lab(cfg.peer, { op: 'speech', b64: SPEECH_B64 });
};
const leaveAll = async () => {
  for (const a of [cfg.device, cfg.peer]) await lab(a, { op: 'leave' }).catch(() => {});
  await Bun.sleep(3000);
};

async function nativeScenario() {
  await lab(cfg.device, { op: 'join', channelId: cfg.channelId });
  await Bun.sleep(3000);
  const devSpeech = await lab(cfg.device, { op: 'speech', b64: SPEECH_B64 });
  const peerSpeech = await peerJoin();
  await Bun.sleep(8000);
  const from = Date.now();
  const cost = await hold(null, SECS * 1000);
  const to = Date.now();
  const [d, p] = [await lab(cfg.device, { op: 'report', since: from - 3000 }), await lab(cfg.peer, { op: 'report', since: from - 3000 })];
  keepRaw('native', { from, to, devSpeech, peerSpeech, d, p });
  await leaveAll();
  return { cost, peerToDevice: bestSpeech(d, peerSpeech, from, to), deviceToPeer: bestSpeech(p, devSpeech, from, to), deviceRtp: rtpSummary(d, from), peerRtp: rtpSummary(p, from) };
}

async function deviceScenario(mode: 'bridge' | 'direct') {
  const peerSpeech = await peerJoin();
  const { page, close, profileDir } = await launch({ args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    // The probe stands in for the microphone, and the call goes out as `device` whichever account the app would pick.
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `${PROBE};window.__probe=installDitherProbe('device');window.__probe.patchMedia();
        const _send=WebSocket.prototype.send;WebSocket.prototype.send=function(d){try{if(typeof d==='string'&&this.url.includes('/api/call')&&d.includes('"op":"join"')){const m=JSON.parse(d);m.account=${JSON.stringify(cfg.device)};d=JSON.stringify(m);}}catch{}return _send.call(this,d);};`,
    });
    await page.goto(HUB);
    await page.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), callMode: ${JSON.stringify(mode)} }))`);
    await page.goto(`${HUB}/?mode=${mode}#/inbox/c/${cfg.conversation}`);
    await page.until(`!!document.querySelector('.call-join')`, 30_000);
    await page.eval(`document.querySelector('.call-join').click()`);
    const t0 = Date.now();
    await page.until(`document.querySelector('[data-call-phase]')?.dataset.callPhase !== 'connecting'`, 60_000);
    const joinMs = Date.now() - t0;
    const phase = await page.eval<string>(`document.querySelector('[data-call-phase]')?.dataset.callPhase`);
    if (phase !== 'live') return { error: `phase ${phase}: ${await page.eval(`document.querySelector('.call-dock-text small')?.textContent`)}` };
    await Bun.sleep(1500);
    const devSpeech = await page.eval(`window.__probe.useSpeech(Uint8Array.from(atob(${JSON.stringify(SPEECH_B64)}), c => c.charCodeAt(0)).buffer)`);
    await Bun.sleep(8000);
    const from = Date.now();
    const cost = await hold(profileDir, SECS * 1000);
    const to = Date.now();
    const d = await page.eval(`window.__probe.report(${from - 3000})`);
    const ds = await lab(cfg.device, { op: 'report', since: from - 3000 }); // the device account's sandbox (bridge: in the path)
    const p = await lab(cfg.peer, { op: 'report', since: from - 3000 });
    keepRaw(mode, { from, to, devSpeech, peerSpeech, d, ds, p });
    const callStats = await page.eval(`document.querySelector('[data-call-stats]')?.dataset.callStats`);
    await page.eval(`document.querySelector('.call-btn.leave')?.click()`);
    await Bun.sleep(2000);
    return {
      joinMs,
      cost,
      peerToDevice: bestSpeech(d, peerSpeech, from, to),
      peerToDeviceSandbox: mode === 'bridge' ? bestSpeech(ds, peerSpeech, from, to) : undefined,
      deviceToPeer: bestSpeech(p, devSpeech, from, to),
      deviceRtp: rtpSummary(d, from),
      peerRtp: rtpSummary(p, from),
      deviceSandboxRtp: mode === 'bridge' ? rtpSummary(ds, from) : undefined,
      appStats: callStats ? JSON.parse(callStats) : null,
    };
  } finally {
    await close();
    await leaveAll();
  }
}

async function videoScenario() {
  for (const a of [cfg.device, cfg.peer]) {
    await lab(a, { op: 'join', channelId: cfg.channelId });
    await evalIn(a, `await labFind((x) => typeof x.transitionToGuildSync === 'function').transitionToGuildSync(${JSON.stringify(cfg.guildId)}, {}, ${JSON.stringify(cfg.channelId)}); return true`);
  }
  await Bun.sleep(4000);
  for (const a of [cfg.device, cfg.peer]) await lab(a, { op: 'video', on: true });
  await Bun.sleep(12000);
  const from = Date.now();
  const cost = await hold(null, SECS * 1000);
  const [d, p] = [await lab(cfg.device, { op: 'report', since: from - 3000 }), await lab(cfg.peer, { op: 'report', since: from - 3000 })];
  for (const a of [cfg.device, cfg.peer]) await lab(a, { op: 'video', on: false });
  await leaveAll();
  return { cost, peerToDevice: videoLatency(d, from), deviceToPeer: videoLatency(p, from), deviceRtp: rtpSummary(d, from), peerRtp: rtpSummary(p, from) };
}

async function goLiveScenario() {
  for (const a of [cfg.device, cfg.peer]) {
    await lab(a, { op: 'join', channelId: cfg.channelId });
    await evalIn(a, `await labFind((x) => typeof x.transitionToGuildSync === 'function').transitionToGuildSync(${JSON.stringify(cfg.guildId)}, {}, ${JSON.stringify(cfg.channelId)}); return true`);
  }
  await Bun.sleep(4000);
  const g = JSON.stringify(cfg.guildId),
    c = JSON.stringify(cfg.channelId);
  // The client's own "Share your screen" path on web: getDisplayMedia (the probe's test card), then STREAM_START.
  await evalIn(cfg.peer, `const m = labFind(x => typeof x.A === 'function' && /getDesktopSource\\(/.test(Function.prototype.toString.call(x.A)) && /PRESET_CUSTOM/.test(Function.prototype.toString.call(x.A))); if (!m) throw new Error('no go-live action'); m.A(${g}, ${c}, []); return true`);
  await Bun.sleep(5000);
  const owner = await evalIn(cfg.peer, `return mod.UserStore.getCurrentUser().id`);
  await evalIn(cfg.device, `const m = labFind(x => Object.values(x).some(f => typeof f === 'function' && /type:"STREAM_WATCH"/.test(Function.prototype.toString.call(f)))); const f = Object.values(m).find(f => typeof f === 'function' && /type:"STREAM_WATCH"/.test(Function.prototype.toString.call(f))); f({streamType: 'guild', guildId: ${g}, channelId: ${c}, ownerId: ${JSON.stringify(owner)}}); return true`);
  await Bun.sleep(12000);
  const from = Date.now();
  const cost = await hold(null, SECS * 1000);
  const [d, p] = [await lab(cfg.device, { op: 'report', since: from - 3000 }), await lab(cfg.peer, { op: 'report', since: from - 3000 })];
  await leaveAll();
  return { cost, streamToViewer: videoLatency(d, from), viewerRtp: rtpSummary(d, from), streamerRtp: rtpSummary(p, from) };
}

const RUN: Record<string, () => Promise<unknown>> = { native: nativeScenario, bridge: () => deviceScenario('bridge'), direct: () => deviceScenario('direct'), video: videoScenario, golive: goLiveScenario };
const results: Record<string, unknown> = {};
/** Raw probe reports, for re-analysis (cfg.out + '.raw.json'). */
const raw: Record<string, unknown> = {};
const keepRaw = (name: string, v: unknown) => ((raw[name] = v), cfg.out && writeFileSync(cfg.out + '.raw.json', JSON.stringify(raw)));
await leaveAll();
for (const s of cfg.scenarios ?? Object.keys(RUN)) {
  console.error(`-- ${s}`);
  try {
    results[s] = await RUN[s]!();
  } catch (e: any) {
    results[s] = { error: String(e?.message ?? e) };
    await leaveAll();
  }
  console.error(JSON.stringify(results[s], null, 1));
  if (cfg.out) writeFileSync(cfg.out, JSON.stringify(results, null, 1));
}
console.log(JSON.stringify(results));
