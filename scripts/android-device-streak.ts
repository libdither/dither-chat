/**
 * How many runs of the Android device workflow (.github/workflows/android-device.yml) have passed on main in a row,
 * newest first: once it reaches 20, the job is steady enough to make required (docs/testing.md, "Android on an
 * emulator"). Cancelled runs are left out; anything else that did not pass ends the streak.
 *
 *   bun scripts/android-device-streak.ts [--want 20]
 */
const args = process.argv.slice(2);
const want = Number(args[args.indexOf('--want') + 1]) || 20;
const r = Bun.spawnSync(['gh', 'run', 'list', '--workflow', 'android-device.yml', '--branch', 'main', '--limit', '100', '--json', 'conclusion,status,event,createdAt,url'], { stdout: 'pipe', stderr: 'pipe' });
if (r.exitCode !== 0) {
  console.error(r.stderr.toString().trim());
  process.exit(2);
}
const runs = (JSON.parse(r.stdout.toString()) as { conclusion: string; status: string; event: string; createdAt: string; url: string }[]).filter(
  (x) => x.status === 'completed' && x.conclusion !== 'cancelled' && x.conclusion !== 'skipped',
);
let streak = 0;
for (const x of runs) {
  if (x.conclusion !== 'success') break;
  streak++;
}
const broke = runs[streak];
console.log(`${streak} passed in a row on main (of ${runs.length} finished runs)${broke ? `; before them: ${broke.conclusion} ${broke.createdAt} ${broke.url}` : ''}`);
console.log(streak >= want ? `steady: ${want} or more, ready to make required` : `not yet: ${want - streak} more to go`);
