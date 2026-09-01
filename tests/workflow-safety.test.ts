import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';

// -----------------------------------------------------------------------------
// Phase 13 — structural safety tests for the operational workflows.
//
// These exist because the previous generation of backup workflows was *wiring*:
// backup.yml, restore-drill.yml, residency-audit.yml and pitr-audit.yml all
// referenced repository secrets that had never been created, so every scheduled
// run failed. Nobody noticed for weeks, and the project believed it had backups
// it did not have.
//
// A YAML file that looks right is not a control. These tests assert the
// properties that would have caught that class of failure, plus the properties
// that keep a production backup from being produced by untrusted code or
// restored over production.
// -----------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  'continue-on-error'?: boolean | string;
  if?: string;
};
type Job = {
  'runs-on'?: string;
  steps?: Step[];
  permissions?: Record<string, string> | string;
  if?: string;
  needs?: string | string[];
  services?: Record<string, { image?: string; env?: Record<string, string> }>;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean | string;
  outputs?: Record<string, string>;
};
type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string> | string;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean } | string;
  jobs?: Record<string, Job>;
};

function readWorkflow(file: string): { raw: string; doc: Workflow } {
  const full = path.join(WORKFLOW_DIR, file);
  const raw = readFileSync(full, 'utf8');
  return { raw, doc: load(raw) as Workflow };
}

function allSteps(doc: Workflow): Step[] {
  return Object.values(doc.jobs ?? {}).flatMap((j) => j.steps ?? []);
}

const BACKUP = 'production-backup.yml';
const RESTORE = 'restore-drill.yml';
const MONITOR = 'production-monitor.yml';

