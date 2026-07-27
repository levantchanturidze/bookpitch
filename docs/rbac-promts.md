# Bookpitch RBAC — Claude Code Prompt Set

Implementation prompts for the role and permission architecture in
`docs/rbac-spec.md`. Existing Next.js codebase, live data to migrate,
full specification in scope.

---

## Why this is split into phases

A complete multi-tenant RBAC rebuild on an existing codebase with a live data
migration is roughly 7–12 working days. Handed to an agent as one instruction,
it exhausts the context window and returns half-finished work that nobody can
review. Each phase below is independently reviewable, independently committable,
and independently revertable.

| Phase | What it does | Rough effort | Touches production data |
|---|---|---|---|
| 0 | Discovery, no code | 2–4 h | No |
| 1 | Schema and seeds | 1 day | Additive only |
| 2 | Data migration | 1–2 days | **Yes — highest risk** |
| 3 | Authorization core | 2–3 days | No |
| 4 | Enforcement across codebase | 2–3 days | **Yes — can break access** |
| 5 | Platform plane | 2 days | No |
| 6 | Organization plane | 2–3 days | No |
| 7 | Adversarial security review | 1 day | No |

---

## How to run this

**1. Put the spec in the repo.**
```bash
mkdir -p docs && cp bookpitch-roles-permissions.md docs/rbac-spec.md
```

**2. Add the `CLAUDE.md` block below to the project root.** It loads
automatically in every session and carries the invariants that must survive
context resets.

**3. Run phases in order, one per session.** Use `/clear` between them.

**4. Use plan mode for Phase 0, 2, and 4** (`Shift+Tab` twice). These are the
three phases where a wrong plan is expensive.

**5. Every phase writes its findings to `docs/`.** This matters more than it
looks: after `/clear`, anything the agent "knows" but did not write down is
gone. The written artifacts are how Phase 3 learns what Phase 0 discovered.

---

## The single biggest risk

Migrating live data while the application keeps serving traffic. The safe
pattern is expand-contract:

```
1. EXPAND      New tables added. Old tables untouched. App runs unchanged.
2. DUAL-WRITE  New writes land in both models. No drift while you work.
3. BACKFILL    Historical rows copied over. Idempotent, resumable.
4. DUAL-READ   Reads move to the new model behind a flag. Instant rollback.
5. VERIFY      1–2 weeks in production with reconciliation logging.
6. CONTRACT    Old columns dropped.
```

Steps 1–4 are covered by Phases 1–3. **Step 6 happens months later, not in the
same sprint.** Do not let the agent talk you into dropping the old columns
early because the new ones "obviously work."

---

## CLAUDE.md

````markdown
# Bookpitch — RBAC Rules

Specification: `docs/rbac-spec.md`. Read it before touching auth, permissions,
organizations, memberships, or any query that reads tenant-scoped data.

## Invariants — these do not bend

1. **Tenant isolation is checked first.** Every query touching tenant data
   filters by `organization_id`. A query without it is a bug regardless of
   what the surrounding code appears to guarantee.
2. **Fail closed.** Unknown permission key, missing membership, null org
   context, suspended organization → deny. Never fall through to allow.
3. **The audit log is append-only.** No UPDATE, no DELETE, no exceptions,
   including for SUPER_ADMIN. Enforced in the database, not in application code.
4. **No privilege escalation.** Nobody grants a role at or above their own rank,
   or modifies a member at or above their own rank.
5. **Every organization keeps at least one active ORG_OWNER.** Removing the
   last one fails.
6. **Admins never set passwords.** Reset links only, rate limited.
7. **Permissions live in the database.** Roles are bundles of permission rows.
   Adding a permission must not require a code change or a redeploy.
8. **SUPER_ADMIN has no permission ceiling**, but reaching client PII or
   clinical records goes through break-glass: reason, re-authentication,
   60-minute expiry, audited reads. See spec §7.2.

## Working rules

- Never weaken, skip, or delete a test to make a build pass. If a test blocks
  you, the test is telling you something — surface it.
- Never bypass a guard "temporarily." If something cannot be built within these
  invariants, stop and say so. That is a useful answer.
- If a change spans more than ~5 files, show the plan before writing.
- Every migration is reversible and has a written rollback.
- Where the spec is ambiguous or contradicts existing code, stop and ask.
  Do not silently pick an interpretation.
- Write findings to `docs/` as you go. Anything not written down is lost at the
  next context reset.
````

---

# Phase 0 — Discovery

**Plan mode. No code.** Everything downstream is built on this picture. If it
is wrong, six phases inherit the error.

