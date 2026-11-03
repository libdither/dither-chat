/** Which accounts can start a direct conversation. No browser needed, so it can be tested alone. */
import type * as P from '@dither-chat/protocol';

/** Accounts on this network that can open a DM right now. Empty means no button, not a dead one. */
export function openers(accounts: Iterable<P.AccountView>, network: P.Network): P.AccountView[] {
  return [...accounts].filter((a) => a.network === network && a.status === 'online' && a.capabilities.includes('openDirect'));
}

/** What opening does on this network, said before it happens. */
export function directNote(network: P.Network, name: string): string {
  if (network === 'signal') return `Signal has no step for starting a conversation. This opens one here, and ${name} sees nothing until you send your first message.`;
  if (network === 'whatsapp') return `WhatsApp has no step for starting a chat either. This checks that the number is on WhatsApp and opens the chat here; ${name} sees nothing until you send your first message.`;
  if (network === 'matrix') return `This creates a room and invites ${name} now, or reuses a DM you already have. New rooms are not end-to-end encrypted, because dither-chat cannot encrypt on Matrix yet.`;
  return `This opens a DM with ${name} through the Discord client, or finds the one you have. Nothing is sent until you write something.`;
}
