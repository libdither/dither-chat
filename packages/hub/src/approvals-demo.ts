/**
 * A demo world's devices for approvals (docs/approvals.md): a phone that never answers by itself and a laptop signer
 * whose "fingerprint" is always there, so the page's whole flow can be tried (and checked by scripts) without a manager.
 * Invented keys, made at each start.
 */
import { b64u, derSignature, messageHash, parseStatement, statementText } from '@dither-chat/approvals';
import type { ApprovalDevice, ApprovalLink, Approvals, DeviceAnswer } from './approvals.ts';

const ASK_LINES = 8;

export class DemoApprovalLink implements ApprovalLink {
  approvals: Approvals | null = null;
  private keys = new Map<string, CryptoKeyPair>();
  private spki = new Map<string, string>();
  private held = new Map<string, string>();
  private ready: Promise<void>;
  /** How long the laptop takes to "read the finger". */
  constructor(private touchMs = 600) {
    this.ready = (async () => {
      for (const id of ['dev_DemoPhone', 'dev_DemoLaptop']) {
        const k = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
        this.keys.set(id, k);
        this.spki.set(id, Buffer.from(await crypto.subtle.exportKey('spki', k.publicKey)).toString('base64'));
      }
    })();
  }

  async devices(): Promise<ApprovalDevice[]> {
    await this.ready;
    return [
      { id: 'dev_DemoPhone', name: 'Demo phone', kind: 'phone', approvalKey: this.spki.get('dev_DemoPhone')!, online: false },
      { id: 'dev_DemoLaptop', name: 'Demo laptop', kind: 'desk', approvalKey: this.spki.get('dev_DemoLaptop')!, online: true },
    ];
  }

  async ask(i: { ask: string }): Promise<{ devices: number }> {
    const id = /^id (\S+)$/m.exec(i.ask)?.[1];
    if (id) this.held.set(id, i.ask);
    return { devices: 1 };
  }

  async cancel(id: string): Promise<void> {
    this.held.delete(id);
  }

  async intent(id: string, action: string, message: string | null): Promise<{ sent: number }> {
    const ask = this.held.get(id);
    if (!ask || ask.split('\n').length - 1 !== ASK_LINES) return { sent: 0 };
    setTimeout(() => void this.sign(id, ask, action, message), this.touchMs);
    return { sent: 1 };
  }

  private async sign(id: string, ask: string, action: string, message: string | null) {
    await this.ready;
    const device = 'dev_DemoLaptop';
    const signed = Date.now();
    const text = `${ask}action ${action}\nmessage-sha256 ${messageHash(message)}\ndevice ${device}\nsigned ${signed}\n`;
    const s = parseStatement(text);
    if (typeof s === 'string' || statementText(s) !== text) return;
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.get(device)!.privateKey, new TextEncoder().encode(text) as BufferSource));
    const a: DeviceAnswer = { id, ok: true, action, message, signed, signature: b64u(derSignature(raw)), device, deviceName: 'Demo laptop', deviceKind: 'desk' };
    this.held.delete(id);
    await this.approvals?.answered(a);
  }

  async answers(): Promise<{ answers: DeviceAnswer[] }> {
    return { answers: [] };
  }
}