```
Read `docs/rbac-spec.md` in full, then investigate this codebase.

DO NOT write or modify application code in this phase. Read-only investigation
and a written report.

## Map the following, with a confidence level on each

**Stack**
- Framework and version. App Router or Pages Router. Where server-side logic
  actually lives: route handlers, server actions, tRPC, a separate API service.
- Database engine and version. ORM or query builder. Migration tooling.
- Is this PostgreSQL? The spec assumes Row Level Security for the second layer
  of tenant isolation. If it is not Postgres, say so prominently — it changes
  the design of Phase 3.
- Hosting and deployment model. Is there a maintenance window available, or does
  this need to migrate with zero downtime? This determines the entire shape of
  Phase 2, so do not leave it unanswered.

**Auth**
- Library or provider. Where sessions are created, validated, refreshed.
- The exact current shape of the session/JWT payload.
- The full path from incoming cookie to "current user" object.
- How many active sessions exist. At cutover their shape changes, and we need
  to know whether we can force re-login or must support both shapes.

**Current authorization**
- Every place a role or permission is checked today, with file paths.
- The current role model: enum, string column, join table, something else.
- Any existing tenant scoping, even partial or informal.

**Data reality** (read-only queries against dev)
- Row counts for users and whatever currently represents businesses or staff.
- Distribution of existing roles.
- Users belonging to more than one business today.
- Duplicate emails, orphaned rows, soft-deleted records, null foreign keys.
  This is what determines how difficult Phase 2 becomes.

**Testing**
- Framework, how to run it, current coverage of auth paths.
- Is there a seeded test database? Does any fixture contain more than one
  tenant? Single-tenant fixtures make isolation tests meaningless, and we will
  need multi-tenant fixtures in Phase 3.

## Then produce

Write all of this to `docs/rbac-discovery.md` and commit it. Later sessions will
have no memory of this conversation and will read that file instead.

The report must contain:

1. Gap analysis: spec §3 and §4 against what exists today.
2. A ranked risk list. Be blunt and specific. "The current code has 40 queries
   with no tenant filter" is far more useful now than in week three.
3. A revised phase plan. If the proposed order — schema, migration, auth core,
   enforcement, platform, org, security — is wrong for this codebase, say so
   and explain why. Do not follow it out of politeness.
4. Every open question you need answered before Phase 1. Do not guess at any
   of them, and do not bury them at the bottom.

## Done when

`docs/rbac-discovery.md` exists, is committed, and a developer who has never
seen this codebase could read it and understand what they are walking into.
```

---

# Phase 1 — Schema and Seeds

```
Implement the data model from `docs/rbac-spec.md` §3. Read `docs/rbac-discovery.md`
first for the codebase conventions established in Phase 0.

Scope: schema and seed data only. No application code changes. No existing rows
migrated. The application must run completely unchanged after this ships.

## Tables

organizations, branches, memberships, membership_branches, roles, permissions,
role_permissions, audit_logs.

Follow the spec's structure, but match this codebase's existing conventions for
naming, ID types, and timestamps. Consistency with the existing schema beats
matching the spec's formatting.

## Requirements

- EXPAND phase only. Nothing existing is altered or dropped.
- `memberships` is the core table — unique on (user_id, organization_id, role_id).
  Set ON DELETE behaviour deliberately per foreign key. Do not blanket-cascade:
  deleting an organization should not silently erase audit history.
- Index for the queries that will actually run every request: by user_id, by
  (organization_id, status), by (user_id, organization_id).
- `audit_logs` is append-only, enforced at the database level. On Postgres:
  a trigger or rule blocking UPDATE and DELETE, plus revoked grants on the
  application role. Show the enforcement and explain what it does and does not
  survive — specifically, what happens on a superuser connection.
- Every migration reversible. Write the down migration and actually run it.

## Seeds

All system roles from §4 with their ranks. Every permission key from §5.
`role_permissions` matching the §6 matrices exactly.

The matrices contain ⚙️ cells — permissions that are configurable per
organization. Seed those at their most restrictive reading and leave a TODO
referencing Phase 6.

Seeds must be idempotent: running them five times leaves the same state as
running them once.

## Deliverable

Migrations, seeds, and `docs/rbac-schema-notes.md` covering decisions made
where the spec was silent, any deliberate deviation and its reason, and what
Phase 2 needs to know.

## Done when

- Migrations run forward and backward cleanly on a copy of production schema.
- Seeds are idempotent, verified by running them repeatedly.
- An UPDATE against audit_logs fails, demonstrated in a test.
- The existing application test suite passes with no modifications.

Commit as one logical change. Do not start Phase 2.
```

