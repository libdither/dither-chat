/**
 * The demo world's side of sending with more than words (docs/sending.md): silent sends and replies without a ping
 * (demo.ts's send keeps them on the echo), previews taken off your own message, messages saved on the network with
 * reminders, and one message scheduled with the network's own Send later. Answers the way the Discord adapter does
 * (dither-accounts extractors/discord/src/sending.ts), so the hub and pages read the same against either. In memory.
 */
import type * as P from '@dither-chat/protocol';

export const DEMO_SEND_CAPS: P.Capability[] = ['silentSend', 'replyMention', 'suppressEmbeds', 'savedMessages', 'nativeScheduled'];

export interface DemoSendHost {
  emit: (ev: P.AdapterEvent) => void;
  /** A direct conversation of this account, for the scheduled message it starts with. */
  someDirect: () => string | null;
}

const HOUR = 3_600_000;

export class DemoSending {
  private saved = new Map<string, P.SavedFact>();
  private scheduled = new Map<string, P.NativeScheduledFact>();
  /** Every message fact the account said, by native id: what saving and removing previews say again. */
  private facts = new Map<string, P.MessageFact>();

  /** demo.ts hands every event it emits here first. */
  seen(ev: P.AdapterEvent) {
    if (ev.t === 'message') this.facts.set(ev.message.nativeId, ev.message);
  }

  private message(conversation: string, nativeId: string): P.MessageFact | null {
    const m = this.facts.get(nativeId);
    return m && m.conversation === conversation ? m : null;
  }

  constructor(
    private h: DemoSendHost,
    now = Date.now(),
  ) {
    const dm = h.someDirect();
    if (dm) this.scheduled.set('9001', { nativeId: '9001', conversation: dm, body: 'Happy birthday! 🎂', dueAt: now + 20 * HOUR });
  }

  /** The command's answer, or null when it is not one of these. Throws the network's refusal. */
  command(cmd: P.AdapterCommand): { value: unknown } | null {
    switch (cmd.t) {
      case 'suppressEmbeds': {
        const m = this.message(cmd.conversation, cmd.message);
        if (!m) throw new Error('Unknown Message');
        this.h.emit({ t: 'message', live: false, message: { ...m, extra: { ...(m.extra ?? {}), embeds: [] } } });
        return { value: {} };
      }
      case 'save': {
        if (cmd.remove) {
          this.saved.delete(cmd.message);
          this.h.emit({ t: 'unsaved', message: cmd.message, conversation: cmd.conversation });
          return { value: {} };
        }
        const reminders = [...this.saved.values()].filter((s) => s.dueAt !== undefined).length;
        if (cmd.dueAt !== undefined && reminders >= 50) throw new Error('Maximum number of reminders reached (50)');
        const f: P.SavedFact = { conversation: cmd.conversation, message: cmd.message, savedAt: Date.now(), ...(cmd.dueAt !== undefined ? { dueAt: cmd.dueAt } : {}) };
        this.saved.set(cmd.message, f);
        this.h.emit({ t: 'saved', saved: [f] });
        return { value: f };
      }
      case 'savedList': {
        const all = [...this.saved.values()].filter((s) => cmd.before === undefined || s.savedAt < cmd.before).sort((a, b) => b.savedAt - a.savedAt);
        for (const s of all) {
          const m = s.conversation ? this.message(s.conversation, s.message) : null;
          if (m) this.h.emit({ t: 'message', live: false, message: m });
        }
        return { value: { saved: all.slice(0, 25), more: all.length > 25 } satisfies P.SavedListResult };
      }
      case 'nativeScheduled':
        return { value: { enabled: true, scheduled: [...this.scheduled.values()] } satisfies P.NativeScheduledResult };
      case 'cancelScheduled':
        if (!this.scheduled.delete(cmd.nativeId)) throw new Error('Unknown Scheduled Message');
        return { value: {} };
      default:
        return null;
    }
  }
}
