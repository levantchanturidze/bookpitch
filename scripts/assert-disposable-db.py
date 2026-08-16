#!/usr/bin/env python3
"""Refuse to proceed unless the restore target is a disposable database.

A restore drill that can reach production is not a drill, it is an outage
waiting for a typo. This guard runs before anything is decrypted, and it is an
ALLOW-list: an unrecognised host is a failure, not a pass. Deny-lists fail open
the moment someone adds a new production hostname.

Usage:

    python3 scripts/assert-disposable-db.py --env-var RESTORE_TARGET_URL

Exits 0 only when every one of these holds:

  * the target host is in the allow-list (localhost by default, extended via
    RESTORE_ALLOWED_HOSTS as a comma-separated list);
  * the host does not look like a managed production provider;
  * the target URL is not byte-identical to any known production URL present in
    the environment;
  * the database name is not one of the known production database names.

Nothing is printed except the sanitised host/port/database, so a CI log never
gains a credential.
"""

from __future__ import annotations

import argparse
import os
import sys
from urllib.parse import unquote, urlsplit

# Hosts that are, by construction, throwaway: the loopback interface of an
# ephemeral CI runner, or a service container on the runner's Docker network.
DEFAULT_ALLOWED_HOSTS = {"localhost", "127.0.0.1", "::1", "postgres"}

# Substrings that mark a managed database endpoint. Present as a second line of
# defence only — the allow-list above already rejects these.
PROVIDER_MARKERS = (
    "supabase",
    "pooler",
    "neon.tech",
    "rds.amazonaws",
    "azure",
    "render.com",
    "railway",
    ".cloud",
)

# Environment variables that hold real production connection strings anywhere in
# this project. If the restore target equals any of them, stop.
PRODUCTION_URL_VARS = (
    "DATABASE_URL",
    "ADMIN_DATABASE_URL",
    "DIRECT_URL",
    "DATABASE_URL_SUPERUSER_MIGRATE",
    "DATABASE_URL_SUPERUSER_SESSION",
    "DATABASE_URL_SUPERUSER_TXPOOL",
    "DATABASE_URL_APP_NOBYPASSRLS",
    "DATABASE_URL_LOGIN",
    "BACKUP_DATABASE_URL",
)


def fail(message: str) -> None:
    print(f"REFUSING TO RESTORE: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--env-var", default="RESTORE_TARGET_URL")
    args = parser.parse_args()

    target = os.environ.get(args.env_var, "").strip()
    if not target:
        fail(f"{args.env_var} is empty or unset")

    parts = urlsplit(target)
    if parts.scheme not in ("postgres", "postgresql"):
        fail("restore target is not a postgres:// URL")

    host = (parts.hostname or "").lower()
    port = parts.port or 5432
    database = unquote(parts.path.lstrip("/")) or "postgres"

    if not host:
        fail("restore target has no host")

    extra = os.environ.get("RESTORE_ALLOWED_HOSTS", "")
    allowed = set(DEFAULT_ALLOWED_HOSTS)
    allowed.update(h.strip().lower() for h in extra.split(",") if h.strip())

    if host not in allowed:
        fail(
            f"host {host!r} is not in the disposable-host allow-list "
            f"({sorted(allowed)}). A restore drill must never target a remote database."
        )

    for marker in PROVIDER_MARKERS:
        if marker in host:
            fail(f"host {host!r} contains managed-provider marker {marker!r}")

    for var in PRODUCTION_URL_VARS:
        value = os.environ.get(var, "").strip()
        if value and value == target:
            fail(f"restore target is byte-identical to {var} — that is production")

    # Even on loopback, refuse to write into something named like production.
    if database.lower() in {"postgres", "prod", "production", "bookpitch"}:
        fail(
            f"database name {database!r} is too close to a real database name; "
            "use a clearly disposable name such as bookpitch_restore_drill"
        )

    print(f"restore target OK — host={host} port={port} database={database} (disposable)")


if __name__ == "__main__":
    main()
