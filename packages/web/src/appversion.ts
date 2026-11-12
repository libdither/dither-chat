/** What the Android app can do, by the version it reports (android.ts `info`). */

/**
 * The Android app from 0.7 closes a notification on a `{ clear }` push and shows nothing (push.ts). It says so when
 * it registers, but a registration from before then never registers again while its endpoint stands, so its page
 * says it too. A browser must show something for every push, so it never says so.
 */
export function takesClear(version: string | null | undefined): boolean {
  const [major, minor] = (version ?? '').split('.').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 0 || minor >= 7;
}
