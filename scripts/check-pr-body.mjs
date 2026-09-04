#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Refuse a pull request whose title or body would close an issue as a side
// effect of merging.
//
// This has now happened twice, to the same incident, and the second time was
// while documenting the first:
//
//   PR #66  "…the verifier closes #44 by evidence."
//   PR #72  "…a stray `closes #44` in a PR body had stranded…"
//
// The second is the instructive one: the keyword was inside a CODE SPAN, and
// GitHub closed the issue anyway. Backticks do not protect against the closing
// parser, so "quote it carefully" is not a workable rule — the only workable
// rule is not to write the keyword adjacent to an issue reference at all.
//
// The production monitor reopens an incident closed while its check is still
// failing, so the system self-heals. That is a safety net, not a licence: an
// incident that flaps closed and open loses its assignees, drops out of
// notification lists, and reads as resolved to anyone glancing at the issue
// list in between.
//
// Deliberately narrow. It matches a closing keyword immediately before an issue
// reference, which is exactly what GitHub acts on — nothing else. Referring to
// "#44" is fine, and so is the word "closed" in a sentence.
// -----------------------------------------------------------------------------

/** GitHub's documented closing keywords. */
const KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
];

/**
 * Every closing reference in a piece of text.
 *
 * GitHub allows an optional colon and whitespace between the keyword and the
 * reference, and the reference may be `#123` or `owner/repo#123`. Case
 * insensitive. Code spans and fences are NOT excluded, because GitHub does not
 * exclude them either — which is the whole reason this exists.
 *
 * @param {string} text
 * @returns {Array<{keyword: string, ref: string, context: string}>}
 */
export function findClosingReferences(text) {
  const pattern = new RegExp(
    `\\b(${KEYWORDS.join('|')})\\b\\s*:?\\s+((?:[\\w.-]+/[\\w.-]+)?#\\d+)`,
    'gi',
  );
  const found = [];
  for (const m of String(text ?? '').matchAll(pattern)) {
    found.push({
      keyword: m[1],
      ref: m[2],
      context: String(text)
        .slice(Math.max(0, m.index - 40), m.index + m[0].length + 40)
        .replace(/\s+/g, ' '),
    });
  }
  return found;
}

async function main() {
  const title = process.env.PR_TITLE ?? '';
  const body = process.env.PR_BODY ?? '';
  const found = [...findClosingReferences(title), ...findClosingReferences(body)];

  if (found.length === 0) {
    console.log('No issue-closing keywords in this pull request. ');
    return;
  }

  console.error('This pull request would CLOSE an issue when it merges.\n');
  for (const f of found) {
    console.error(`  "${f.keyword} ${f.ref}"  …${f.context}…`);
  }
  console.error(
    '\nRewrite so no closing keyword sits immediately before an issue reference.\n' +
      'Backticks do not help — GitHub closed an incident twice through this, the\n' +
      'second time from inside a code span, while documenting the first.\n\n' +
      'Say "see #44", "incident #44", or "reopened #44" instead.',
  );
  process.exit(1);
}

// Only run when invoked directly, so the predicate can be imported by tests.
if (process.argv[1] && process.argv[1].endsWith('check-pr-body.mjs')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'unknown');
    process.exit(1);
  });
}