---

# Phase 2 — Data Migration

**Plan mode.** This is the phase where mistakes lose data.

```
Backfill existing records into the new model, and keep the two models in sync
while the transition is in progress.

Show me the plan before writing anything.

## Two separate problems

**Problem one — dual-write.** From the moment this ships until Phase 4
completes, new signups and staff changes are still being written through the
old code paths. Without dual-write, the new tables drift out of date the day
after the backfill and the migration has to be redone.

Design this first: every write path that creates or modifies a user, business,
or role must also write the corresponding organization, membership, and branch
rows. Make the dual-write failure mode explicit — if the new-model write fails,
does the old-model write roll back, or does it log and continue? Argue for one
and implement it; do not leave it undefined.

**Problem two — backfill.** Historical rows mapped per spec §12.

## Cases that need an explicit decision before any code is written

- Users with no clear business attached.
- Duplicate emails, if Phase 0 found any.
- Users who must become ORG_OWNER and PROVIDER simultaneously. Spec §2.3 —
  solo practitioners are expected to be a large share of the data, not an edge
  case. If your plan treats this as an exception, the plan is wrong.
- Businesses that would end up with zero owners.
- Soft-deleted, inactive, or never-activated users.

Tell me your handling for each. Do not proceed on assumptions.

## Non-negotiable properties of the backfill

- Idempotent. Five runs equal one run.
- `--dry-run` producing a full change report while writing nothing.
- Batched with progress output, resumable from the last completed batch.
- Transactional per batch, with a documented recovery path if it dies at 60%.
- A separate verification script, runnable at any time, asserting: every active
  user has at least one membership; every organization has at least one active
  ORG_OWNER; no orphaned membership or branch rows; role distribution before
  and after reconciles exactly.
- A reconciliation script comparing old and new models, safe to run repeatedly
  in production during the dual-write window. This is what tells us the models
  have not drifted.

## Deliverable

Dual-write implementation, backfill script, dry-run output from the real dev
database, verification and reconciliation scripts, and
`docs/rbac-migration-runbook.md` written so that someone who is not you can
execute it under pressure at 3am — including the rollback.

## Done when

- Dry-run output reviewed and approved by me.
- Backfill run on a full copy of production data, verification clean.
- Backfill interrupted mid-run and resumed successfully, demonstrated.
- Reconciliation reports zero drift after a simulated period of dual-write.
- Rollback tested, not just documented.

Do not run against production. Do not start Phase 3.
```

---

# Phase 3 — Authorization Core

```
Build the authorization layer from spec §10.

## Components

1. `can(ctx, permission, resource?)` — semantics exactly as §10. Evaluation
   order matters: platform permissions, then tenant isolation, then
   impersonation restrictions, then scope resolution (:org, :branch, :own).
   Fail closed at every branch.

2. AuthContext construction: user → active organization → membership →
   permission set. Cache the resolved permission set keyed by membership,
   invalidated by a version bump. Think about the invalidation storm when an
   organization-wide role changes — do not rebuild every session at once.

3. Session and token changes: active_organization_id, membership_id,
   permissions_version. **Handle the cutover explicitly.** Existing sessions
   have the old payload shape. Either support both shapes for a transition
   window or force re-authentication — decide, state which, and implement it.
   Do not let old sessions fall into an undefined state.

4. A guard usable on every server-side entry point Phase 0 identified. One
   consistent API, not three variants.

5. Database-level isolation. On Postgres: RLS policies on every tenant table,
   with the application connecting as a non-superuser role. Write a test that
   issues a query deliberately missing the org filter and proves RLS blocks it.
   If not Postgres, propose the strongest available alternative and state
   plainly what it does not protect against.

## Two things that are easy to get wrong here

**Role rank is a lattice, not a chain.** FRONT_DESK and PROVIDER share rank 40
but are not comparable — they operate in different domains. A "can manage"
check built only on numeric rank comparison will produce wrong answers. Use an
explicit `can_manage_roles` relation per role, with rank as a secondary guard
against escalation.

**Permissions are data.** No hardcoded role enums anywhere in the authorization
path. If a reviewer can find `role === 'ORG_ADMIN'` in the codebase after this
phase, the phase is not finished.

## Tests — the point of this phase, not an afterthought

Build multi-tenant fixtures first: at least three organizations, one user with
memberships in two of them, one solo practitioner holding OWNER and PROVIDER,
one organization with three branches and a manager scoped to two.
Isolation tests against single-tenant fixtures prove nothing.

- Cross-tenant: a user in org A cannot read, write, or confirm the existence of
  any resource in org B. Test at the API layer and again at the database layer.
- Scope: :own, :branch, :org resolve correctly, including partial branch scope.
- Multi-membership: same user, different roles in two organizations, no bleed
  in either direction, including after switching between them.
- Rank and lattice: no grant or modification at or above own rank; peer roles
  in different domains cannot manage each other.
- Fail-closed: unknown permission key, null membership, expired session,
  suspended organization, deleted organization.

## Deliverable

Implementation, tests, multi-tenant fixtures, and a short guide for other
developers on guarding a new endpoint. Record any performance concerns you hit
in `docs/rbac-schema-notes.md` — particularly RLS overhead and index usage
under policies.

Do not wire this into existing endpoints. That is Phase 4.
```

