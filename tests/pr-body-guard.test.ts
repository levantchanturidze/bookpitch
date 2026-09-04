import { describe, it, expect } from 'vitest';
import { findClosingReferences } from '../scripts/check-pr-body.mjs';

// -----------------------------------------------------------------------------
// A pull request must not close an issue as a side effect of merging.
//
// This has happened twice to the same incident, and the second time was while
// documenting the first:
//
//   PR #66  "…the verifier closes #44 by evidence."
//   PR #72  "…a stray `closes #44` in a PR body had stranded…"
//
// The second is the one that matters. The keyword was inside a CODE SPAN and
// GitHub closed the issue anyway — so "quote it carefully" is not a workable
// rule, and the guard must not try to be clever about markdown either.
//
// Both times the incident was closed while its check was still failing, with
// both Sentry DSNs unset. The monitor's reopen logic recovered it both times,
// which is the safety net working — but an incident that flaps loses its
// assignees, drops out of notification lists, and reads as resolved to anyone
// glancing at the issue list in between.
// -----------------------------------------------------------------------------

describe('a PR body that would close an issue is refused', () => {
  it('THE ACTUAL SENTENCE from PR #66', () => {
    const found = findClosingReferences('the verifier closes #44 by evidence.');
    expect(found).toHaveLength(1);
    expect(found[0].ref).toBe('#44');
  });

  it('THE ACTUAL SENTENCE from PR #72 — inside a code span', () => {
    // Backticks do not protect against GitHub's closing parser, so the guard
    // does not pretend they do.
    const found = findClosingReferences('a stray `closes #44` in a PR body had stranded');
    expect(found, 'a code span is not an escape hatch').toHaveLength(1);
  });

  it('catches every documented keyword and inflection', () => {
    for (const kw of [
      'close',
      'closes',
      'closed',
      'fix',
      'fixes',
      'fixed',
      'resolve',
      'resolves',
      'resolved',
    ]) {
      expect(findClosingReferences(`this ${kw} #7 somehow`), kw).toHaveLength(1);
    }
  });

  it('catches the colon form and cross-repo references', () => {
    expect(findClosingReferences('Fixes: #12')).toHaveLength(1);
    expect(findClosingReferences('closes owner/repo#12')).toHaveLength(1);
  });

  it('is case insensitive', () => {
    expect(findClosingReferences('CLOSES #12')).toHaveLength(1);
    expect(findClosingReferences('Resolved #12')).toHaveLength(1);
  });

  it('reports every occurrence, not just the first', () => {
    expect(findClosingReferences('closes #1 and fixes #2')).toHaveLength(2);
  });

  it('COMPLEMENT: an ordinary reference to an issue is fine', () => {
    // This must stay usable. Most of what this repository writes about
    // incidents refers to them by number, and a guard that blocks that would
    // be turned off within a day.
    for (const text of [
      'see #44',
      'incident #44 is still open',
      'reopened #44 by evidence',
      'the check that raised #44',
      '#44 and #67 share a marker',
      'closed as a duplicate of #44',
      'this closed the incident, see #44 for history',
    ]) {
      expect(findClosingReferences(text), text).toEqual([]);
    }
  });

  it('COMPLEMENT: the word "closed" alone does not trip it', () => {
    expect(findClosingReferences('the incident was closed while its check was failing')).toEqual(
      [],
    );
  });

  it('empty or absent text is not a finding', () => {
    expect(findClosingReferences('')).toEqual([]);
    expect(findClosingReferences(undefined as unknown as string)).toEqual([]);
  });

  it('the message names what to write instead', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('scripts/check-pr-body.mjs', 'utf8');
    expect(src).toMatch(/see #44|incident #44/);
    expect(src, 'and it must exit non-zero').toMatch(/process\.exit\(1\)/);
  });
});
