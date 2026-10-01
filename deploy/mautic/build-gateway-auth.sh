#!/usr/bin/env sh
#
# deploy/mautic/build-gateway-auth.sh
#
# Derive the gateway's per-lane credential fingerprints from .env.
#
#   sh deploy/mautic/build-gateway-auth.sh >> deploy/mautic/.env
#
# ── WHY THE GATEWAY HOLDS THESE ────────────────────────────────────────────
# It identifies which of the three GRAV credentials is presenting a request, so
# it can apply that credential's policy. It compares the whole Authorization
# header value; it never decodes a password and never issues one. These values
# are exactly as secret as the credentials themselves, which is why they live in
# the same untracked .env and never reach a browser.
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${1:-$DIR/.env}"

get() {
  # A compose-style read: no shell sourcing, because one unterminated bracket in
  # a generated password once swallowed the rest of this file.
  sed -n "s/^$1=//p" "$ENV_FILE" | head -1
}

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

ADMIN_USER="$(get MAUTIC_ADMIN_USERNAME)"
ADMIN_PASS="$(get MAUTIC_ADMIN_PASSWORD)"
OPS_USER="$(get MAUTIC_GRAV_USERNAME)"
OPS_PASS="$(get MAUTIC_GRAV_PASSWORD)"
CONTENT_USER="$(get MAUTIC_CONTENT_USERNAME)"
CONTENT_PASS="$(get MAUTIC_CONTENT_PASSWORD)"

[ -n "$ADMIN_USER" ] || { echo "MAUTIC_ADMIN_USERNAME missing from $ENV_FILE" >&2; exit 1; }
[ -n "$OPS_USER" ] || { echo "MAUTIC_GRAV_USERNAME missing from $ENV_FILE" >&2; exit 1; }
[ -n "$CONTENT_USER" ] || { echo "MAUTIC_CONTENT_USERNAME missing from $ENV_FILE — run the provisioning script first" >&2; exit 1; }

echo "GATEWAY_ADMIN_AUTH=$(b64 "$ADMIN_USER:$ADMIN_PASS")"
echo "GATEWAY_OPERATIONAL_AUTH=$(b64 "$OPS_USER:$OPS_PASS")"
echo "GATEWAY_CONTENT_AUTH=$(b64 "$CONTENT_USER:$CONTENT_PASS")"