---

# Phase 4 — Enforcement

**Plan mode.** This is the phase that can lock legitimate users out of
production.

```
Apply the authorization layer across the existing codebase — in four steps,
not one.

## Step 1 — Audit, changing nothing

Produce a table: every server-side entry point, what it checks today, what
permission it should require per spec §6, and whether its queries are
org-scoped today.

Separately, list every query in the codebase reading tenant data without an
organization_id filter. That list is the actual current security posture of
this product. Commit it to `docs/rbac-enforcement-audit.md` and show it to me
before changing a single line.

## Step 2 — Shadow mode

Install the guards in log-only mode. They evaluate the permission check, record
what the decision would have been, and then allow the request through
regardless.

Deploy this and let it run against real traffic. Every would-be denial is
either a real permission gap or a mapping mistake on our side, and shadow mode
is how we tell the difference without locking anyone out.

## Step 3 — Review

Analyse the shadow logs together. Expect surprises: endpoints used by roles
nobody documented, internal tools authenticating as a real user, background
jobs running with no user context at all. Each one needs a decision before
enforcement, and background jobs in particular need a real answer rather than
an exemption.

## Step 4 — Enforce

Flip guards to enforcing, highest-risk endpoints first, in small commits
grouped by module.

Where the correct permission is genuinely ambiguous, stop and ask. Do not
default to the permissive reading to keep things working — a visibly broken
endpoint beats a silently open one.

Where an endpoint has no sensible mapping because it predates the model, flag
it rather than inventing one.

## Also

Add a CI check that fails when a new route handler or server action ships
without a guard. Explain how it works and what it cannot catch.

## Done when

- The audit table is committed and reviewed.
- Shadow mode has run against real traffic long enough to be meaningful, and
  every would-be denial has been classified.
- Guards are enforcing, with a documented rollback per module.
- Anything deliberately left unguarded is listed with its reason.
```

---

# Phase 5 — Platform Plane

```
Implement the platform side: spec §4.1, §6.1, §7.1, §7.2.

## Organization management
CRUD, suspend and reactivate, subscription state, plan changes, owner
invitation. Password reset sends links only — rate limited, single use,
expiring. Never direct password setting, per spec §9 rule 4.

## Impersonation (§7.1)
Per-organization `allow_support_impersonation` flag. Mandatory reason with
ticket ID. 30–60 minute expiry. A banner that is visible and cannot be
dismissed. Blocked actions during the session: delete, bulk export, billing
changes, clinical records. Full audit with `on_behalf_of`. Notification to the
organization owner.

## Break-glass (§7.2)
SUPER_ADMIN only. All seven steps in the spec table. This is the one path that
can override an organization's impersonation block, so every control on it
carries weight. Re-authentication with password and 2FA at the moment of use,
regardless of session age. Reads are audited, not only writes.

## Audit log
Query interface with filters by actor, organization, action, and time range.
Re-verify the Phase 1 append-only enforcement still holds — attempt an UPDATE
in a test and expect failure.

## Constraints
- Platform roles get no implicit tenant access. PLATFORM_ADMIN and
  SUPPORT_AGENT are hard-denied on clinical records with no override path
  anywhere in the code.
- SUPPORT_AGENT is read-only with masked PII. Verify masking happens
  server-side. A client-side hide is not masking; the data is still on the wire.
- Destructive platform actions require password re-entry (§9 rule 9).

## Done when
- An organization with impersonation disabled genuinely blocks PLATFORM_ADMIN,
  proven by test.
- Break-glass works for SUPER_ADMIN and writes an audit row, proven by test.
- An expired break-glass session denies on the next request, proven by test.
- SUPPORT_AGENT cannot retrieve unmasked PII through any endpoint, including
  exports, search results, and error messages.
```

---

# Phase 6 — Organization Plane

