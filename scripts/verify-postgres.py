#!/usr/bin/env python3
"""verify-postgres.py — is the postgres password current?

Tries a `SELECT 1` against the Supabase session pooler on port 5432 using
the password you're about to paste into GH secrets / Vercel env. Prints
only "ok" or a 5-character SQLSTATE. No URL, no password, no other output.

Usage:
    scripts/verify-postgres.py <pooler-host>
    scripts/verify-postgres.py <pooler-host> [user=postgres] [db=postgres]

Example:
    scripts/verify-postgres.py aws-0-eu-central-1.pooler.supabase.com

The password is prompted via getpass — never on argv, never echoed to the
terminal, never logged. It reaches psql via the PGPASSWORD environment
variable (child-process only; not visible to other users in `ps` on
macOS or Linux). SSL is required (Supabase mandates it).

Common return codes:
    28P01   password authentication failed  → wrong password
    28000   invalid authorization           → wrong user or no pg_hba entry
    08006   connection failure              → wrong host, DNS, or firewall
    08P01   protocol violation              → SSL / TLS mismatch
    XX000   internal error / unclassified   → check psql stderr manually
"""
import getpass
import os
import re
import subprocess
import sys


def main() -> int:
    if len(sys.argv) < 2 or len(sys.argv) > 4:
        print("usage: verify-postgres.py <host> [user=postgres] [db=postgres]", file=sys.stderr)
        return 2

    host = sys.argv[1]
    user = sys.argv[2] if len(sys.argv) >= 3 else "postgres"
    db = sys.argv[3] if len(sys.argv) >= 4 else "postgres"

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
                "-p", "5432",
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
        # psql not on PATH
        print("XX000")
        return 1
    except subprocess.TimeoutExpired:
        print("08006")
        return 1

    if result.returncode == 0:
        print("ok")
        return 0

    err = result.stderr.lower()
    # If psql emitted a SQLSTATE, prefer it. Some builds do, most don't.
    m = re.search(r"sqlstate\s*[:=]?\s*([0-9a-z]{5})", err)
    if m:
        print(m.group(1).upper())
        return 1

    if "password authentication failed" in err:
        print("28P01")
    elif "no pg_hba.conf entry" in err or "role" in err and "does not exist" in err:
        print("28000")
    elif ("could not translate host" in err
          or "name or service not known" in err
          or "no route to host" in err):
        print("08006")
    elif ("connection refused" in err
          or "timed out" in err
          or "connection timed out" in err
          or "operation timed out" in err):
        print("08006")
    elif ("server closed the connection" in err
          or "ssl" in err
          or "tls" in err):
        print("08P01")
    else:
        print("XX000")
    return 1


if __name__ == "__main__":
    sys.exit(main())
