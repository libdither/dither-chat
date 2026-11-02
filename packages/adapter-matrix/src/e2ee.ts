/**
 * End-to-end encryption: one OlmMachine from matrix-sdk-crypto-wasm (the Rust crypto Element uses),
 * and the Client-Server requests it asks for. No Olm or Megolm is implemented here.
 *
 * Loaded only for accounts that set encryption up: the module is 8 MB of WebAssembly, and
 * creating the machine is what generates a device's keys.
 *
 * Never logged: request bodies, keys, the store key, the recovery key, decrypted content.
 */

import * as M from '@matrix-org/matrix-sdk-crypto-wasm';
import { join } from 'node:path';
import { CryptoStore } from './cryptostore.ts';
import { enc, MatrixError, type MatrixClient } from './http.ts';
import { checkSecretKey, decodeRecoveryKey, decryptSecret, keyFromPassphrase, type SecretKeyInfo, type SecretPayload } from './recovery.ts';
import type { MxEvent } from './rooms.ts';

export const MEGOLM = 'm.megolm.v1.aes-sha2';
const BACKUP_ALGORITHM = 'm.megolm_backup.v1.curve25519-aes-sha2';
const BACKUP_SECRET = 'm.megolm_backup.v1';
/** How long a session the backup did not have is left alone. Another client may upload it later. */
const BACKUP_RETRY_MS = 60 * 60 * 1000;
const BACKUP_WORKERS = 4;
/** When someone else asked for the verification, they normally start the emoji step. After this, we do. */
const START_SAS_AFTER_MS = 3000;

export interface E2eeOptions {
  dir: string;
  userId: string;
  deviceId: string;
  /** 32 random bytes, base64, kept in secret.json. The library encrypts the store's values with it. */
  storeKey: string;
  /** Asked each time: a relogin replaces the client. */
  client: () => MatrixClient;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  /** Keys for these sessions just arrived (a to-device message, the backup, another device). */
  onRoomKeys: (keys: { roomId: string; sessionId: string }[]) => void;
  onVerification: (v: VerificationState | null) => void;
}

export interface VerificationState {
  flowId: string;
  /** requested: they asked, waiting for you. waiting: for them. compare: emoji on screen. confirmed: you said yes, waiting for them. */
  phase: 'requested' | 'waiting' | 'compare' | 'confirmed';
  otherDevice: string | null;
  emoji?: { symbol: string; description: string }[];
  decimals?: number[];
}

export interface Decrypted {
  type: string;
  content: any;
}

export interface RoomEncryption {
  /** m.room.encryption content */
  settings: { algorithm?: unknown; rotation_period_ms?: unknown; rotation_period_msgs?: unknown };
  historyVisibility?: string;
}

const HISTORY: Record<string, M.HistoryVisibility> = {
  invited: M.HistoryVisibility.Invited,
  joined: M.HistoryVisibility.Joined,
  shared: M.HistoryVisibility.Shared,
  world_readable: M.HistoryVisibility.WorldReadable,
};

/** Media types the hub may serve as what they claim. Anything else from a sender (HTML, SVG, ...) stays a download. */
export function safeMediaType(mime: unknown): string {
  if (typeof mime !== 'string') return 'application/octet-stream';
  const m = mime.split(';')[0].trim().toLowerCase();
  if (/^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/[\w.+-]+|text\/plain|application\/pdf)$/.test(m)) return m;
  return 'application/octet-stream';
}

export function encryptAttachment(bytes: Uint8Array): { data: Uint8Array; file: Record<string, unknown> } {
  const a = M.Attachment.encrypt(bytes);
  // In this order: reading the info consumes it, and it is what the data's hash lives in.
  const data = a.encryptedData;
  const info = a.mediaEncryptionInfo;
  if (!info) throw new Error('the library returned no attachment key');
  return { data, file: JSON.parse(info) };
}

