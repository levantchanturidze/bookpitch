#!/usr/bin/env node
// -----------------------------------------------------------------------------
// P17-011 — fail the build when a required E2E suite ran nothing.
//
//   npm run e2e:check          # after `npm run e2e`
//
// The defect this exists for: CI ran `playwright test --grep "@a11y|@responsive"`
// and the untagged signup journey was excluded from every run. Playwright
// reported success, the job went green, and a critical journey had silently
// stopped executing. Nothing in the pipeline could tell "this suite passed"
// from "this suite did not run".
//
// A passing exit code from a test runner means "nothing failed", which is also
// what zero tests produces. This script is the difference. It reads the JSON
// report and requires every project below to have executed at least one test,
// and requires none of them to have been entirely skipped.
//
// Adding a project to playwright.config.ts without adding it here is safe (it
// simply is not required); removing one that IS listed here fails loudly, which
// is the point.
// -----------------------------------------------------------------------------
import { readFileSync, existsSync } from 'node:fs';

const REPORT = process.env.PLAYWRIGHT_JSON_REPORT ?? 'playwright-report/results.json';

/** Projects that must have executed at least one test. */
const REQUIRED = [
  'public-chromium',
  'public-firefox',
  'public-webkit',
  'public-mobile-safari',
  'public-mobile-chrome',
  'public-mobile-320',
  'setup',
  'authenticated',
  'authenticated-mobile-320',
];

if (!existsSync(REPORT)) {
  console.error(`FAIL: no Playwright JSON report at ${REPORT}.`);
  console.error('Run `npm run e2e` first — a missing report is not a pass.');
  process.exit(1);
}

const report = JSON.parse(readFileSync(REPORT, 'utf-8'));

/** project name -> { total, ok, skipped } */
const byProject = new Map();

function walk(suite) {
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const name = t.projectName ?? '(none)';
      const acc = byProject.get(name) ?? { total: 0, ok: 0, skipped: 0 };
      acc.total++;
      if (t.status === 'skipped' || t.results?.every((r) => r.status === 'skipped')) acc.skipped++;
      else if (t.status === 'expected') acc.ok++;
      byProject.set(name, acc);
    }
  }
  for (const child of suite.suites ?? []) walk(child);
}
for (const suite of report.suites ?? []) walk(suite);

console.log('E2E suites executed:');
for (const name of [...byProject.keys()].sort()) {
  const s = byProject.get(name);
  console.log(
    `  ${name.padEnd(26)} ${String(s.total).padStart(4)} test(s)` +
      (s.skipped ? `, ${s.skipped} skipped` : ''),
  );
}

const problems = [];
for (const name of REQUIRED) {
  const s = byProject.get(name);
  if (!s || s.total === 0) {
    problems.push(`${name}: ran ZERO tests`);
  } else if (s.skipped === s.total) {
    problems.push(`${name}: all ${s.total} test(s) skipped`);
  }
}

// A spec claimed by no project runs nowhere. That is the exact shape of the
// original defect, so it is an error rather than a warning.
const unclaimed = byProject.get('(none)');
if (unclaimed) problems.push(`${unclaimed.total} test(s) belong to no project`);

if (problems.length > 0) {
  console.error('\nFAIL: a required E2E suite did not execute.');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nA green run with zero tests is not a pass. Check the `projects`');
  console.error('testMatch patterns in playwright.config.ts.');
  process.exit(1);
}

const total = [...byProject.values()].reduce((n, s) => n + s.total, 0);
console.log(`\nOK — all ${REQUIRED.length} required suites executed (${total} tests total).`);
