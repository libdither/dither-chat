/** A stand-in for xdg-open and gio in tests: records its argv, and answers `mime` like gio does. Opens nothing. */
import { appendFileSync } from 'node:fs';

const [log, ...args] = process.argv.slice(2);
appendFileSync(log, JSON.stringify(args) + '\n');
if (args[0] === 'mime') {
  // Every type but none/* gets the same apps.
  if (!args[1].startsWith('none/'))
    console.log(`Default application for “${args[1]}”: editor.desktop
Registered applications:
	other.desktop
	editor.desktop
	missing.desktop
	kde-viewer.desktop
Recommended applications:
	hidden.desktop`);
  else console.log(`No default applications for “${args[1]}”`);
}
if (process.env.RECORD_FAIL) process.exit(3);