/** Checks the ciphertext's hash, so a server that swaps the file gets an error rather than garbage. */
export function decryptAttachment(data: Uint8Array, file: Record<string, unknown>): Uint8Array {
  const { url: _url, ...info } = file;
  return M.Attachment.decrypt(new M.EncryptedAttachment(data, JSON.stringify(info)));
}

export class E2ee {
  readonly identity: { ed25519: string; curve25519: string };
  readonly deviceId: string;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private roomQueues = new Map<string, Promise<unknown>>();
  private tracked = new Set<string>();
  private backup: { version: string; key: M.BackupDecryptionKey; publicKey: string } | null = null;
  private backupTried = new Map<string, number>();
  private backupQueue: { roomId: string; sessionId: string }[] = [];
  private backupWorkers = 0;
  private flow: { id: string; startSasAt: number | null } | null = null;
  private verification: VerificationState | null = null;
  private verificationResult: string | null = null;
  private verificationTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastFlushError: string | null = null;

  private constructor(
    private readonly opts: E2eeOptions,
    private readonly machine: M.OlmMachine,
    private readonly store: CryptoStore,
  ) {
    this.deviceId = opts.deviceId;
    const k = machine.identityKeys;
    this.identity = { ed25519: k.ed25519.toBase64(), curve25519: k.curve25519.toBase64() };
  }

  /**
   * Open the store, creating the device's keys if it is empty. Nothing leaves this
   * machine until the first flush().
   */
  static async open(opts: E2eeOptions): Promise<E2ee> {
    await M.initAsync();
    const store = await CryptoStore.open(join(opts.dir, 'crypto.sqlite'));
    try {
      const key = new Uint8Array(Buffer.from(opts.storeKey, 'base64'));
      if (key.length !== 32) throw new Error('the store key in secret.json is not 32 bytes');
      const handle = await M.StoreHandle.openWithKey(`dither:${opts.deviceId}`, key);
      const machine = await M.OlmMachine.initFromStore(new M.UserId(opts.userId), new M.DeviceId(opts.deviceId), handle);
      const self = new E2ee(opts, machine, store);
      await machine.registerRoomKeyUpdatedCallback(async (infos) => {
        opts.onRoomKeys(infos.map((i) => ({ roomId: i.roomId.toString(), sessionId: i.sessionId })));
      });
      await machine.registerReceiveSecretCallback(async (name, value) => {
        if (name === BACKUP_SECRET) await self.acceptBackupSecret(value).catch((e) => opts.log('warn', `could not use the backup key another device sent: ${e.message}`));
      });
      await self.track([opts.userId]);
      const saved = await machine.getBackupKeys();
      if (saved.decryptionKey && saved.backupVersion) self.backup = { version: saved.backupVersion, key: saved.decryptionKey, publicKey: saved.decryptionKey.megolmV1PublicKey.publicKeyBase64 };
      return self;
    } catch (e) {
      store.close();
      throw e;
    }
  }

  close() {
    this.stopped = true;
    if (this.verificationTimer) clearTimeout(this.verificationTimer);
    this.machine.close();
    this.store.close();
  }

  // ---------------------------------------------------------------- requests the machine wants made

  private async sendRequest(req: any) {
    const c = this.opts.client();
    const json = { contentType: 'application/json', body: req.body };
    let res: unknown;
    switch (req.type) {
      case M.RequestType.KeysUpload:
        res = await c.request('POST', '/_matrix/client/v3/keys/upload', json);
        break;
      case M.RequestType.KeysQuery:
        res = await c.request('POST', '/_matrix/client/v3/keys/query', json);
        break;
      case M.RequestType.KeysClaim:
        res = await c.request('POST', '/_matrix/client/v3/keys/claim', json);
        break;
      case M.RequestType.ToDevice:
        res = await c.request('PUT', `/_matrix/client/v3/sendToDevice/${enc(req.event_type)}/${enc(req.txn_id)}`, json);
        break;
      case M.RequestType.SignatureUpload:
        res = await c.request('POST', '/_matrix/client/v3/keys/signatures/upload', json);
        break;
      case M.RequestType.RoomMessage:
        res = await c.request('PUT', `/_matrix/client/v3/rooms/${enc(req.room_id)}/send/${enc(req.event_type)}/${enc(req.txn_id)}`, json);
        break;
      case M.RequestType.KeysBackup:
        res = await c.request('PUT', '/_matrix/client/v3/room_keys/keys', { ...json, query: { version: req.version } });
        break;
      default:
        throw new Error(`unknown crypto request type ${req.type}`);
    }
    if (req.id) await this.machine.markRequestAsSent(req.id, req.type, JSON.stringify(res));
  }

