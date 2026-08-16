#!/usr/bin/env python3
"""Turn a Postgres connection URL into libpq environment variables.

Why this exists: passing a connection URL as `pg_dump -d "$URL"` puts the
password into the process argument list, where it is readable by `ps` and by
anything that dumps argv into a log. CLAUDE.md § "Secret handling" makes that a
hard rule violation. So the URL is parsed here, the password is written to a
0600 .pgpass file, and only non-secret components are printed for the caller to
eval.

Usage:

    export BACKUP_DATABASE_URL='postgresql://...'   # never on the command line
    eval "$(python3 scripts/pg-conn-env.py /secure/tmp/pgpass)"
    pg_dump --format=custom ...                     # reads PG* + PGPASSFILE

Reads the URL from the environment variable named by --env-var (default
BACKUP_DATABASE_URL). Writes the .pgpass file to argv[1]. Prints shell export
lines containing host, port, user, database, sslmode and the pgpass path — none
of which is a credential.

The password is never printed, never placed in argv, and never returned.
"""

from __future__ import annotations

import argparse
import os
import shlex
import sys
from urllib.parse import parse_qs, unquote, urlsplit


def fail(message: str) -> "None":
    # Deliberately terse: this string can end up in a CI log.
    print(f"pg-conn-env: {message}", file=sys.stderr)
    raise SystemExit(2)


def main() -> None:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("pgpass_path", help="where to write the 0600 .pgpass file")
    parser.add_argument("--env-var", default="BACKUP_DATABASE_URL")
    args = parser.parse_args()

    raw = os.environ.get(args.env_var, "").strip()
    if not raw:
        fail(f"environment variable {args.env_var} is empty or unset")

    parts = urlsplit(raw)
    if parts.scheme not in ("postgres", "postgresql"):
        # Do not echo the value — the scheme alone is enough to diagnose.
        fail("connection URL scheme must be postgres:// or postgresql://")

    host = parts.hostname or ""
    if not host:
        fail("connection URL has no host")
    port = str(parts.port or 5432)
    user = unquote(parts.username or "")
    if not user:
        fail("connection URL has no user")
    password = unquote(parts.password or "")
    database = unquote(parts.path.lstrip("/")) or "postgres"

    query = parse_qs(parts.query)
    # Supabase and Prisma URLs carry sslmode/pgbouncer/connection_limit style
    # params. Only sslmode is meaningful to pg_dump; default to `require`
    # because production must never be dumped over a plaintext socket.
    is_loopback = host.lower() in ("localhost", "127.0.0.1", "::1")
    sslmode = (query.get("sslmode") or ["disable" if is_loopback else "require"])[0]
    if sslmode == "disable" and not is_loopback:
        fail("refusing to run with sslmode=disable against a remote database")

    pgpass_path = os.path.abspath(args.pgpass_path)
    # 0600 before any content is written, not after.
    fd = os.open(pgpass_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        # .pgpass escaping: backslash and colon must be escaped in every field.
        def esc(value: str) -> str:
            return value.replace("\\", "\\\\").replace(":", "\\:")

        handle.write(f"{esc(host)}:{port}:{esc(database)}:{esc(user)}:{esc(password)}\n")

    exports = {
        "PGHOST": host,
        "PGPORT": port,
        "PGUSER": user,
        "PGDATABASE": database,
        "PGSSLMODE": sslmode,
        "PGPASSFILE": pgpass_path,
        # Guarantees no interactive prompt can ever hang a CI job.
        "PGCONNECT_TIMEOUT": "30",
    }
    for key, value in exports.items():
        print(f"export {key}={shlex.quote(value)}")


if __name__ == "__main__":
    main()
