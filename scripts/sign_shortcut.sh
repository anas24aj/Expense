#!/bin/sh
# Run once on a Mac (macOS 12+): builds the iOS Shortcut, signs it for anyone to install, and puts it in web/public.
# Then commit web/public/ledger-sms.shortcut and deploy; the Phones screen shows "Install Shortcut" on its own.
# (Or upload the signed file somewhere and set SHORTCUT_URL in Vercel to its link.) The file holds no key.
set -eu
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
python3 scripts/make_shortcut.py "$tmp/Ledger Send SMS.shortcut" >/dev/null
shortcuts sign --mode anyone --input "$tmp/Ledger Send SMS.shortcut" --output web/public/ledger-sms.shortcut
echo "Signed: web/public/ledger-sms.shortcut. Open it on the Mac once to check it imports, then commit and deploy."
