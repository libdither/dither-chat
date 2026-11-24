/**
 * Not a test: `bun packages/protocol/test/writing-fuzz.ts [drafts per place]`. Random drafts for each place, with and
 * without marker characters typed among the words: what the model says, and what goes unsaid by its own check and by
 * the second reading of the wire (writing-oracle.ts). The numbers in docs/research/writing-model.md are from 3,000.
 */
import { conforms, differs, hiddenLost, wordsLost } from '../src/writing/check.ts';
import { send } from '../src/writing/encode.ts';
import { fit } from '../src/writing/fit.ts';
import { PLACES, PROFILES } from '../src/writing/profile.ts';
import { drafts } from './writing-drafts.ts';
import { reading, tokens } from './writing-oracle.ts';

const N = Number(process.argv[2] ?? 3000);
for (const typed of [false, true]) {
  const rows: string[] = [];
  let unsaid = 0, oracle = 0, threw = 0, unstable = 0, checked = 0;
  for (const id of PLACES) {
    const next = drafts(typed ? 4242 : 99, typed);
    let reread = 0, lost = 0;
    for (let i = 0; i < N; i++) {
      const d = next();
      let s: any;
      try { s = send(d, PROFILES[id], { title: 't', place: 'p' }); } catch { threw++; continue; }
      const said = new Set(s.changes.map((c: any) => c.key));
      if (said.has('reread')) reread++;
      if (said.has('lost')) lost++;
      const again = fit(s.fitted, PROFILES[id]);
      if (conforms(s.fitted, PROFILES[id]).length || differs(again.doc, s.fitted) !== null || again.changes.length) unstable++;
      if (!said.has('lost') && (wordsLost(d, s.fitted).length || wordsLost(s.fitted, s.reads, true).length)) unsaid++;
      if (!said.has('hidden') && hiddenLost(d, s.reads).length) unsaid++;
      const there = reading(id, s.wire);
      if (!there) continue;
      checked++;
      const w = tokens(d);
      if (!said.has('lost') && w.all.some((x: string) => !there.all.includes(x))) oracle++;
      if (!said.has('hidden') && w.hidden.some((x: string) => there.seen.includes(x))) oracle++;
    }
    if (reread || lost) rows.push(`${PROFILES[id].name} ${reread}${lost ? ` (+${lost} blocked as lost)` : ''}`);
  }
  console.log(typed ? 'typed markers:' : 'no typed markers:', rows.join(', ') || 'none', `| unsaid by own check ${unsaid} | unsaid by the independent reading ${oracle} of ${checked} | threw ${threw} | not stable ${unstable}`);
}
