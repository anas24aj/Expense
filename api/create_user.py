"""Create a login for <email> without choosing its password: prints a one-time link where the person sets their own.
    python -m api.create_user you@example.com [https://your-site]
The first account made owns the data from before accounts existed. For an email that already has an account it prints a fresh link."""
import secrets
import sys

import server


def create(email, base='http://localhost:8000'):
    db = server.DB()
    try:
        email = email.strip().lower()
        if not db.run('SELECT 1 FROM app_users WHERE email = :e', e=email):
            # The throwaway secret is never shown or kept: only its hash, which nobody can sign in with.
            server.new_user(db, email, secrets.token_urlsafe(32), owner=not db.run('SELECT 1 FROM app_users'))
        link = server.start_reset(db, email, base.rstrip('/'))
    finally:
        db.close()
    return link


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    try:
        print(create(*sys.argv[1:]))
    except ValueError as e:
        sys.exit(str(e))