  /** Make every request the machine has queued. One flush at a time; a call during one runs another round after it. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      let firstError: unknown = null;
      do {
        this.flushAgain = false;
        const reqs = await this.machine.outgoingRequests();
        const results = await Promise.allSettled(reqs.map((r) => this.sendRequest(r)));
        for (const r of results) if (r.status === 'rejected') firstError ??= r.reason;
        await this.uploadToBackup().catch((e: unknown) => (firstError ??= e));
      } while (this.flushAgain && !this.stopped);
      this.lastFlushError = firstError ? String((firstError as Error).message ?? firstError) : null;
      if (firstError) throw firstError;
    })().finally(() => (this.flushing = null));
    return this.flushing;
  }

  /** Room keys this device holds that the backup does not, so another client can read what only we received. */
  private async uploadToBackup() {
    if (!this.backup || !(await this.machine.isBackupEnabled())) return;
    for (;;) {
      const req = await this.machine.backupRoomKeys();
      if (!req) return;
      try {
        await this.sendRequest(req);
      } catch (e) {
        if (e instanceof MatrixError && (e.errcode === 'M_WRONG_ROOM_KEYS_VERSION' || e.errcode === 'M_NOT_FOUND')) {
          this.opts.log('warn', 'the room key backup changed on the server; no longer uploading to it');
          await this.machine.disableBackup();
          return;
        }
        throw e;
      }
    }
  }

  // ---------------------------------------------------------------- /sync

  /** The crypto half of a sync response. Runs before its timelines, so keys in this batch decrypt the events in it. */
  async receiveSync(res: any) {
    const toDevice = Array.isArray(res.to_device?.events) ? res.to_device.events : [];
    const changed = (res.device_lists?.changed ?? []).flatMap(toUserId);
    const left = (res.device_lists?.left ?? []).flatMap(toUserId);
    const counts = new Map<string, number>(Object.entries(res.device_one_time_keys_count ?? {}));
    const fallback = Array.isArray(res.device_unused_fallback_key_types) ? new Set<string>(res.device_unused_fallback_key_types) : undefined;
    await this.machine.receiveSyncChanges(JSON.stringify(toDevice), new M.DeviceLists(changed, left), counts, fallback, new M.DecryptionSettings(M.TrustRequirement.Untrusted));
    await this.flush().catch((e) => this.opts.log('warn', `crypto requests failed, retrying after the next sync: ${e.message}`));
    await this.tickVerification().catch((e) => this.opts.log('warn', `verification: ${e.message}`));
  }

  private async track(users: string[]) {
    const fresh = users.filter((u) => !this.tracked.has(u));
    if (!fresh.length) return;
    for (const u of fresh) this.tracked.add(u);
    await this.machine.updateTrackedUsers(fresh.flatMap(toUserId));
  }

  // ---------------------------------------------------------------- decrypt

  /** null: no key for it (yet). The caller keeps it for a retry. */
  async decrypt(ev: MxEvent, roomId: string): Promise<Decrypted | null> {
    try {
      const d = await this.machine.decryptRoomEvent(JSON.stringify(ev), new M.RoomId(roomId), new M.DecryptionSettings(M.TrustRequirement.Untrusted));
      const clear = JSON.parse(d.event);
      const content = clear.content ?? {};
      // Relations travel outside the ciphertext, and the library may leave them there.
      if (!content['m.relates_to'] && ev.content?.['m.relates_to']) content['m.relates_to'] = ev.content['m.relates_to'];
      return { type: clear.type, content };
    } catch (e: any) {
      if (e instanceof M.MegolmDecryptionError) this.opts.log('debug', `no key for ${ev.event_id}: ${M.DecryptionErrorCode[e.code]}${e.withheldCode ? ` (withheld: ${e.withheldCode})` : ''}`);
      else this.opts.log('warn', `could not decrypt ${ev.event_id}: ${e?.message ?? e}`);
      return null;
    }
  }

