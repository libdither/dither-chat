/**
 * Loaded before every package's tests (each package's bunfig.toml, `[test] preload`): the shell's DITHER_* settings
 * do not reach the tests (docs/testing.md "The environment").
 *
 * The hub and the adapters read their settings from DITHER_* variables (DITHER_MEDIA_ALLOW_PRIVATE, DITHER_INBOX_RANK,
 * DITHER_JEV_URL…), and a test that starts a hub passes its own environment on. A developer's or an agent's shell
 * that has one set (for a demo hub, a lab, a replay) would then run the tests on other settings than CI's: with
 * DITHER_MEDIA_ALLOW_PRIVATE=1 the media fetcher's address guard tests fail, and a setting can as well hide a failure.
 * So each test file starts with none of them; a test that needs one sets it itself. After T3 Code's
 * packages/shared/src/testing/providerEnv.ts.
 *
 * Kept: paths to tools and checkouts this machine has, which tests look for and skip without (DITHER_CHROMIUM,
 * DITHER_DAVE_DIR, DITHER_ACCOUNTS_REPO, DITHER_JXL_DIR).
 * DITHER_TEST_KEEP_ENV=1 keeps them all, to try a test on a setting on purpose.
 */
const KEEP = new Set(['DITHER_CHROMIUM', 'DITHER_DAVE_DIR', 'DITHER_ACCOUNTS_REPO', 'DITHER_JXL_DIR', 'DITHER_TEST_KEEP_ENV']);

if (process.env.DITHER_TEST_KEEP_ENV !== '1') {
  for (const k of Object.keys(process.env)) if (k.startsWith('DITHER_') && !KEEP.has(k)) delete process.env[k];
}
