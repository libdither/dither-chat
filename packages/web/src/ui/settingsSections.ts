import { android } from '../android.ts';

/** Settings' sections: listed beside them on a desktop, and in a sheet from their header on a phone. */
export const SECTIONS: [title: string, icon: string, id: string][] = [
  ['Notifications', 'bell', 'set-notifications'],
  ['Push and quiet hours', 'bellOff', 'push'],
  ['Each device', 'phone', 'set-devices'],
  ['Keywords', 'at', 'set-keywords'],
  ['Your rules', 'layers', 'set-overrides'],
  ['Sending', 'send', 'set-sending'],
  ['Privacy', 'lock', 'set-privacy'],
  ['Message history', 'clock', 'set-history'],
  ['Indexing', 'archive', 'set-indexing'],
  ['Catching up', 'refresh', 'set-catchup'],
  ['Adversarial features', 'eyeOff', 'set-adversarial'],
  ['Usage', 'activity', 'set-usage'],
  ['Appearance', 'eye', 'set-appearance'],
  ['Translation', 'globe', 'set-translate'],
  ['Mail', 'mail', 'set-mail'],
  // The phone app opens links and files in the phone's apps by itself.
  ...(android ? [] : ([['Desktop helper', 'monitor', 'set-desk']] as [string, string, string][])),
  ['Signed-in devices', 'lock', 'set-sessions'],
];
