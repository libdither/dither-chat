/**
 * One line in the hub's log for every attempt to make a group or add people to one, whatever came of it
 * (docs/group-settings.md "In the hub's log"), in a fixed shape a grep can match. The routes run the whole attempt
 * inside `attempt`, so no early return or throw inside can leave it out. A person's name, handle or id never goes in
 * the line; the sentence may carry what the network said.
 */
import { AboutError } from './about.ts';

/** What is known of an attempt so far; groups.ts and about.ts fill it in as they learn it. */
export interface Attempt {
  kind: 'create' | 'add';
  /** The group people are added to (adding only). */
  conversation?: string;
  /** Set once the account is known to be one of yours. */
  accountId?: string;
  network?: string;
  /** How many identities were asked for. */
  people: number;
  /** For the account's log: what was being made ("group DM"), or the group's name ("a group" when it has none). */
  what?: string;
}

interface Outcome {
  added: unknown[];
  invited: unknown[];
  failed: unknown[];
}

const ERROR_MAX = 300;
const sentence = (e: unknown) => String((e as Error)?.message ?? e).slice(0, ERROR_MAX);
const statusOf = (e: unknown) => (e instanceof AboutError ? e.status : 500);

/** How many identities a request body asked for (0 when it was not a list). */
export const asked = (identities: unknown) => (Array.isArray(identities) ? identities.length : 0);

/**
 * Run one attempt and log it: `groups: created …` / `members: added …`, or `groups: create failed …` /
 * `members: add failed …` with the status the page gets (500 for anything that is not an AboutError, thrown on as
 * before). A failure where the account is known also goes in that account's log.
 */
export async function attempt<T extends Outcome>(a: Attempt, run: (a: Attempt) => Promise<T>, note?: (accountId: string, line: string) => void): Promise<T> {
  const where = a.kind === 'add' ? `conversation=${a.conversation ?? '-'} ` : '';
  const head = a.kind === 'create' ? 'groups:' : 'members:';
  try {
    const v = await run(a);
    console.warn(`${head} ${a.kind === 'create' ? 'created' : 'added'} ${where}account=${a.accountId ?? '-'} network=${a.network ?? '-'} added=${v.added.length} invited=${v.invited.length} failed=${v.failed.length}`);
    return v;
  } catch (e) {
    const status = statusOf(e);
    const said = sentence(e);
    console.warn(`${head} ${a.kind === 'create' ? 'create' : 'add'} failed ${where}account=${a.accountId ?? '-'} network=${a.network ?? '-'} people=${a.people} status=${status} error=${JSON.stringify(said)}`);
    if (a.accountId) {
      try {
        note?.(a.accountId, a.kind === 'create' ? `[add] could not make ${a.what ?? 'a group'}: ${said}` : `[add] could not add people to ${a.what ?? 'a group'}: ${said}`);
      } catch {
        // The account's log is a courtesy; the page still gets the first error.
      }
    }
    throw e;
  }
}

/** Run a candidates lookup; when it fails, one line (`groups: candidates failed …` / `members: candidates failed …`). */
export async function candidatesAttempt<T>(conversation: string | null, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const head = conversation === null ? 'groups: candidates failed' : `members: candidates failed conversation=${conversation}`;
    console.warn(`${head} status=${statusOf(e)} error=${JSON.stringify(sentence(e))}`);
    throw e;
  }
}