  // ---------------------------------------------------------------- encrypt

  /** One thing at a time per room: a second send must not race the first one's key share. */
  private inRoom<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.roomQueues.get(roomId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.roomQueues.set(roomId, tail);
    void tail.then(() => {
      if (this.roomQueues.get(roomId) === tail) this.roomQueues.delete(roomId);
    });
    return next;
  }

  /**
   * The content of an m.room.encrypted event, with the room key shared with every device
   * of `members` first. Throws if any step fails. The caller must then not send at all.
   */
  encrypt(roomId: string, members: string[], room: RoomEncryption, type: string, content: unknown): Promise<any> {
    if (room.settings.algorithm !== MEGOLM) throw new Error(`this room uses an encryption algorithm we do not support (${String(room.settings.algorithm)})`);
    return this.inRoom(roomId, async () => {
      await this.track(members);
      await this.flush(); // the device lists of anyone just tracked; sharing without them would skip their devices
      const claim = await this.machine.getMissingSessions(members.flatMap(toUserId));
      if (claim) await this.sendRequest(claim);
      const settings = new M.EncryptionSettings();
      settings.algorithm = M.EncryptionAlgorithm.MegolmV1AesSha2;
      settings.sharingStrategy = M.CollectStrategy.allDevices();
      settings.historyVisibility = HISTORY[room.historyVisibility ?? ''] ?? M.HistoryVisibility.Shared;
      if (Number.isSafeInteger(room.settings.rotation_period_ms)) settings.rotationPeriod = BigInt(room.settings.rotation_period_ms as number) * 1000n;
      if (Number.isSafeInteger(room.settings.rotation_period_msgs)) settings.rotationPeriodMessages = BigInt(room.settings.rotation_period_msgs as number);
      const rid = new M.RoomId(roomId);
      for (const req of await this.machine.shareRoomKey(rid, members.flatMap(toUserId), settings)) await this.sendRequest(req);
      return JSON.parse(await this.machine.encryptRoomEvent(rid, type, JSON.stringify(content)));
    });
  }

  encryptAttachment = encryptAttachment;
  decryptAttachment = decryptAttachment;
  safeMediaType = safeMediaType;

  // ---------------------------------------------------------------- recovery key and backup

  private accountData<T = any>(type: string): Promise<T | null> {
    const c = this.opts.client();
    return c.request<T>('GET', `/_matrix/client/v3/user/${enc(this.opts.userId)}/account_data/${enc(type)}`, { retries: 1 }).catch((e) => {
      if (e instanceof MatrixError && (e.status === 404 || e.errcode === 'M_NOT_FOUND')) return null;
      throw e;
    });
  }

  private async backupInfo(): Promise<{ version: string; publicKey: string } | null> {
    try {
      const info: any = await this.opts.client().request('GET', '/_matrix/client/v3/room_keys/version', { retries: 1 });
      if (info?.algorithm !== BACKUP_ALGORITHM || typeof info?.auth_data?.public_key !== 'string' || typeof info.version !== 'string') return null;
      return { version: info.version, publicKey: info.auth_data.public_key.replace(/=+$/, '') };
    } catch (e) {
      if (e instanceof MatrixError && (e.status === 404 || e.errcode === 'M_NOT_FOUND')) return null;
      throw e;
    }
  }

  private async useBackupKey(base64: string): Promise<boolean> {
    const info = await this.backupInfo();
    if (!info) return false;
    const key = M.BackupDecryptionKey.fromBase64(base64);
    const publicKey = key.megolmV1PublicKey.publicKeyBase64.replace(/=+$/, '');
    if (publicKey !== info.publicKey) return false;
    await this.machine.saveBackupDecryptionKey(key, info.version);
    await this.machine.enableBackupV1(publicKey, info.version);
    this.backup = { version: info.version, key, publicKey };
    this.backupTried.clear();
    return true;
  }

