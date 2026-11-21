// The program the harness runs: `node main.ts` (node 22).
//
// It reads every case from /input/cases.json (a JSON array of
// {id, input}), answers each one alone with run() from solve.js, and
// writes /output/answers.json: a JSON array of the answers, one per
// case and in the cases' order. Outside a container MAKEFUN_INPUT_DIR
// and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// V8's incremental marking is switched off before solve.js is
// imported, so all of its work runs under it (the rules allow an
// entry to tune V8's flags the same way the house baseline does).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL, typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));

// One answer per case, in the cases' order: refuse to write a short
// file rather than hand the scorer a truncated set.
if (answers.length !== cases.length) {
  throw new Error(`answered ${answers.length} of ${cases.length} cases`);
}
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
