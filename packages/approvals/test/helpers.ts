/** A fake device for tests: a WebCrypto P-256 approval key that signs statements as a phone would. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Ask, b64u, derSignature, type DeviceKey, fingerprint, messageHash, statementText } from '../src/statement.ts';

export class FakeDevice {
  constructor(
    public id: string,
    private pair: CryptoKeyPair,
    public spki: string,
  ) {}

  static async make(id = 'dev_TestPhone0001'): Promise<FakeDevice> {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
    return new FakeDevice(id, pair, spki);
  }

  key(kind = 'phone', name = 'Test phone'): DeviceKey {
    return { id: this.id, kind, key: this.spki, fingerprint: fingerprint(this.spki), name };
  }

  async sign(text: string): Promise<string> {
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.pair.privateKey, new TextEncoder().encode(text) as BufferSource));
    return b64u(derSignature(raw));
  }

  /** The full statement for `ask` answered with `action`, and its signature. */
  async answer(ask: Ask, action: string, message: string | null = null, signed = Date.now()): Promise<{ statement: string; signature: string }> {
    const statement = statementText({ ...ask, action, messageSha256: messageHash(message), device: this.id, signed });
    return { statement, signature: await this.sign(statement) };
  }
}

export function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'approvals-git-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.name', 'Test']);
  sh(dir, ['config', 'user.email', 'test@localhost']);
  sh(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

export function sh(dir: string, args: string[], input?: string): string {
  const p = Bun.spawnSync(['git', '-C', dir, ...args], { stdin: input === undefined ? 'ignore' : Buffer.from(input), stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr}`);
  return p.stdout.toString().trim();
}

export async function commitFile(dir: string, path: string, content: string, message: string): Promise<string> {
  await Bun.write(join(dir, path), content);
  sh(dir, ['add', '--', path]);
  sh(dir, ['commit', '-q', '-m', message]);
  return sh(dir, ['rev-parse', 'HEAD']);
}