  private async acceptBackupSecret(value: string) {
    if (this.backup) return;
    if (await this.useBackupKey(value)) {
      this.opts.log('info', 'received the room key backup key from a verified device');
      await this.machine.deleteSecretsFromInbox(BACKUP_SECRET);
    }
  }

  /** Is the saved backup still the one on the server, and may we write to it? Run at startup. */
  async resumeBackup() {
    if (!this.backup) return;
    const info = await this.backupInfo();
    if (!info || info.publicKey !== this.backup.publicKey.replace(/=+$/, '')) {
      this.opts.log('warn', 'the room key backup on the server is not the one the saved key opens; ignoring it');
      await this.machine.disableBackup();
      this.backup = null;
      return;
    }
    if (info.version !== this.backup.version) await this.machine.saveBackupDecryptionKey(this.backup.key, info.version);
    this.backup.version = info.version;
    await this.machine.enableBackupV1(this.backup.publicKey, info.version);
  }

  /**
   * Whatever the user pasted: a backup key, a Secret Storage key, or a Secret Storage passphrase.
   * With Secret Storage this also imports the cross-signing keys and signs this device with them,
   * which is what verifying with a recovery key means. Throws if the input opens nothing.
   */
  async applyRecoveryKey(input: string): Promise<{ backup: boolean; crossSigned: boolean }> {
    await this.flush().catch(() => {}); // our own identity, needed before cross-signing keys can be checked against it
    const defaultKey = await this.accountData<{ key?: string }>('m.secret_storage.default_key');
    const keyId = typeof defaultKey?.key === 'string' ? defaultKey.key : null;
    const keyInfo = keyId ? await this.accountData<SecretKeyInfo>(`m.secret_storage.key.${keyId}`) : null;
    let key = decodeRecoveryKey(input);
    if (!key && keyInfo) key = await keyFromPassphrase(input.trim(), keyInfo);
    if (!key) throw new Error('that is not a recovery key (expected something like "EsT… …", 48 letters and digits)');

    const secret = async (name: string): Promise<string | null> => {
      const payload = (await this.accountData<{ encrypted?: Record<string, SecretPayload> }>(name))?.encrypted?.[keyId!];
      return payload ? decryptSecret(key!, name, payload) : null;
    };
    if (keyInfo && (await checkSecretKey(key, keyInfo))) {
      const backupSecret = await secret(BACKUP_SECRET);
      const backup = backupSecret ? await this.useBackupKey(backupSecret.trim()) : false;
      const crossSigned = await this.importCrossSigning(secret).catch((e) => {
        this.opts.log('warn', `could not import the cross-signing keys: ${e.message}`);
        return false;
      });
      return { backup, crossSigned };
    }
    if (await this.useBackupKey(Buffer.from(key).toString('base64').replace(/=+$/, ''))) return { backup: true, crossSigned: false };
    throw new Error('that key does not open the room key backup or Secret Storage of this account');
  }

  private async importCrossSigning(secret: (name: string) => Promise<string | null>): Promise<boolean> {
    const [master, selfSigning, userSigning] = await Promise.all([secret('m.cross_signing.master'), secret('m.cross_signing.self_signing'), secret('m.cross_signing.user_signing')]);
    if (!selfSigning) return false;
    await this.machine.importCrossSigningKeys(master, selfSigning, userSigning);
    return this.signOurDevice();
  }

  private async signOurDevice(): Promise<boolean> {
    const status = await this.machine.crossSigningStatus();
    if (!status.hasSelfSigning) return false;
    const device = await this.machine.getDevice(new M.UserId(this.opts.userId), new M.DeviceId(this.opts.deviceId));
    if (!device) return false;
    await this.sendRequest(await device.verify());
    return true;
  }

