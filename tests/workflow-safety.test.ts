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
