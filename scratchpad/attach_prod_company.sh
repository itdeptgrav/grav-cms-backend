#!/bin/sh
# Attach every unattached company to the organisation, ON PRODUCTION, through
# the API — no database connection string needed.
#
#   sh scratchpad/attach_prod_company.sh <email> <password>
#
# It signs in as that person, upgrades to an accounting session, lists the
# companies no organisation holds, and attaches each one. The account must be
# the Accounting owner (soumyapraharaj.grav@gmail.com is).
#
# The attach itself is idempotent: running it twice reports "was already part
# of your organisation" and changes nothing.

set -e
API=${API:-https://api.grav.in}
EMAIL="$1"
PASS="$2"

if [ -z "$EMAIL" ] || [ -z "$PASS" ]; then
  echo "usage: sh scratchpad/attach_prod_company.sh <email> <password>" >&2
  exit 2
fi

say() { printf '%s\n' "$1"; }

TOKEN=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" "$API/api/auth/login" \
  | python -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
if [ -z "$TOKEN" ]; then say "Sign-in failed — check the email and password."; exit 1; fi
say "signed in"

ACC=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{}' "$API/api/accountant/auth/sync-legacy" \
  | python -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
if [ -z "$ACC" ]; then say "No accounting session — that account has no Accounting role."; exit 1; fi
say "accounting session ok"

IDS=$(curl -s -H "Authorization: Bearer $ACC" "$API/api/accountant/tally/companies/unattached" \
  | python -c "
import sys,json
d=json.load(sys.stdin)
cs=d.get('companies') or []
for c in cs: sys.stderr.write('  unattached: %s %s\n' % (c['companyName'], c['_id']))
print(' '.join(str(c['_id']) for c in cs))
")
if [ -z "$IDS" ]; then say "Nothing unattached — already consistent."; else
  for id in $IDS; do
    curl -s -X POST -H "Authorization: Bearer $ACC" -H "Content-Type: application/json" \
      -d '{}' "$API/api/accountant/tally/companies/$id/attach" \
      | python -c "import sys,json;d=json.load(sys.stdin);print('  ->',d.get('success'),d.get('message',''))"
  done
fi

say ""
say "company list now:"
curl -s -H "Authorization: Bearer $ACC" "$API/api/accountant/tally/companies" | python -c "
import sys,json
d=json.load(sys.stdin)
for c in d.get('companies') or []: print('  ', c['companyName'])
print('  count', len(d.get('companies') or []))
"