  /** A session we have no key for: ask the backup for just that one. Fetching a whole backup can be gigabytes, and most of it is never read. */
  wantSession(roomId: string, sessionId: string) {
    if (!this.backup) return;
    const id = `${roomId}|${sessionId}`;
    const tried = this.backupTried.get(id);
    if (tried !== undefined && Date.now() - tried < BACKUP_RETRY_MS) return;
    this.backupTried.set(id, Date.now());
    this.backupQueue.push({ roomId, sessionId });
    while (this.backupWorkers < BACKUP_WORKERS) {
      this.backupWorkers++;
      void this.backupWorker().finally(() => this.backupWorkers--);
    }
  }

  private async backupWorker() {
    for (let next = this.backupQueue.shift(); next && !this.stopped; next = this.backupQueue.shift()) {
      const b = this.backup;
      if (!b) return;
      try {
        const data: any = await this.opts.client().request('GET', `/_matrix/client/v3/room_keys/keys/${enc(next.roomId)}/${enc(next.sessionId)}`, { query: { version: b.version }, retries: 1 });
        const s = data?.session_data;
        const session = JSON.parse(b.key.decryptV1(s.ephemeral, s.mac, s.ciphertext));
        session.session_id = next.sessionId;
        session.room_id = next.roomId;
        // The library reports it through the room key callback, which is what retries the events.
        await this.machine.importBackedUpRoomKeys(new Map([[new M.RoomId(next.roomId), new Map([[next.sessionId, session]])]]), undefined as any, b.version);
      } catch (e: any) {
        if (!(e instanceof MatrixError && (e.status === 404 || e.errcode === 'M_NOT_FOUND'))) this.opts.log('warn', `could not restore a key from the backup: ${e?.message ?? e}`);
      }
    }
  }

  // ---------------------------------------------------------------- verification with another of your devices

  private currentRequest(): M.VerificationRequest | undefined {
    return this.flow ? this.machine.getVerificationRequest(new M.UserId(this.opts.userId), this.flow.id) : undefined;
  }

  private setVerification(v: VerificationState | null) {
    if (JSON.stringify(v) === JSON.stringify(this.verification)) return;
    this.verification = v;
    this.opts.onVerification(v);
  }

  /** Drive the flow from what the machine says now. Runs after each sync and each action. */
  private async tickVerification(): Promise<void> {
    const user = new M.UserId(this.opts.userId);
    if (!this.flow) {
      const open = this.machine.getVerificationRequests(user).find((r) => !r.isDone() && !r.isCancelled() && !r.timedOut() && !r.isPassive());
      if (!open) return;
      this.flow = { id: open.flowId, startSasAt: null };
      this.verificationResult = null;
    }
    const req = this.currentRequest();
    if (!req || req.isDone() || req.isCancelled() || req.timedOut()) {
      const verified = !!req?.isDone();
      this.verificationResult = verified ? 'verified' : (req?.cancelInfo?.reason() ?? 'cancelled');
      this.flow = null;
      this.setVerification(null);
      if (verified) await this.afterVerified();
      return this.tickVerification(); // there may be another
    }
    const base = { flowId: req.flowId, otherDevice: req.otherDeviceId?.toString() ?? null };
    const phase = req.phase();
    if (phase === M.VerificationRequestPhase.Requested || phase === M.VerificationRequestPhase.Created) {
      return this.setVerification({ ...base, phase: !req.weStarted() && phase === M.VerificationRequestPhase.Requested ? 'requested' : 'waiting' });
    }
    if (phase === M.VerificationRequestPhase.Ready) {
      // Whoever goes first wins; if both do the library settles it the way the spec says.
      if (req.weStarted() || (this.flow.startSasAt !== null && Date.now() >= this.flow.startSasAt)) {
        const started = await req.startSas();
        if (started) await this.sendRequest(started[1]);
        return this.tickVerification();
      }
      if (this.flow.startSasAt === null) {
        this.flow.startSasAt = Date.now() + START_SAS_AFTER_MS;
        this.verificationTimer = setTimeout(() => void this.tickVerification().catch((e: Error) => this.opts.log('warn', `verification: ${e.message}`)), START_SAS_AFTER_MS + 50);
      }
      return this.setVerification({ ...base, phase: 'waiting' });
    }
    const sas = req.getVerification();
    if (!(sas instanceof M.Sas)) return this.setVerification({ ...base, phase: 'waiting' });
    if (!sas.weStarted() && !sas.hasBeenAccepted()) {
      const out = sas.accept();
      if (out) await this.sendRequest(out);
    }
    await this.flush().catch(() => {});
    if (sas.haveWeConfirmed()) return this.setVerification({ ...base, phase: 'confirmed' });
    const emoji = sas.emoji();
    if (!sas.canBePresented() || !emoji) return this.setVerification({ ...base, phase: 'waiting' });
    this.setVerification({ ...base, phase: 'compare', emoji: emoji.map((e) => ({ symbol: e.symbol, description: e.description })), decimals: Array.from(sas.decimals() ?? []) });
  }

