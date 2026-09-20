"""Let one user past the §200 onboarding gate, from the shell.

The same thing the superadmin button in Settings → Admin does, for the case
where there is no second superadmin to press it — which is the case this
instance is actually in today, and the reason the two-superadmin banner exists
alongside this script.

Run on the server, from the repo root, inside the api container:

    docker compose -f docker-compose.prod.yml --env-file .env.prod -p freeframe \\
      exec api python -m apps.api.scripts.clear_account_gate someone@example.com

Add `--write` to actually apply it; without it the script only reports what it
would do. The dry run is the default deliberately: this is a security
requirement being waived for a named person, and a command that does that on a
typo is the wrong shape.

What it does NOT do, on purpose:

  * it does not set a password, and it does not invent a backup address. Both
    would put a credential or a delivery address into the database chosen by
    whoever ran a shell command, which is precisely the authority this gate
    exists to keep out of one person's hands;
  * it does not clear the requirement, only the block. `/auth/me` still
    reports what is outstanding, the settings screen still asks, and the
    moment the user verifies a backup address the waiver clears itself.
"""
import sys
from datetime import datetime, timezone

from apps.api.database import SessionLocal
from apps.api.models.activity import ActivityLog
from apps.api.models.user import User
from apps.api.services.auth_service import get_user_by_email


def main(email: str, write: bool) -> int:
    db = SessionLocal()
    try:
        # The same case-insensitive, soft-delete-aware lookup every login
        # path uses, rather than a fourth hand-rolled query — `Mathias@` and
        # `mathias@` are one account (§13a), and the retired half of a merged
        # pair must not be matched.
        user = get_user_by_email(db, email)
        if not user:
            print(f"No active account for {email!r}.")
            return 1

        print(f"user:               {user.email} ({user.name})")
        print(f"must_set_password:  {user.must_set_password}")
        print(f"backup_email:       {user.backup_email or '—'}")
        print(f"backup_email_state: {user.backup_email_state}")
        print(f"already waived:     {user.account_gate_waived_at or '—'}")

        if not user.account_setup_required:
            print("\nNothing to clear: this account's setup is already complete.")
            return 0

        if not write:
            print("\nDry run. Re-run with --write to clear the gate for this user.")
            return 0

        user.account_gate_waived_at = datetime.now(timezone.utc)
        # Logged with a null actor: nobody signed in did this, and recording
        # a user_id here would name whichever account happened to be handy
        # rather than whoever held the shell. The absence IS the information —
        # "this came from the server, not from the admin UI".
        db.add(
            ActivityLog(
                user_id=None,
                action="script_cleared_account_gate",
                payload={
                    "target_user_id": str(user.id),
                    "target_email": user.email,
                    "must_set_password": bool(user.must_set_password),
                    "backup_email_state": user.backup_email_state,
                },
            )
        )
        db.commit()
        print("\nCleared. This user can use the app again, and is still asked "
              "to finish setup in Settings → Profile.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--write"]
    if len(args) != 1:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(args[0], "--write" in sys.argv[1:]))
