import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';

// -----------------------------------------------------------------------------
// F16-011. Six rules were downgraded to `warn` across components/** because that
// directory held prototype code ported verbatim. Those files are gone, four
// rules reached zero violations and went back to `error`, and two remain `warn`
// for stated reasons.
//
// A severity is a one-word edit. Without this, a rule could drift back to warn
// or off in a future change and nothing would say so — the same class of
// silent-weakening this project has been bitten by before. The two that are
// still `warn` are asserted too, so a cosmetic "make it zero" suppression is
// equally visible.
// -----------------------------------------------------------------------------

const PROBE = 'components/patients/PatientList.tsx';

/** eslint severities: 0 off, 1 warn, 2 error. */
async function severities(file: string): Promise<Record<string, number>> {
  const eslint = new ESLint();
  const config = (await eslint.calculateConfigForFile(file)) as {
    rules: Record<string, unknown>;
  };
  const out: Record<string, number> = {};
  for (const [rule, value] of Object.entries(config.rules ?? {})) {
    const raw = Array.isArray(value) ? value[0] : value;
    out[rule] = raw === 'error' ? 2 : raw === 'warn' ? 1 : raw === 'off' ? 0 : Number(raw);
  }
  return out;
}

describe('F16-011 · promoted rule severities cannot silently regress', () => {
  it.each([
    ['react/no-unescaped-entities'],
    ['@typescript-eslint/no-unused-vars'],
    ['@typescript-eslint/no-explicit-any'],
    ['@next/next/no-img-element'],
  ])('%s is an error in components/**', async (rule) => {
    const sev = await severities(PROBE);
    expect(sev[rule], `${rule} is not configured for ${PROBE}`).toBeDefined();
    expect(sev[rule], `${rule} must stay at error`).toBe(2);
  });

  // The two that are still warn are pinned as well: if one is quietly switched
  // to 'off' to clear its remaining violations, that is a weakening too.
  it.each([['react-hooks/set-state-in-effect'], ['react-hooks/purity']])(
    '%s is still enabled at warn, with its blocker documented',
    async (rule) => {
      const sev = await severities(PROBE);
      expect(sev[rule], `${rule} is not configured for ${PROBE}`).toBeDefined();
      expect(sev[rule], `${rule} must remain enabled (warn), never off`).toBe(1);
    },
  );

  it('the config still explains why the two remain at warn', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('eslint.config.mjs', 'utf8');
    expect(src).toMatch(/set-state-in-effect \(3\)/);
    expect(src).toMatch(/purity \(2\)/);
  });

  it('no project-wide disable was introduced for any of the six', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('eslint.config.mjs', 'utf8');
    for (const rule of [
      'react/no-unescaped-entities',
      '@typescript-eslint/no-unused-vars',
      '@typescript-eslint/no-explicit-any',
      '@next/next/no-img-element',
      'react-hooks/set-state-in-effect',
      'react-hooks/purity',
    ]) {
      expect(src, `${rule} was turned off`).not.toMatch(
        new RegExp(`'${rule.replace(/[/@-]/g, '\\$&')}':\\s*'off'`),
      );
    }
  });
});
