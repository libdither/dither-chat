/** Every package's tests, one after another, as CI runs them: bun scripts/test-all.ts (or bun run test). */
const packages = ['protocol', 'hub', 'web', 'adapter-discord', 'adapter-matrix', 'adapter-signal', 'adapter-whatsapp', 'desk'];
const failed: string[] = [];
for (const p of packages) {
  console.log(`\n== packages/${p}`);
  const proc = Bun.spawn(['bun', 'test'], { cwd: new URL(`../packages/${p}/`, import.meta.url).pathname, stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) failed.push(p);
}
if (failed.length) {
  console.error(`\nfailed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\nall packages passed');