describe('workflow YAML is valid', () => {
  it('every workflow file parses as YAML and declares jobs', () => {
    const files = readdirSync(WORKFLOW_DIR).filter(
      (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const { doc } = readWorkflow(file);
      expect(doc, `${file} parsed to a non-object`).toBeTypeOf('object');
      expect(Object.keys(doc.jobs ?? {}).length, `${file} declares no jobs`).toBeGreaterThan(0);
      expect(doc.on, `${file} declares no triggers`).toBeTruthy();
    }
  });

  it('the three Phase 13 workflows exist', () => {
    for (const file of [BACKUP, RESTORE, MONITOR]) {
      expect(existsSync(path.join(WORKFLOW_DIR, file)), `${file} is missing`).toBe(true);
    }
  });

  it('the superseded S3/GPG backup workflows are gone', () => {
    // They referenced secrets that never existed (AWS_*, BACKUP_S3_URI,
    // BACKUP_PASSPHRASE) and failed on every scheduled run. Leaving them in
    // place would mean two backup systems, one of which never worked.
    for (const file of ['backup.yml', 'residency-audit.yml', 'pitr-audit.yml']) {
      expect(existsSync(path.join(WORKFLOW_DIR, file)), `${file} should have been removed`).toBe(
        false,
      );
    }
  });
});

describe('production backup workflow safety', () => {
  const { raw, doc } = readWorkflow(BACKUP);

  it('is not triggerable by a pull request', () => {
    // A fork PR that could trigger this would gain the production database
    // secret. There must be no pull_request or pull_request_target trigger
    // anywhere in the file.
    expect(Object.keys(doc.on ?? {})).toEqual(expect.arrayContaining(['schedule']));
    expect(Object.keys(doc.on ?? {})).not.toContain('pull_request');
    expect(Object.keys(doc.on ?? {})).not.toContain('pull_request_target');
    expect(raw).not.toMatch(/pull_request_target/);
  });

  it('only allows schedule and workflow_dispatch', () => {
    expect(Object.keys(doc.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('refuses to run from any ref other than the default branch', () => {
    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      expect(job.if, `job ${jobName} has no ref guard`).toBeTruthy();
      expect(job.if).toContain("github.ref == 'refs/heads/main'");
    }
  });

  it('declares minimum permissions', () => {
    expect(doc.permissions).toEqual({ contents: 'read' });
    // No job may quietly widen them.
    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      if (!job.permissions) continue;
      expect(Object.keys(job.permissions), `job ${jobName} widened permissions`).toEqual([
        'contents',
      ]);
    }
  });

  it('serialises production backups and never cancels one in flight', () => {
    expect(doc.concurrency).toBeTruthy();
    const c = doc.concurrency as { group: string; 'cancel-in-progress'?: boolean };
    expect(c.group).toBe('production-backup');
    expect(c['cancel-in-progress']).toBe(false);
  });

  it('installs a PostgreSQL client matching the production major version', () => {
    // Production is 17.6; pg_dump refuses to dump from a newer server.
    expect(raw).toContain('postgresql-client-17');
  });

  it('never passes the database URL as a command argument', () => {
    // See the pg_wrapper test below for the other half of the version story.
    // The URL is only ever bound to an env var; scripts/pg-conn-env.py turns it
    // into PG* + .pgpass so it never reaches argv or a log.
    const steps = allSteps(doc);
    for (const step of steps) {
      if (!step.run) continue;
      expect(step.run, `step "${step.name}" interpolates a DB secret into a command`).not.toMatch(
        /\$\{\{\s*secrets\.[A-Z_]*DATABASE_URL[A-Z_]*\s*\}\}/,
      );
    }
    // …and where it is bound, it is bound as `env:`, not inline.
    const backupStep = steps.find((s) => s.env && 'BACKUP_DATABASE_URL' in s.env);
    expect(backupStep, 'no step binds BACKUP_DATABASE_URL via env').toBeTruthy();
  });

  it('encrypts before upload and never uploads a plaintext dump', () => {
    expect(raw).toContain('age-encryption.org');
    const uploads = allSteps(doc).filter((s) => s.uses?.startsWith('actions/upload-artifact'));
    expect(uploads.length).toBeGreaterThan(0);
    for (const up of uploads) {
      // Uploading the work directory would be uploading plaintext. The output
      // directory only ever receives encrypted files (asserted by the
      // "Assert the output directory holds no plaintext" step).
      expect(String(up.with?.path)).toContain('backup-out');
      expect(String(up.with?.['if-no-files-found'])).toBe('error');
    }
  });

  it('retains daily backups for at least 31 days', () => {
    const uploads = allSteps(doc).filter((s) => s.uses?.startsWith('actions/upload-artifact'));
    const daily = uploads.find((u) => !String(u.with?.name).includes('weekly'));
    expect(daily).toBeTruthy();
    expect(Number(daily!.with?.['retention-days'])).toBeGreaterThanOrEqual(31);
  });

  it('keeps a longer-lived weekly copy so 4 weekly recovery points survive', () => {
    const uploads = allSteps(doc).filter((s) => s.uses?.startsWith('actions/upload-artifact'));
    const weekly = uploads.find((u) => String(u.with?.name).includes('weekly'));
    expect(weekly, 'no weekly retention copy').toBeTruthy();
    expect(Number(weekly!.with?.['retention-days'])).toBeGreaterThanOrEqual(28 * 3);
  });

  it('uses collision-resistant artifact names that carry no database identity', () => {
    const uploads = allSteps(doc).filter((s) => s.uses?.startsWith('actions/upload-artifact'));
    for (const up of uploads) {
      const name = String(up.with?.name);
      expect(name).toMatch(/github\.run_id/);
      expect(name).toMatch(/github\.run_attempt/);
      expect(name.toLowerCase()).not.toMatch(/supabase|postgres:|password|@/);
    }
  });

  it('does not decrypt in the job that holds the database credential', () => {
    // Separation of duty: the dump job cannot read its own output.
    const backupJob = doc.jobs?.backup;
    const jobText = JSON.stringify(backupJob);
    expect(jobText).not.toContain('BACKUP_AGE_PRIVATE_KEY');
    // …and the verify job has the key but not the database URL.
    const verifyJob = JSON.stringify(doc.jobs?.verify);
    expect(verifyJob).toContain('BACKUP_AGE_PRIVATE_KEY');
    expect(verifyJob).not.toMatch(/DATABASE_URL/);
  });
});

describe('restore drill workflow safety', () => {
  const { raw, doc } = readWorkflow(RESTORE);

  it('supports manual dispatch and a monthly schedule', () => {
    expect(Object.keys(doc.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
    const schedules = doc.on?.schedule as Array<{ cron: string }>;
    expect(schedules.length).toBeGreaterThan(0);
    // Day-of-month field must be a fixed day, i.e. it runs monthly, not never.
    const fields = schedules[0].cron.trim().split(/\s+/);
    expect(fields).toHaveLength(5);
    expect(fields[2]).not.toBe('*');
  });

  it('never references a production database secret', () => {
    for (const forbidden of [
      'DATABASE_URL_SUPERUSER_MIGRATE',
      'ADMIN_MIGRATE_DATABASE_URL',
      'ADMIN_DATABASE_URL',
      'DIRECT_URL',
      'BACKUP_DATABASE_URL',
    ]) {
      expect(raw, `restore drill must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('targets only a loopback address', () => {
    const steps = allSteps(doc);
    const target = steps
      .flatMap((s) => Object.entries(s.env ?? {}))
      .find(([k]) => k === 'RESTORE_TARGET_URL');
    expect(target, 'no RESTORE_TARGET_URL is set').toBeTruthy();
    const url = new URL(String(target![1]));
    expect(['127.0.0.1', 'localhost', '::1']).toContain(url.hostname);
    expect(url.pathname.replace(/^\//, '')).toBe('bookpitch_restore_drill');
  });

  it('restores into a disposable service container on the production major version', () => {
    const job = doc.jobs?.drill;
    expect(job?.services?.postgres?.image).toBe('postgres:17');
    expect(job?.services?.postgres?.env?.POSTGRES_DB).toBe('bookpitch_restore_drill');
  });

  it('runs the disposable-target guard before anything is decrypted', () => {
    // The guard lives in scripts/restore-drill.sh; assert the workflow calls
    // that script rather than driving pg_restore itself, so the guard cannot
    // be bypassed by editing the YAML alone.
    expect(raw).toContain('./scripts/restore-drill.sh');
    const restoreShell = readFileSync(path.join(ROOT, 'scripts', 'restore-drill.sh'), 'utf8');
    const guardIndex = restoreShell.indexOf('assert-disposable-db.py');
    const decryptIndex = restoreShell.indexOf('age --decrypt');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(decryptIndex).toBeGreaterThan(-1);
    expect(guardIndex, 'the guard must run before decryption').toBeLessThan(decryptIndex);
  });

  it('never performs an automatic destructive restore into anything but the drill DB', () => {
    expect(raw).not.toMatch(/prisma\s+migrate\s+reset/);
    expect(raw).not.toMatch(/prisma\s+db\s+push/);
    expect(raw).not.toMatch(/DROP\s+DATABASE/i);
  });

  it('declares read-only permissions plus the artifact read it needs', () => {
    expect(doc.permissions).toEqual({ contents: 'read', actions: 'read' });
  });
});

describe('production monitor workflow safety', () => {
  const { raw, doc } = readWorkflow(MONITOR);

  it('runs on a schedule and can be dispatched', () => {
    expect(Object.keys(doc.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('does not run more often than every 15 minutes', () => {
    const schedules = doc.on?.schedule as Array<{ cron: string }>;
    for (const { cron } of schedules) {
      const minuteField = cron.trim().split(/\s+/)[0];
      // `*` or a step smaller than 15 would hammer production.
      expect(minuteField).not.toBe('*');
      const stepMatch = /^\*\/(\d+)$/.exec(minuteField);
      if (stepMatch) expect(Number(stepMatch[1])).toBeGreaterThanOrEqual(15);
    }
  });

  it('requests exactly the permissions it uses', () => {
    expect(doc.permissions).toEqual({
      contents: 'read',
      issues: 'write',
      actions: 'read',
      deployments: 'read',
    });
  });

  it('never reads a database URL', () => {
    expect(raw).not.toMatch(/DATABASE_URL/);
    expect(raw).not.toMatch(/postgres(ql)?:\/\//);
  });
});

describe('PostgreSQL 17 binaries are pinned, not left to pg_wrapper', () => {
  // Regression test for backup run 31967250073. Every step that installs the
  // client must also put /usr/lib/postgresql/17/bin on PATH, because Debian's
  // pg_wrapper resolves a connection-less command (`pg_restore --list`) to the
  // runner's *default* cluster version — PostgreSQL 16 on ubuntu-latest — which
  // cannot read the version-1.16 archive pg_dump 17 writes. The backup was
  // good; the verifier was reading it with the wrong binary.
  for (const file of [BACKUP, RESTORE]) {
    it(`${file}: every postgresql-client-17 install pins the version-17 bin directory`, () => {
      const { doc } = readWorkflow(file);
      const installs = allSteps(doc).filter((s) => s.run?.includes('postgresql-client-17'));
      expect(installs.length, `${file} installs no PostgreSQL client`).toBeGreaterThan(0);
      for (const step of installs) {
        expect(step.run, `${file} "${step.name}" does not pin the v17 bin directory`).toContain(
          'echo "/usr/lib/postgresql/17/bin" >> "$GITHUB_PATH"',
        );
      }
    });
  }

  it('the backup verify job checks the pg_restore version it will actually use', () => {
    const { doc } = readWorkflow(BACKUP);
    const verifySteps = doc.jobs?.verify?.steps ?? [];
    const install = verifySteps.find((s) => s.run?.includes('postgresql-client-17'));
    expect(install?.run).toContain('/usr/lib/postgresql/17/bin/pg_restore --version');
  });

  it('never pipes pg_restore into a short-circuiting grep', () => {
    // `pg_restore --list | grep -q` makes grep exit on its first match, which
    // SIGPIPEs pg_restore; with `set -o pipefail` that becomes a failure and
    // the check reports a missing table that is present in the archive.
    // Run 31967906684 failed exactly this way. Write the TOC to a file first.
    for (const file of [BACKUP, RESTORE]) {
      const { doc } = readWorkflow(file);
      for (const step of allSteps(doc)) {
        if (!step.run) continue;
        expect(step.run, `${file} "${step.name}" pipes pg_restore into grep -q`).not.toMatch(
          /pg_restore[^\n|]*\|\s*grep\s+(-\w*q|\S*\s+-\w*q)/,
        );
      }
    }
    // The scripts have always written the list to a file; keep it that way.
    const backupSh = readFileSync(path.join(ROOT, 'scripts', 'backup-production.sh'), 'utf8');
    expect(backupSh).not.toMatch(/pg_restore[^\n|]*\|\s*grep\s+-\w*q/);
  });
});

describe('no required gate is silently suppressed', () => {
  const files = [BACKUP, RESTORE, MONITOR];

  it('no workflow uses continue-on-error', () => {
    for (const file of files) {
      const { doc } = readWorkflow(file);
      for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
        expect(job['continue-on-error'], `${file}:${jobName}`).toBeUndefined();
        for (const step of job.steps ?? []) {
          expect(step['continue-on-error'], `${file}:${jobName}:${step.name}`).toBeUndefined();
        }
      }
    }
  });

  it('no run step ends a required command with `|| true`', () => {
    for (const file of files) {
      const { doc } = readWorkflow(file);
      for (const step of allSteps(doc)) {
        if (!step.run) continue;
        for (const line of step.run.split('\n')) {
          // `|| true` is permitted only where it is explicitly a best-effort
          // cleanup; none of these workflows have such a line, so any hit is a
          // regression worth failing on.
          expect(line, `${file} "${step.name}" suppresses a failure`).not.toMatch(
            /\|\|\s*true\s*$/,
          );
        }
      }
    }
  });

  it('every multi-line run step uses strict shell flags', () => {
    for (const file of files) {
      const { doc } = readWorkflow(file);
      for (const step of allSteps(doc)) {
        if (!step.run || !step.run.includes('\n')) continue;
        expect(step.run, `${file} "${step.name}" is missing set -euo pipefail`).toMatch(
          /set -euo pipefail/,
        );
      }
    }
  });

  it('every job declares a timeout so a hung run cannot burn the budget', () => {
    for (const file of files) {
      const { doc } = readWorkflow(file);
      for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
        expect(job['timeout-minutes'], `${file}:${jobName} has no timeout`).toBeGreaterThan(0);
      }
    }
  });
});

describe('backup scripts keep credentials out of argv and logs', () => {
  const backupSh = readFileSync(path.join(ROOT, 'scripts', 'backup-production.sh'), 'utf8');
  const restoreSh = readFileSync(path.join(ROOT, 'scripts', 'restore-drill.sh'), 'utf8');

  it('never passes a connection URL to pg_dump/pg_restore/psql on the command line', () => {
    for (const [name, src] of [
      ['backup-production.sh', backupSh],
      ['restore-drill.sh', restoreSh],
    ] as const) {
      // `-d "$URL"`, `--dbname="$SOMETHING_URL"` and bare `"$DATABASE_URL"`
      // arguments are all forbidden; the scripts use PG* env vars instead.
      expect(src, `${name} passes a URL to a client tool`).not.toMatch(
        /(-d|--dbname=)["'$]*\$\{?[A-Z_]*URL/,
      );
    }
  });

  it('redacts anything URL-shaped before printing a tool log', () => {
    expect(backupSh).toMatch(/sed -E 's#postgres\(ql\)\?:\/\//);
    expect(restoreSh).toMatch(/sed -E 's#postgres\(ql\)\?:\/\//);
  });

  it('removes plaintext on every exit path, not just success', () => {
    for (const src of [backupSh, restoreSh]) {
      expect(src).toMatch(/trap cleanup EXIT INT TERM/);
      expect(src).toMatch(/rm -rf "\$WORK_DIR"/);
    }
  });

  it('refuses to publish an unencrypted file', () => {
    expect(backupSh).toContain('age-encryption.org');
    expect(backupSh).toMatch(/FATAL: output is not an age file/);
  });

  it('validates the archive with pg_restore --list before encrypting', () => {
    const listIndex = backupSh.indexOf('--list');
    const encryptIndex = backupSh.indexOf('age --encrypt');
    expect(listIndex).toBeGreaterThan(-1);
    expect(encryptIndex).toBeGreaterThan(-1);
    expect(listIndex).toBeLessThan(encryptIndex);
  });

  it('excludes role passwords from the globals dump', () => {
    expect(backupSh).toContain('--no-role-passwords');
    // …and refuses to ship the file if one appears anyway.
    expect(backupSh).toMatch(/FATAL: globals dump contains a role password/);
  });
});

describe('the committed age recipient is a public key only', () => {
  const recipientFile = path.join(ROOT, 'ops', 'backup-age-recipient.txt');

  it('exists and contains exactly one age public recipient', () => {
    const content = readFileSync(recipientFile, 'utf8');
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^age1[0-9a-z]{58}$/);
  });

  it('contains no private key material', () => {
    const content = readFileSync(recipientFile, 'utf8');
    expect(content).not.toContain('AGE-SECRET-KEY');
  });

  it('no private key is committed anywhere in the repository tree', () => {
    // A grep over the working tree, not over git history — gitleaks covers
    // history in CI. This catches the "just for a second" mistake.
    const suspicious: string[] = [];
    const skip = new Set(['node_modules', '.git', '.next', 'dist', 'coverage']);
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|mjs|cjs|sh|py|yml|yaml|md|txt|json|sql)$/.test(entry.name)) continue;
        // This test file legitimately names the prefix; skip itself.
        if (full.endsWith('workflow-safety.test.ts')) continue;
        const content = readFileSync(full, 'utf8');
        if (content.includes('AGE-SECRET-' + 'KEY-')) suspicious.push(full);
      }
    };
    walk(ROOT);
    expect(suspicious).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// The post-migration production invariant check.
//
// Production was restored from a 2026-08-22 backup on 2026-09-01. A restore is
// the event that quietly loses the things `prisma migrate status` cannot see:
// roles are cluster globals and do not travel inside a database dump, RLS can
// come back ENABLED but not FORCED, and a permission row a migration deleted
// reappears from any dump taken before it.
//
// scripts/verify-production-invariants.sql is the check. These tests defend the
// two properties that make it safe to point at production at all.
// -----------------------------------------------------------------------------
describe('production invariant check is read-only and actually wired up', () => {
  const sqlPath = path.join(ROOT, 'scripts', 'verify-production-invariants.sql');
  const sql = readFileSync(sqlPath, 'utf8');

  /**
   * The script with `--` comments and single-quoted string literals removed, so
   * neither prose nor an error message can satisfy — or trip — the scan below.
   *
   * Both strips are load-bearing. The comments explain what each check defends
   * against and name the operations freely; the RAISE EXCEPTION messages say
   * things like "bookpitch_app has UPDATE on audit_log", which is the whole
   * point of the message and would otherwise read as a write statement.
   */
  const code = sql
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  const executable = code.replace(/'(?:[^']|'')*'/g, "''");

  it('contains no statement that could write', () => {
    // The DELETE/UPDATE/INSERT words appear all over the comments explaining
    // what the checks are for; only the executable half is scanned.
    const writes = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'DROP', 'CREATE', 'GRANT', 'REVOKE'];
    const found = writes.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(executable));
    expect(
      found,
      'this script runs against production; a write here is not recoverable by re-running it',
    ).toEqual([]);
  });

  it('COMPLEMENT: the scan sees the executable half at all', () => {
    // Without this, a strip that removed everything would make the test above
    // pass on an empty string.
    expect(executable).toMatch(/RAISE EXCEPTION/);
    expect(executable).toMatch(/pg_roles/);
    expect(executable.length).toBeGreaterThan(1000);
  });

  it('COMPLEMENT: the write scan still fires on a real write statement', () => {
    // The strips above are broad enough to hide a genuine write if they were
    // wrong. Run the same scan over a line that unambiguously writes.
    const withWrite = `${executable}\nDELETE FROM roles WHERE key = 'X';`
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n')
      .replace(/'(?:[^']|'')*'/g, "''");
    expect(/\bDELETE\b/i.test(withWrite)).toBe(true);
  });

  it('pins the session read-only', () => {
    expect(executable).toMatch(/SET\s+default_transaction_read_only\s*=\s*on/i);
  });

  it('migrate.yml runs it with -f, which is what makes the pin apply', () => {
    // `psql -c "SET …; DELETE …"` puts both in one implicit transaction, so the
    // pin does not cover the statement it was meant to stop. Measured: -f gives
    // "cannot execute DELETE in a read-only transaction", -c gives "DELETE 0".
    const migrate = readFileSync(path.join(WORKFLOW_DIR, 'migrate.yml'), 'utf8');
    expect(migrate).toMatch(/psql[^\n]*-f scripts\/verify-production-invariants\.sql/);
    expect(migrate).not.toMatch(/psql[^\n]*-c[^\n]*verify-production-invariants/);
  });

  it('runs after the apply, not before it', () => {
    const migrate = readFileSync(path.join(WORKFLOW_DIR, 'migrate.yml'), 'utf8');
    const apply = migrate.indexOf('prisma migrate deploy');
    const verify = migrate.indexOf('verify-production-invariants.sql');
    expect(apply).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(apply);
  });

  it('checks the invariants that a restore can silently break', () => {
    // `code` keeps string literals: the table and permission names this asserts
    // on are arguments to has_table_privilege() and a WHERE clause, so they are
    // quoted, and the write-scan view above deliberately removes them.
    for (const marker of [
      'rolbypassrls',
      'rolsuper',
      'relforcerowsecurity',
      'audit_log',
      'client.read:contact',
    ]) {
      expect(code, `${marker} is not checked`).toContain(marker);
    }
  });
});

// -----------------------------------------------------------------------------
// A manual cron dispatch must be able to run ONE job.
//
// Every job's dispatch clause used to be a bare `github.event_name ==
// 'workflow_dispatch'`, so "drain the outbox by hand" also fired reminders at
// every tenant. runReminderTick selects [now, now + leadHours], so that really
// can send mail to a real customer — which makes the one operation you most
// want during an incident the one you cannot safely perform.
// -----------------------------------------------------------------------------
describe('scheduled crons can be dispatched one job at a time', () => {
  const { raw, doc: cron } = readWorkflow('cron.yml');
  const JOBS = ['reminders', 'housekeeping', 'retention', 'audit-digest', 'db-partitions'];

  it('offers exactly the five jobs, plus blank for the previous behaviour', () => {
    const options = (
      cron as unknown as {
        on?: { workflow_dispatch?: { inputs?: Record<string, { options?: string[] }> } };
      }
    ).on?.workflow_dispatch?.inputs?.only?.options;
    expect(options, 'the dispatch has no job selector').toBeDefined();
    expect(options).toEqual(['', ...JOBS]);
  });

  it('every job gates its dispatch clause on inputs.only', () => {
    for (const job of JOBS) {
      const condition = String(
        (cron.jobs as unknown as Record<string, { if?: string }>)[job]?.if ?? '',
      );
      expect(condition, `${job} has no condition`).not.toBe('');
      expect(
        condition,
        `${job} still runs on any dispatch, so a single-job dispatch fires it too`,
      ).toContain(`inputs.only == '${job}'`);
      expect(condition).toContain("inputs.only == ''");
    }
  });

  it('COMPLEMENT: a bare workflow_dispatch clause would fail the check above', () => {
    // Proves the assertion is about the gating and not merely about the string
    // 'workflow_dispatch' appearing somewhere.
    const bare = "github.event.schedule == '3 * * * *' || github.event_name == 'workflow_dispatch'";
    expect(bare).not.toContain("inputs.only == 'housekeeping'");
  });

  it('leaves every schedule clause exactly as it was', () => {
    // The selector must not change what runs on a timer. Each job keeps its own
    // cron expression, and audit-digest keeps both of its.
    const expected: Record<string, string[]> = {
      reminders: ['*/15 * * * *'],
      housekeeping: ['3 * * * *'],
      retention: ['17 2 * * *'],
      'audit-digest': ['0 8 * * 1', '3 * * * *'],
      'db-partitions': ['30 1 1 * *'],
    };
    for (const [job, schedules] of Object.entries(expected)) {
      const condition = String(
        (cron.jobs as unknown as Record<string, { if?: string }>)[job]?.if ?? '',
      );
      for (const schedule of schedules) {
        expect(condition, `${job} lost its ${schedule} schedule`).toContain(
          `github.event.schedule == '${schedule}'`,
        );
      }
    }
    // And the trigger list itself is untouched.
    for (const schedule of ['*/15 * * * *', '3 * * * *', '17 2 * * *', '0 8 * * 1', '30 1 1 * *']) {
      expect(raw).toContain(`- cron: '${schedule}'`);
    }
  });
});
