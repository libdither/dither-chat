/**
 * Whether a write the hub handed to an account may have been carried out all the same: the account, or the accounts
 * manager between them, stopped answering rather than refusing. Then sending it again could do it twice (a message
 * delivered twice), so the hub says "it may have" and leaves the next step to the person (docs/sync.md "A send in
 * doubt").
 *
 * What says so:
 * - the hub's own adapters: "adapter timed out on send", "disconnected mid-…" (supervisor.ts);
 * - the accounts manager's client (code `timeout`: "the manager did not answer", "the manager is not reachable" while
 *   a call it may already have sent waits; code `unsure`: the connection dropped while the call was under way, "may or
 *   may not have gone through"; "closed": the client shut down with calls still waiting);
 * - the manager itself: "no answer to send in 120 s" (code `timeout`), and an account's connection lost while it had
 *   the call ("may or may not have happened").
 *
 * Not: a refusal the account or the manager answered with (not connected, not allowed, bad input), which did nothing.
 */
export function unknownOutcome(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'timeout' || code === 'unsure') return true;
  const msg = String((e as Error | null)?.message ?? e);
  return /timed out|disconnected mid|did not answer|may or may not|no answer to \w+ in/i.test(msg) || msg === 'closed';
}