```
Implement the tenant-facing side: spec §4.2 and §6.2.

## Staff management
Invite, edit, deactivate, assign roles, manage schedules and shifts. Rank and
lattice guards enforced server-side on every mutation — UI hiding is not
enforcement. Last-owner protection (§9 rule 1). Ownership transfer as an
explicit flow with confirmation from both parties where possible.

## Branch scoping
BRANCH_MANAGER and multi-branch FRONT_DESK. Every list, calendar, report, and
export respects `membership_branches`. Pay particular attention to aggregate
queries — branch scoping is easy to get right on detail views and easy to miss
on totals, and a leaked total is still a leak.

## Organization-level toggles
The ⚙️ cells from the §6.2 matrix. Minimum set:
- providers cannot see financial data
- providers see only their own clinical notes
- front desk cannot see full client history
- discount ceiling for front desk

Stored per organization, evaluated inside `can()`. Not applied at the UI layer.

## Organization switcher
For users with multiple memberships. Switching rebuilds the auth context
completely — no cached permission, no query result, no client-side store from
the previous organization survives the switch. Ship this even if most users
have one organization; retrofitting it later is significantly worse.

## Guardrails (§9)
Rules 5, 6, 8, 10: provider deletion blocked while future bookings exist,
organization deletion soft with a 30-day grace period, CLIENT access resolved
by ownership rather than role, sessions invalidated on role change.

## Done when
- Each guardrail has a test that fails when the guardrail is removed.
- Toggles demonstrably change what a PROVIDER can retrieve from the API, not
  just what the UI renders.
- Organization switching leaves no residue, proven by a test that switches and
  then attempts to read the previous organization's data.
```

---

# Phase 7 — Adversarial Review

```
Try to break what we built. Find everything first, report, then we prioritise
together. Do not fix as you go — a fix mid-review changes the surface you are
still testing.

Run against the multi-tenant fixtures from Phase 3, and against a copy of
migrated production data if one is available. An empty database proves nothing.

## Cross-tenant isolation
Direct object references using another organization's IDs. Manipulated session
payloads. Bulk endpoints, search, exports, aggregates, webhooks, file
downloads, notification content, error messages, and cache keys. Attempt each
at every layer, including a raw database connection using the application's own
credentials.

## Privilege escalation
Self-promotion through profile update. Assigning a role above own rank.
Modifying a peer or superior. Removing the last owner. Editing a membership row
directly. Escalation through the invitation flow, through organization
switching, and through the branch assignment path.

## Impersonation and break-glass
A session outliving its expiry. Performing a blocked action mid-impersonation.
Reaching clinical records as PLATFORM_ADMIN by any route at all. Suppressing
the audit write. Reusing a break-glass token after its reason was withdrawn.

## Audit integrity
UPDATE and DELETE against audit_logs via the ORM, via raw SQL, and via a
migration. If any of these succeeds, that is the highest-priority finding in
the report — an editable audit log has no evidentiary value anywhere.

## Deliverable

`docs/rbac-security-review.md`: each finding with severity, reproduction steps,
affected files, and a suggested fix. Then a regression test for every finding,
so none of them can return quietly.

Be genuinely adversarial. A finding surfaced here costs an afternoon. The same
finding surfaced by one clinic's patient records appearing inside another
clinic's account costs the company.
```

---

## Operating notes

**Plan mode on 0, 2, and 4.** These are the phases where a wrong plan is
expensive: 0 misinforms everything downstream, 2 can lose data, 4 can lock out
real users.

**`/clear` between phases.** Context saturation degrades output quality
noticeably. The spec and `CLAUDE.md` reload automatically; the `docs/` artifacts
carry everything else forward.

**Commit per phase.** When something breaks, you want to be one phase back,
not at the beginning.

**Read two reports yourself, in full.** Phase 0's gap analysis and Phase 4's
list of unguarded queries. The second one is often uncomfortable — it shows
where the code reads tenant data today with no organization filter. That list
is the reason this work is being done.

**Verify rather than trust.** After each phase, run the test suite yourself,
run the migration down and up again, and spot-check that the claimed guards
exist in the files where the agent says they are.

**If the stack turns out not to be Next.js**, these prompts still hold. Phase 0
establishes the real picture and everything after it builds on that rather than
on the assumption.

**The Postgres question is load-bearing.** If the database is not Postgres,
there is no RLS, and tenant isolation rests entirely on application code. Not a
blocker, but one forgotten `where` clause becomes sufficient for a cross-tenant
leak — plan the compensating controls in Phase 3 rather than discovering the
gap in Phase 7.
