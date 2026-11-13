/**
 * The demo's side of an account's own self (accountself.ts, docs/account-self.md): a Discord demo account answers
 * block, ignore, presence, sessions and the profile fields beyond the bio as the real adapter does, and says its
 * presence and folders after connect. Kept in its account dir, so a restart keeps what was set. No notice by default:
 * a verify script asks for one (action `notice`), so the demo's account card stays as it was otherwise.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { OWN_PRESENCE_STATES, SELF_LIMITS } from '@dither-chat/protocol';

/** The self capabilities the demo's Discord accounts have. */
export const DEMO_SELF_CAPS: P.Capability[] = ['block', 'ignore', 'setPresence', 'sessions'];

/** What setProfile takes on Discord (PersonAbout.editable). */
const EDITABLE: P.ProfileField[] = ['bio', 'name', 'avatar', 'pronouns', 'banner', 'accent'];

interface State {
  presence: P.OwnPresence;
  ignored: string[];
  name?: string;
  pronouns?: string;
  avatar?: string | null;
  notices: P.AccountNotice[];
}

const SELF_COMMANDS = new Set(['block', 'ignore', 'setPresence', 'sessions']);

export class DemoSelf {
  private state: State;
  constructor(
    private network: P.Network,
    private self: P.IdentityFact,
    private dir: string,
    private emit: (ev: P.AdapterEvent) => void,
    /** The account's own spaces, communities first, in the order the demo has them. */
    private spaces: string[],
    /** Blocks someone the way the demo's Add does (its list says it), or with null unblocks them. */
    private block: (who: string, blocked: boolean) => void,
  ) {
    const f = join(dir, 'self.json');
    const kept = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Partial<State>) : {};
    this.state = { presence: { state: 'online' }, ignored: [], notices: [], ...kept };
  }

  private save() {
    writeFileSync(join(this.dir, 'self.json'), JSON.stringify(this.state));
  }

  /** After connect: presence and folders, whom it ignores, and any notice a verify script asked for. */
  start() {
    if (this.network !== 'discord') return;
    const [a, b, ...rest] = this.spaces;
    const folders: P.NetworkFolder[] = [...(a && b ? [{ id: '1', name: 'Projects', color: '#5865f2', spaces: [a, b] }] : a ? [{ spaces: [a] }] : []), ...rest.map((s) => ({ spaces: [s] }))];
    this.emit({ t: 'selfState', state: { presence: this.state.presence, folders, privacy: [{ label: 'Direct messages from server members', value: 'Allowed' }, { label: 'Message requests', value: 'On for servers you do not know' }] } });
    this.emit({ t: 'ignored', identities: this.state.ignored });
    this.emit({ t: 'notices', notices: this.state.notices });
    if (this.state.name || this.state.avatar !== undefined) this.emitSelf();
  }

  private emitSelf() {
    this.emit({ t: 'identity', identity: { ...this.self, isSelf: true, ...(this.state.name ? { displayName: this.state.name } : {}) } });
  }

  /** A profile as the demo has it, with your own fields and what setProfile takes. */
  decorate(who: string, about: P.PersonAbout): P.PersonAbout {
    if (this.network !== 'discord') return about;
    const me = who === this.self.nativeId;
    return {
      ...about,
      ...(me ? { editable: EDITABLE } : {}),
      ...(me && this.state.name ? { displayName: this.state.name } : {}),
      ...(me && this.state.pronouns !== undefined ? (this.state.pronouns ? { pronouns: this.state.pronouns } : { pronouns: undefined }) : {}),
      ...(!me ? { badges: [{ name: 'Early Supporter' }] } : {}),
    };
  }

  /** setProfile beyond the bio: what it takes, the rest left to the demo's own bio handling. */
  profileChange(change: P.ProfileChange): string | null {
    const lim = SELF_LIMITS.discord!;
    if (change.name !== undefined && [...change.name].length > lim.name!) return `global_name: must be ${lim.name} or fewer in length`;
    if (change.banner) return 'Banners need Discord Nitro';
    if (change.emoji !== undefined || change.username !== undefined) return 'Not on Discord';
    if (change.name !== undefined) this.state.name = change.name || undefined;
    if (change.pronouns !== undefined) this.state.pronouns = change.pronouns;
    if (change.avatar !== undefined) this.state.avatar = change.avatar ? change.avatar.name : null;
    this.save();
    this.emitSelf();
    return null;
  }

  /** One of the self commands, answered; null when it is not one. */
  command(cmd: P.AdapterCommand): { result: unknown } | { error: string } | null {
    if (!SELF_COMMANDS.has(cmd.t) || this.network !== 'discord') return null;
    const c = cmd as Extract<P.AdapterCommand, { t: 'block' | 'ignore' | 'setPresence' | 'sessions' }>;
    switch (c.t) {
      case 'block':
        if (c.target.kind !== 'identity') return { error: 'Discord blocks people, not groups' };
        if (c.target.nativeId === this.self.nativeId) return { error: 'That is this account' };
        this.block(c.target.nativeId, !c.unblock);
        return { result: { blocked: !c.unblock } };
      case 'ignore': {
        const set = new Set(this.state.ignored);
        if (c.ignored) set.add(c.identity);
        else set.delete(c.identity);
        this.state.ignored = [...set];
        this.save();
        this.emit({ t: 'ignored', identities: this.state.ignored });
        return { result: { ignored: c.ignored } };
      }
      case 'setPresence': {
        const p: P.OwnPresence = { ...this.state.presence };
        if (c.change.state) {
          if (!OWN_PRESENCE_STATES.includes(c.change.state)) return { error: 'unknown status' };
          p.state = c.change.state;
        }
        if (c.change.status === null) delete p.status;
        else if (c.change.status) p.status = c.change.status;
        this.state.presence = p;
        this.save();
        this.emit({ t: 'selfState', state: { presence: p } });
        return { result: p };
      }
      case 'sessions':
        return {
          result: {
            sessions: [
              { id: 'demo-this', current: true, client: 'Chrome', os: 'Linux', location: 'Somewhere, Earth', lastUsed: Date.now() },
              { id: 'demo-phone', client: 'Discord Android', os: 'Android', location: 'Somewhere, Earth', lastUsed: Date.now() - 3 * 3_600_000 },
            ],
          } satisfies P.SessionsResult,
        };
    }
  }

  /** A verify script's notice (action `notice`): one to show, or none (`clear`). */
  notice(n: P.AccountNotice | null) {
    this.state.notices = n ? [n] : [];
    this.save();
    this.emit({ t: 'notices', notices: this.state.notices });
  }
}
