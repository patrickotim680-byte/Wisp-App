#!/usr/bin/env node
// `node tests/run.js` runs everything; `node tests/run.js lock` runs the files
// whose name contains "lock". No node_modules, same as the app itself.
import { readdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { state } from './harness.js';

const only = process.argv[2] || '';
const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter(f => f.endsWith('.test.js')).sort()
  .filter(f => !only || f.includes(only));

console.log(`\nWisp \u2014 chat lock + group calls\n${'-'.repeat(52)}`);
for (const f of files) {
  state.file = f;
  console.log(`\n${f}`);
  await import(pathToFileURL(path.join(dir, f)).href);
}
console.log(`\n${'-'.repeat(52)}`);
console.log(`${state.pass} passed, ${state.fail} failed, ${files.length} file(s)`);
if (state.fail) {
  console.log('\nFailures:');
  state.failures.forEach(f => console.log(` \u2022 [${f.file}] ${f.label}\n   ${f.message}`));
}
process.exit(state.fail ? 1 : 0);