  private async afterVerified() {
    this.opts.log('info', 'verification with another device finished');
    // Now that it trusts us, that device will answer for the backup key and the cross-signing keys.
    await this.machine.requestMissingSecretsIfNeeded();
    await this.flush().catch(() => {});
  }

  async verifyAction(op: string) {
    const user = new M.UserId(this.opts.userId);
    if (op === 'start') {
      const own: any = await this.machine.getIdentity(user);
      if (!own?.requestVerification) throw new Error('this account has no cross-signing identity to verify against; set one up in another client first');
      const [req, out] = await own.requestVerification([M.VerificationMethod.SasV1]);
      await this.sendRequest(out);
      this.flow = { id: req.flowId, startSasAt: null };
      this.verificationResult = null;
      return this.tickVerification();
    }
    const req = this.currentRequest();
    if (!req) throw new Error('no verification is in progress');
    const sas = req.getVerification();
    let outgoing: any[] = [];
    switch (op) {
      case 'accept':
        outgoing = [req.acceptWithMethods([M.VerificationMethod.SasV1])];
        break;
      case 'confirm':
        if (!(sas instanceof M.Sas) || !sas.emoji()) throw new Error('there are no emoji to confirm yet');
        outgoing = await sas.confirm();
        break;
      case 'mismatch':
        if (sas instanceof M.Sas) outgoing = [sas.cancelWithCode('m.mismatched_sas')];
        else outgoing = [req.cancel()];
        break;
      case 'cancel':
        outgoing = [sas instanceof M.Sas ? sas.cancel() : req.cancel()];
        break;
      default:
        throw new Error(`unknown verification step "${op}"`);
    }
    for (const out of outgoing) if (out) await this.sendRequest(out);
    await this.flush().catch(() => {});
    await this.tickVerification();
  }

  // ---------------------------------------------------------------- status

  async status() {
    const user = new M.UserId(this.opts.userId);
    const device = await this.machine.getDevice(user, new M.DeviceId(this.opts.deviceId)).catch(() => undefined);
    const cross = await this.machine.crossSigningStatus();
    const counts = await this.machine.roomKeyCounts();
    return {
      active: true,
      userId: this.opts.userId,
      deviceId: this.opts.deviceId,
      /** Compare this with what another client shows for this device. */
      fingerprint: this.identity.ed25519,
      verified: !!device?.isCrossSigningTrusted(),
      crossSigning: { master: cross.hasMaster, selfSigning: cross.hasSelfSigning, userSigning: cross.hasUserSigning },
      backup: this.backup ? { version: this.backup.version, enabled: await this.machine.isBackupEnabled() } : null,
      roomKeys: counts.total,
      verification: this.verification,
      lastVerification: this.verificationResult,
      lastError: this.lastFlushError,
    };
  }
}

/** Server-supplied user ids go through the library's parser, and one bad id must not sink a whole batch. */
function toUserId(u: unknown): M.UserId[] {
  try {
    return typeof u === 'string' ? [new M.UserId(u)] : [];
  } catch {
    return [];
  }
}
