/**
 * An event's words for its card and its page (docs/events.md "The event card"): its date block, its time in its own zone
 * and in yours, where, who is going. Pure, so tests read it without a page.
 */
import type * as P from '@dither-chat/protocol';

const fmt = (o: Intl.DateTimeFormatOptions, zone?: string) => {
  try {
    return new Intl.DateTimeFormat(undefined, { ...o, ...(zone ? { timeZone: zone } : {}) });
  } catch {
    return new Intl.DateTimeFormat(undefined, o);
  }
};

/** The date block's month and day, in the event's zone. */
export function dateBlock(e: Pick<P.EventFact, 'start' | 'timeZone'>): { month: string; day: string; weekday: string } {
  const parts = fmt({ month: 'short', day: 'numeric', weekday: 'short' }, e.timeZone).formatToParts(e.start);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { month: get('month').toUpperCase(), day: get('day'), weekday: get('weekday') };
}

/** The zone's short name at that moment ("PST", "GMT+1"). */
function zoneName(at: number, zone?: string): string {
  return (
    fmt({ timeZoneName: 'short', hour: 'numeric' }, zone)
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
  );
}

/**
 * When, in the event's zone ("Sat, Mar 14 · 8:00 PM – 11:00 PM PST"), and in yours when it differs ("11:00 PM your
 * time"), the day said when it is another day there.
 */
export function eventWhen(e: Pick<P.EventFact, 'start' | 'end' | 'timeZone'>, mine: string = Intl.DateTimeFormat().resolvedOptions().timeZone): { there: string; here: string | null } {
  const zone = e.timeZone;
  const day = fmt({ weekday: 'short', month: 'short', day: 'numeric' }, zone).format(e.start);
  const time = fmt({ hour: 'numeric', minute: '2-digit' }, zone);
  const sameDay =
    e.end !== undefined && fmt({ year: 'numeric', month: 'numeric', day: 'numeric' }, zone).format(e.start) === fmt({ year: 'numeric', month: 'numeric', day: 'numeric' }, zone).format(e.end);
  const end =
    e.end === undefined ? '' : sameDay ? ` – ${time.format(e.end)}` : ` – ${fmt({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, zone).format(e.end)}`;
  const there = `${day} · ${time.format(e.start)}${end} ${zoneName(e.start, zone)}`.trim();
  if (!zone || sameOffset(e.start, zone, mine)) return { there, here: null };
  const otherDay = fmt({ month: 'numeric', day: 'numeric' }, zone).format(e.start) !== fmt({ month: 'numeric', day: 'numeric' }, mine).format(e.start);
  const here = `${otherDay ? `${fmt({ weekday: 'short' }, mine).format(e.start)} ` : ''}${fmt({ hour: 'numeric', minute: '2-digit' }, mine).format(e.start)} your time`;
  return { there, here };
}

/** Two zones show the same wall clock at that moment. */
function sameOffset(at: number, a: string, b: string): boolean {
  const f = (z: string) => fmt({ year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }, z).format(at);
  try {
    return f(a) === f(b);
  } catch {
    return true;
  }
}

/** Where, in a line: the place's name and city, Online, or that the site shows the address after an RSVP. */
export function eventWhere(e: Pick<P.EventFact, 'place' | 'online'>): string {
  if (e.place) return [e.place.name, e.place.city && !e.place.name?.includes(e.place.city) ? e.place.city : null].filter(Boolean).join(', ') || e.place.address || 'Somewhere';
  if (e.online) return 'Online';
  return 'Address shown after you RSVP';
}

/** Who is going, in words: "42 going", "Guest list hidden by the host", "12 going · the host shows only the count". */
export function goingLine(e: Pick<P.EventFact, 'going' | 'guests' | 'guestsShown'>, more = 0): string {
  const n = e.going ?? (e.guestsShown === 'all' ? (e.guests?.length ?? 0) + more : undefined);
  if (e.guestsShown === 'hidden') return n ? `${n.toLocaleString()} going · guest list hidden` : 'Guest list hidden by the host';
  if (e.guestsShown === 'count') return n !== undefined ? `${n.toLocaleString()} going` : 'Guest count only';
  return n !== undefined ? `${n.toLocaleString()} going` : `${((e.guests?.length ?? 0) + more).toLocaleString()} shown`;
}

/** Your own RSVP, in words, or null. */
export function rsvpWords(e: Pick<P.EventFact, 'rsvp' | 'hosting'>): string | null {
  if (e.hosting) return 'Hosting';
  switch (e.rsvp) {
    case 'going':
      return "You're going";
    case 'maybe':
      return 'Maybe';
    case 'interested':
      return 'Interested';
    case 'waitlist':
      return 'On the waitlist';
    case 'pending':
      return 'Waiting for the host';
    case 'declined':
      return "Can't go";
    case 'invited':
      return 'Invited';
    default:
      return null;
  }
}

/** The RSVP buttons a site offers, in its words. */
export function rsvpChoices(network: P.Network): { status: P.EventRsvpChoice; label: string }[] {
  return network === 'luma'
    ? [
        { status: 'going', label: 'Going' },
        { status: 'interested', label: 'Interested' },
        { status: 'declined', label: "Can't go" },
      ]
    : [
        { status: 'going', label: 'Going' },
        { status: 'maybe', label: 'Maybe' },
        { status: 'declined', label: "Can't go" },
      ];
}
