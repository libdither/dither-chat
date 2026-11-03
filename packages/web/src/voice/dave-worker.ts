/**
 * The DAVE worker: Discord's end-to-end encryption for calls (MLS group state plus per-frame
 * crypto), driven by Discord's own libdave, which the hub extracts from Discord's web client and
 * serves from outside this repo (scripts/dave/).
 *
 * It runs from a data: URL, so it has an opaque origin: the extracted code can reach none of this
 * app's storage, cookies or authenticated endpoints. It is also the RTCRtpScriptTransform target,
 * so frames never leave it in plaintext form on the way out, or in ciphertext on the way in.
 *
 * The protocol logic is ours, written from the public DAVE protocol (see docs/calls.md): which
 * libdave call each gateway opcode leads to, and when a key ratchet is installed.
 *
 * workerMain is stringified, so it must not refer to anything outside itself.
 */

export function daveWorkerSource(): string {
  return `(${workerMain.toString()})();`;
}

function workerMain() {
  type Ratchet = { cipherSuite: number; baseSecret: ArrayLike<number> } | null;
  const ctx = self as any;
  let dave: any = null;
  let session: any = null;
  let keys: any = null;
  let encryptor: any = null;
  let selfId = '';
  let channelId = '';
  let latestVersion = 0;
  const pendingTransitions = new Map<number, number>();
  const decryptors = new Map<string, any>();
  const ssrcUser = new Map<number, string>();
  const users = new Set<string>();
  const queue: any[] = [];
  const counts = { encrypted: 0, decrypted: 0, dropped: 0, passthrough: 0 };

  const post = (m: any) => ctx.postMessage(m);
  const bytes = (a: ArrayLike<number>) => (a instanceof Uint8Array ? a : Uint8Array.from(a as number[]));

  ctx.onmessage = async (e: MessageEvent) => {
    const m = e.data;
    if (m.t === 'load') {
      try {
        const lib = await import(m.url);
        dave = lib.loadDave ? await lib.loadDave() : await lib.DaveModuleFactory({});
        try {
          dave.SetLogSeverity(dave.LoggingSeverity.LS_WARNING);
        } catch {}
        keys = new dave.TransientKeys();
        post({ t: 'ready', maxVersion: dave.MaxSupportedProtocolVersion(), origin: ctx.origin });
        for (const q of queue.splice(0)) handle(q);
      } catch (err: any) {
        post({ t: 'load-failed', error: String(err?.message ?? err) });
      }
      return;
    }
    if (m.t === 'rtc-transform') {
      pipe(m.operation, m.readable, m.writable);
      return;
    }
    if (!dave) queue.push(m);
    else handle(m);
  };

  // Frames from RTCRtpScriptTransform (Chrome, Safari, Firefox).
  ctx.onrtctransform = (e: any) => pipe(e.transformer.options.operation, e.transformer.readable, e.transformer.writable);

  setInterval(() => post({ t: 'counts', ...counts }), 2000);

  function handle(m: any) {
    try {
      switch (m.t) {
        case 'init':
          selfId = m.userId;
          channelId = m.channelId;
          initSession(m.version);
          return;
        case 'prepare-epoch':
          if (String(m.epoch) === '1') initSession(m.version);
          else session?.SetProtocolVersion(m.version);
          return;
        case 'external-sender':
          session?.SetExternalSender(bytes(m.data));
          return;
        case 'proposals': {
          const out = session?.ProcessProposals(bytes(m.data));
          if (out && out.length) post({ t: 'send-binary', op: 28, data: bytes(out) });
          return;
        }
        case 'commit': {
          const r = session?.ProcessCommit(bytes(m.data));
          if (!r || r.ignored) return;
          if (r.failed) {
            post({ t: 'invalid', tid: m.tid });
            initSession(session.GetProtocolVersion() || latestVersion || 1);
            return;
          }
          if (r.rosterUpdate) prepare(m.tid, session.GetProtocolVersion());
          post({ t: 'transition-ready', tid: m.tid });
          return;
        }
        case 'welcome': {
          const roster = session?.ProcessWelcome(bytes(m.data));
          if (!roster) {
            post({ t: 'invalid', tid: m.tid });
            post({ t: 'send-binary', op: 26, data: bytes(session.GetMarshalledKeyPackage()) });
            return;
          }
          prepare(m.tid, session.GetProtocolVersion());
          post({ t: 'transition-ready', tid: m.tid });
          return;
        }
        case 'prepare-transition':
          prepare(m.tid, m.version);
          if (m.tid !== 0) post({ t: 'transition-ready', tid: m.tid });
          return;
        case 'execute-transition': {
          if (!pendingTransitions.has(m.tid)) return;
          const v = pendingTransitions.get(m.tid)!;
          pendingTransitions.delete(m.tid);
          if (v === 0) session?.Reset();
          setEncrypt(v);
          return;
        }
        case 'user-add':
          for (const id of m.ids as string[]) {
            if (id === selfId || users.has(id)) continue;
            users.add(id);
            session?.AddRecognizedUser(id);
            setDecrypt(id, latestVersion);
          }
          return;
        case 'user-remove':
          users.delete(m.id);
          session?.RemoveRecognizedUser(m.id);
          decryptors.get(m.id)?.delete?.();
          decryptors.delete(m.id);
          for (const [s, u] of ssrcUser) if (u === m.id) ssrcUser.delete(s);
          return;
        case 'ssrc':
          if (ssrcUser.get(m.ssrc) && ssrcUser.get(m.ssrc) !== m.id) return;
          ssrcUser.set(m.ssrc, m.id);
          return;
      }
    } catch (err: any) {
      post({ t: 'error', where: m.t, error: String(err?.message ?? err) });
    }
  }

  function initSession(version: number) {
    if (!session) session = new dave.Session('', '', (source: string, reason: string) => post({ t: 'mls-failure', source, reason }));
    latestVersion = version;
    session.Init(version, BigInt(channelId), selfId, keys.GetTransientPrivateKey(version));
    for (const id of users) session.AddRecognizedUser(id);
    post({ t: 'send-binary', op: 26, data: bytes(session.GetMarshalledKeyPackage()) });
  }

  /** Every remote user gets the new decrypt key now; our own encrypt key waits for the transition's execute, unless it is the first. */
  function prepare(tid: number, version: number) {
    latestVersion = version;
    for (const id of users) setDecrypt(id, version);
    if (tid === 0) setEncrypt(version);
    else pendingTransitions.set(tid, version);
  }

  function ratchet(id: string, version: number): Ratchet {
    if (version === 0 || !session) return null;
    try {
      return session.GetKeyRatchet(id) ?? null;
    } catch {
      return null;
    }
  }

  function setEncrypt(version: number) {
    const kr = ratchet(selfId, version);
    if (!encryptor) encryptor = new dave.Encryptor();
    encryptor.SetPassthroughMode(version === 0 && !kr);
    encryptor.SetKeyRatchet(kr);
    let auth: number[] = [];
    try {
      auth = session ? Array.from(session.GetLastEpochAuthenticator() as number[]) : [];
    } catch {}
    post({ t: 'secure', version, epochAuthenticator: auth });
  }

  function setDecrypt(id: string, version: number) {
    let d = decryptors.get(id);
    if (!d) decryptors.set(id, (d = new dave.Decryptor()));
    const kr = ratchet(id, version);
    d.TransitionToPassthroughMode(version === 0 && !kr);
    d.TransitionToKeyRatchet(kr);
  }

  function pipe(operation: number, readable: ReadableStream, writable: WritableStream) {
    readable
      .pipeThrough(
        new TransformStream({
          transform(frame: any, out) {
            const r = operation === 0 ? encrypt(frame) : decrypt(frame);
            if (r) out.enqueue(frame);
          },
        }),
      )
      .pipeTo(writable)
      .catch(() => {});
  }

  function crypt(frame: any, cap: number, run: (ptr: number, len: number) => number): boolean {
    const src = new Uint8Array(frame.data);
    const ptr = dave._malloc(cap);
    try {
      dave.HEAPU8.set(src, ptr);
      const n = run(ptr, src.byteLength);
      if (!n) return false;
      frame.data = dave.HEAPU8.slice(ptr, ptr + n).buffer;
      return true;
    } finally {
      dave._free(ptr);
    }
  }

  // Outgoing: no Encryptor yet means no key yet (alone in the call, or mid-join): drop, as Discord's client does.
  function encrypt(frame: any): boolean {
    if (!encryptor || !dave) return (counts.dropped++, false);
    if (frame.data.byteLength === 0) return true;
    const ssrc = frame.getMetadata().synchronizationSource;
    if (!ssrc) return (counts.dropped++, false);
    try {
      encryptor.AssignSsrcToCodec(ssrc, dave.Codec.Opus);
      const len = frame.data.byteLength;
      const ok = crypt(frame, encryptor.GetMaxCiphertextByteSize(dave.MediaType.Audio, len), (p, l) => encryptor.Encrypt(dave.MediaType.Audio, ssrc, p, l, encryptor.GetMaxCiphertextByteSize(dave.MediaType.Audio, l)));
      ok ? counts.encrypted++ : counts.dropped++;
      return ok;
    } catch {
      counts.dropped++;
      return false;
    }
  }

  function decrypt(frame: any): boolean {
    if (frame.data.byteLength === 0) return true;
    const ssrc = frame.getMetadata().synchronizationSource;
    const d = decryptors.get(ssrcUser.get(ssrc) ?? '');
    if (!d || !dave) {
      // DAVE off for the whole call (no session at all): media is plain.
      if (!session && latestVersion === 0) return (counts.passthrough++, true);
      return (counts.dropped++, false);
    }
    try {
      const len = frame.data.byteLength;
      const ok = crypt(frame, d.GetMaxPlaintextByteSize(dave.MediaType.Audio, len), (p, l) => d.Decrypt(dave.MediaType.Audio, p, l, d.GetMaxPlaintextByteSize(dave.MediaType.Audio, l)));
      ok ? counts.decrypted++ : counts.dropped++;
      return ok;
    } catch {
      counts.dropped++;
      return false;
    }
  }
}
