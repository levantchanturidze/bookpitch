#!/usr/bin/env python3
"""verify-postgres.py — is the postgres password current?

Tries a `SELECT 1` against a Supabase pooler using the password you're
about to paste into GH secrets / Vercel env. Prints "ok" or a
5-character SQLSTATE. On any error the script cannot classify it also
prints the raw psql stderr — swallowing that turned out to be the bug
that made the first version's XX000 uninterpretable.

Usage:
    scripts/verify-postgres.py <host> <user> [port=5432] [db=postgres]

The username MUST include the Supabase project-ref suffix:
    postgres.<project-ref>          for the postgres superuser
    bookpitch_app.<project-ref>     for the app role
    bookpitch_login.<project-ref>   for the SEC-007 narrow role
Bare `postgres` will be rejected by the pooler with `ENOIDENTIFIER`
before it even attempts auth — the previous default was that mistake.

Example (session pool):
    scripts/verify-postgres.py aws-0-eu-central-1.pooler.supabase.com \\
                               postgres.cglqphbebckvpeyisqqb

Example (transaction pool):
    scripts/verify-postgres.py aws-0-eu-central-1.pooler.supabase.com \\
                               postgres.cglqphbebckvpeyisqqb 6543

The password is prompted via getpass — never on argv, never echoed,
never logged. It reaches psql via PGPASSWORD env (child-process only;
not visible in `ps` output). SSL is required (Supabase mandates it).

Common return codes:
    28P01   password authentication failed  → wrong password
    28000   invalid authorization           → wrong user / no pg_hba
    08006   connection failure              → wrong host, DNS, or firewall
    08P01   protocol violation              → SSL / TLS mismatch
    XX000   internal error / unclassified   → full stderr also printed
"""
import getpass
import os
import re
import subprocess
import sys


def refuse_ambiguous_username(user: str, host: str) -> None:
    """Refuse bare role names on Supabase pooler hosts — same bug that
    made the previous version's XX000 uninterpretable."""
    if 'pooler.supabase.com' in host and '.' not in user:
        print(
            f"error: username '{user}' is bare — Supabase pooler needs "
            f"'{user}.<project-ref>'. The pooler rejects bare usernames "
            f"with ENOIDENTIFIER before checking the password, so this "
            f"script would give you a meaningless result.",
            file=sys.stderr,
        )
        sys.exit(2)


def main() -> int:
    if len(sys.argv) < 3 or len(sys.argv) > 5:
        print(
            "usage: verify-postgres.py <host> <user> [port=5432] [db=postgres]",
            file=sys.stderr,
        )
        return 2

    host = sys.argv[1]
    user = sys.argv[2]
    port = sys.argv[3] if len(sys.argv) >= 4 else "5432"
    db = sys.argv[4] if len(sys.argv) >= 5 else "postgres"

    refuse_ambiguous_username(user, host)

    try:
        password = getpass.getpass("password: ")
    except (EOFError, KeyboardInterrupt):
        return 130

    env = {**os.environ, "PGPASSWORD": password, "PGSSLMODE": "require"}
    try:
        result = subprocess.run(
            [
                "psql",
                "-h", host,
                "-p", port,
                "-U", user,
                "-d", db,
                "-c", "SELECT 1;",
                "-t", "-A",
                "-v", "ON_ERROR_STOP=1",
                "-q",
            ],
            env=env, capture_output=True, text=True, timeout=15,
        )
    except FileNotFoundError:
        print("XX000")
        print("psql not on PATH — install with `brew install libpq && brew link --force libpq`", file=sys.stderr)
        return 1
    except subprocess.TimeoutExpired:
        print("08006")
        print("timeout after 15s — host unreachable or firewalled", file=sys.stderr)
        return 1

    if result.returncode == 0:
        print("ok")
        return 0

    err = result.stderr
    err_low = err.lower()

    def classify() -> str | None:
        m = re.search(r"sqlstate\s*[:=]?\s*([0-9a-z]{5})", err_low)
        if m:
            return m.group(1).upper()
        if "password authentication failed" in err_low:
            return "28P01"
        if "no pg_hba.conf entry" in err_low:
            return "28000"
        if ("role" in err_low and "does not exist" in err_low):
            return "28000"
        if ("could not translate host" in err_low
            or "name or service not known" in err_low
            or "no route to host" in err_low):
            return "08006"
        if ("connection refused" in err_low
            or "timed out" in err_low
            or "operation timed out" in err_low):
            return "08006"
        if ("server closed the connection" in err_low
            or "ssl handshake" in err_low
            or "tls handshake" in err_low):
            return "08P01"
        # Supabase pooler proprietary errors — no SQLSTATE.
        if "enoidentifier" in err_low or "no tenant identifier" in err_low:
            return "28000"   # closest match — misauthentication at pooler
        return None

    code = classify() or "XX000"
    print(code)
    # Always echo the raw stderr for unclassified errors so the operator
    # can act on it. For classified errors we suppress it (the code is
    # enough) unless it's XX000, which means classification failed.
    if code == "XX000":
        print("--- psql stderr (unclassified) ---", file=sys.stderr)
        print(err.strip(), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
