/**
 * Asking the hub to look for messages it is missing (docs/catch-up.md "Asking"): one chat from its menu, or every chat
 * of an account from Settings → Catching up. The hub goes back through them at the reading pace, fetching what it
 * does not hold, and lists the ask there with its progress. Small, so the menus carry it from the start.
 */
import { describe } from './indexjobs.ts';
import { api, go, toast } from './state.ts';
import { showSection } from './ui/bits.tsx';

/** Opens Settings at Catching up. */
export function openCatchUp() {
  go({ view: 'settings' });
  setTimeout(() => showSection('set-catchup', 'auto'), 120);
}

/** Whether an account of yours can read this chat's history (the menus offer the check only then). */
export function canCheck(conversationId: string): boolean {
  return !!describe('conversation', conversationId)?.history;
}

async function ask(body: Record<string, unknown>, what: string) {
  try {
    await api('/api/catch-up/report', { body: { ...body, asked: true } });
    toast({ kind: 'info', title: 'Checking for missing messages', body: `${what}, at the reading pace.`, action: openCatchUp, actionLabel: 'Show' });
  } catch (e: any) {
    toast({ kind: 'error', title: 'Could not check for missing messages', body: e?.message ?? String(e) });
  }
}

/** The whole chat, back to its start. */
export function checkChat(conversationId: string) {
  return ask({ conversationId, from: 0, note: 'You asked, from the chat' }, 'Going back through the whole chat');
}

/** Every chat of the account: since `from` (0: all their history). */
export function checkAccount(accountId: string, from: number) {
  return ask({ accountId, from, note: from ? 'You asked: every chat, the last two weeks' : 'You asked: every chat, all its history' }, from ? 'Every chat, the last two weeks' : 'Every chat, all its history');
}
