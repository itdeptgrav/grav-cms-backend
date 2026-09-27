#!/usr/bin/env bash
# bootstrap.sh — idempotent local Metabase configuration for the pilot.
#
# Safe to re-run: every step checks for what it is about to create.
#
# It configures, in order:
#   1. the first admin (only if Metabase has never been set up);
#   2. the synthetic reporting database, connected as the READ-ONLY role;
#   3. the "GRAV Accounting Pilot" collection saved reports go into;
#   4. a "GRAV Accounting Pilot" group with query-builder access and
#      native SQL explicitly denied;
#   5. an API key for local SDK evaluation, written to .env.local.
#
# Secrets: the API key is printed by Metabase exactly once, at creation. It is
# written to .env.local (git-ignored) and never echoed here.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a

MB="http://localhost:3100"
COOKIE="$(mktemp)"; trap 'rm -f "$COOKIE"' EXIT
J() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const f=process.argv[1].split(".");let v=j;for(const k of f)v=v?.[k];console.log(typeof v==="object"?JSON.stringify(v):(v??""));}catch(e){console.log("")}})' "$1"; }

say() { printf '  %s\n' "$*"; }

# ── 1. first admin ──────────────────────────────────────────────────────────
props="$(curl -sf "$MB/api/session/properties")"
if [ "$(J 'has-user-setup' <<<"$props")" = "false" ]; then
  say "creating the first admin user"
  token="$(J 'setup-token' <<<"$props")"
  curl -sf -X POST "$MB/api/setup" -H 'Content-Type: application/json' -d "$(node -e '
    const [token,email,password]=process.argv.slice(1);
    process.stdout.write(JSON.stringify({token,
      user:{first_name:"Pilot",last_name:"Admin",email,password,site_name:"GRAV Accounting Pilot"},
      prefs:{site_name:"GRAV Accounting Pilot",site_locale:"en",allow_tracking:false}}));
  ' "$token" "$PILOT_METABASE_ADMIN_EMAIL" "$PILOT_METABASE_ADMIN_PASSWORD")" >/dev/null
  say "admin created"
else
  say "Metabase already set up — skipping admin creation"
fi

# ── session ─────────────────────────────────────────────────────────────────
curl -sf -c "$COOKIE" -X POST "$MB/api/session" -H 'Content-Type: application/json' \
  -d "$(node -e 'process.stdout.write(JSON.stringify({username:process.argv[1],password:process.argv[2]}))' \
        "$PILOT_METABASE_ADMIN_EMAIL" "$PILOT_METABASE_ADMIN_PASSWORD")" >/dev/null
api() { curl -sf -b "$COOKIE" -H 'Content-Type: application/json' "$@"; }

# ── 2. the reporting mart, connected read-only ──────────────────────────────
#
# REAL Accounting data now, not the synthetic dataset. The mart lives in schema
# `reporting` and is built and filled entirely from the backend:
#
#   npm run reporting:migrate -- --apply
#   npm run reporting:roles   -- --apply
#   npm run reporting:sync    -- --full
#
# The connection user is `metabase_reader`, whose SELECT-only grant is proved
# by `npm run reporting:verify-roles` rather than asserted here.
#
# The password is read from the BACKEND's .env, which is where
# `reporting:roles` set it. Both files are git-ignored; keeping one copy means
# there is no second place for it to drift out of date.
BACKEND_ENV="../../.env"
READER_PASSWORD="${REPORTING_READONLY_PASSWORD:-}"
if [ -z "$READER_PASSWORD" ] && [ -f "$BACKEND_ENV" ]; then
  READER_PASSWORD="$(grep -E '^REPORTING_READONLY_PASSWORD=' "$BACKEND_ENV" | head -1 | cut -d= -f2-)"
fi
if [ -z "$READER_PASSWORD" ]; then
  say "ERROR: REPORTING_READONLY_PASSWORD not found (checked the environment and $BACKEND_ENV)."
  say "       Run: npm run reporting:roles -- --apply   in grav-cms-backend first."
  exit 1
fi

DB_NAME="GRAV Accounting"
LEGACY_DB_NAME="Synthetic Accounting (Pilot)"

db_payload() {
  node -e '
    process.stdout.write(JSON.stringify({
      name: process.argv[1], engine: "postgres",
      details: { host: "postgres-reporting", port: 5432, dbname: "reporting",
                 user: "metabase_reader", password: process.argv[2],
                 // Only the mart. A schema this filter does not name is a
                 // schema the query builder cannot offer.
                 "schema-filters-type": "inclusion", "schema-filters-patterns": "reporting",
                 ssl: false, "tunnel-enabled": false },
      is_full_sync: true
    }));' "$1" "$READER_PASSWORD"
}

find_db() {
  api "$MB/api/database" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const l=(j.data||j);const m=l.find(d=>d.name===process.argv[1]);console.log(m?m.id:"")})' "$1"
}

db_id="$(find_db "$DB_NAME")"
legacy_id="$(find_db "$LEGACY_DB_NAME")"

if [ -z "$db_id" ] && [ -n "$legacy_id" ]; then
  # The synthetic entry, pointed at a schema that no longer exists and a role
  # that has been dropped. Repointed in place rather than deleted and recreated
  # so that the database id the frontend may already hold stays valid.
  say "repointing \"$LEGACY_DB_NAME\" (id $legacy_id) at the real mart"
  api -X PUT "$MB/api/database/$legacy_id" -d "$(db_payload "$DB_NAME")" >/dev/null
  db_id="$legacy_id"
elif [ -z "$db_id" ]; then
  say "adding the Accounting mart (as metabase_reader, schema reporting)"
  db_id="$(api -X POST "$MB/api/database" -d "$(db_payload "$DB_NAME")" | J id)"
else
  say "Accounting mart already present (id $db_id) — refreshing its connection"
  api -X PUT "$MB/api/database/$db_id" -d "$(db_payload "$DB_NAME")" >/dev/null
fi

# ── schema rescan ───────────────────────────────────────────────────────────
# Metabase discovers tables on a schedule. After a repoint or a migration that
# adds a table or view, the builder shows yesterday's picker until a rescan
# runs — so it is triggered explicitly rather than waited for.
say "triggering a schema rescan (database $db_id)"
api -X POST "$MB/api/database/$db_id/sync_schema" >/dev/null || say "  (rescan request failed)"
for _ in $(seq 1 40); do
  n="$(api "$MB/api/database/$db_id/metadata" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=(JSON.parse(s).tables||[]).filter(x=>x.schema==="reporting"&&x.active!==false);console.log(t.length)}catch(e){console.log(0)}})')"
  [ "${n:-0}" -ge 9 ] && break; sleep 3
done
say "discovered $n table(s)/view(s) in schema reporting"

# ── 3. collection ───────────────────────────────────────────────────────────
COLL_NAME="GRAV Accounting Pilot"
coll_id="$(api "$MB/api/collection" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s).find(c=>c.name===process.argv[1]);console.log(m?m.id:"")})' "$COLL_NAME")"
if [ -z "$coll_id" ]; then
  say "creating collection \"$COLL_NAME\""
  coll_id="$(api -X POST "$MB/api/collection" -d "$(node -e 'process.stdout.write(JSON.stringify({name:process.argv[1],description:"Saved Accounting reports. Real data, synced from MongoDB by npm run reporting:sync."}))' "$COLL_NAME")" | J id)"
else
  say "collection already present (id $coll_id)"
fi

# ── 4. pilot group: query builder yes, native SQL no ────────────────────────
GROUP_NAME="GRAV Accounting Pilot"
group_id="$(api "$MB/api/permissions/group" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s).find(g=>g.name===process.argv[1]);console.log(m?m.id:"")})' "$GROUP_NAME")"
if [ -z "$group_id" ]; then
  say "creating group \"$GROUP_NAME\""
  group_id="$(api -X POST "$MB/api/permissions/group" -d "$(node -e 'process.stdout.write(JSON.stringify({name:process.argv[1]}))' "$GROUP_NAME")" | J id)"
fi

say "setting data permissions: query-builder only, native SQL denied"
graph="$(api "$MB/api/permissions/graph")"
new_graph="$(node -e '
  const [raw, gid, dbid] = process.argv.slice(1);
  const g = JSON.parse(raw);
  g.groups = g.groups || {};

  // The pilot group: the visual builder, and nothing else.
  g.groups[gid] = g.groups[gid] || {};
  g.groups[gid][dbid] = {
    // "query-builder" — NOT "query-builder-and-native". This is the line that
    // keeps an ordinary pilot user out of the SQL editor.
    "view-data": "unrestricted",
    "create-queries": "query-builder",
    download: { schemas: "full" },
  };

  // EVERY OTHER non-admin group loses native SQL on this database.
  //
  // Metabase grants the MOST PERMISSIVE permission across all of a user"s
  // groups, and every user is in "All Users" (group 1), which ships with
  // `query-builder-and-native`. Restricting the pilot group alone therefore
  // changes nothing at all — the pilot identity still reached the SQL editor
  // through All Users. Verified: before this, a native `SELECT 1` ran.
  //
  // Administrators (group 2) is left alone deliberately: it is how a developer
  // administers the local instance, and it is not the identity the app embeds.
  for (const [id, dbs] of Object.entries(g.groups)) {
    if (id === gid || id === "2") continue;
    if (!dbs[dbid]) continue;
    if (dbs[dbid]["create-queries"] === "query-builder-and-native") {
      dbs[dbid]["create-queries"] = "no";
    }
  }
  process.stdout.write(JSON.stringify(g));
' "$graph" "$group_id" "$db_id")"
api -X PUT "$MB/api/permissions/graph" -d "$new_graph" >/dev/null && say "permissions applied"

# ── 4b. collection permissions ──────────────────────────────────────────────
# Data permissions decide what the pilot identity may QUERY. Collection
# permissions decide what it may SAVE INTO and BROWSE, and they are a separate
# graph with its own revision — granting one does not grant the other.
#
# Same inheritance trap as the data graph, and it bites harder here: "All Users"
# ships with `write` on the root collection ("Our analytics") and on every
# collection created under it, so without this the pilot identity could curate
# the entire instance. Metabase takes the most permissive grant across a user's
# groups, so restricting the pilot group alone would change nothing.
#
# Result: the pilot group curates its own collection and nothing else; All Users
# curates nothing. Administrators is untouched — it is how a developer manages
# the instance and is not the identity the app embeds.
say "setting collection permissions: curate ONLY \"$COLL_NAME\""
cgraph="$(api "$MB/api/collection/graph")"
new_cgraph="$(node -e '
  const [raw, gid, cid] = process.argv.slice(1);
  const g = JSON.parse(raw);
  g.groups = g.groups || {};

  // The pilot group: write on its own collection, explicitly none elsewhere.
  const pilot = { ...(g.groups[gid] || {}) };
  for (const key of Object.keys(pilot)) pilot[key] = "none";
  pilot.root = "none";
  pilot[cid] = "write";
  g.groups[gid] = pilot;

  // Every other non-admin group loses curate/read on the collections this
  // graph governs. Group "2" is Administrators.
  for (const [id, colls] of Object.entries(g.groups)) {
    if (id === gid || id === "2") continue;
    for (const key of Object.keys(colls)) colls[key] = "none";
  }
  process.stdout.write(JSON.stringify(g));
' "$cgraph" "$group_id" "$coll_id")"
api -X PUT "$MB/api/collection/graph" -d "$new_cgraph" >/dev/null && say "collection permissions applied"

# ── 5. local-evaluation API key ─────────────────────────────────────────────
KEY_NAME="grav-accounting-pilot-local"
existing="$(api "$MB/api/api-key" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const m=JSON.parse(s).find(k=>k.name===process.argv[1]);console.log(m?m.id:"")}catch(e){console.log("")}})' "$KEY_NAME")"
if [ -n "$existing" ] && grep -q "METABASE_PILOT_API_KEY=" .env.local 2>/dev/null; then
  say "API key already provisioned and present in .env.local"
else
  [ -n "$existing" ] && { say "rotating API key (value was not retained)"; api -X DELETE "$MB/api/api-key/$existing" >/dev/null || true; }
  say "creating local-evaluation API key"
  # The PILOT group, deliberately — not Administrators. An admin key can run
  # native SQL, and "no SQL editor for ordinary Accounting users" is a property
  # of the credential, not of the UI we happen to render around it.
  key="$(api -X POST "$MB/api/api-key" -d "$(node -e 'process.stdout.write(JSON.stringify({name:process.argv[1],group_id:Number(process.argv[2])}))' "$KEY_NAME" "$group_id")" | J unmasked_key)"
  if [ -z "$key" ]; then say "WARNING: could not create an API key — see README, step 4"; else
    umask 077
    cat > .env.local <<KEYEOF
# Written by bootstrap.sh. GIT-IGNORED. Local evaluation only.
# Regenerate with: ./bootstrap.sh   (delete this file first to force rotation)
METABASE_PILOT_API_KEY=$key
KEYEOF
    say "API key written to .env.local (not printed, not committed)"
  fi
fi


# ── 6. static embedding, for the chart bridge ───────────────────────────────
#
# GRAV draws its charts by creating a hidden question and handing the browser a
# two-minute signed token for it. That needs two things this instance does not
# have out of the box: static embedding switched on, and a secret to sign the
# tokens with. Both are instance settings and both need an administrator, which
# is why they are done HERE, once, rather than by the server at runtime.
#
# The runtime service then needs one more credential, and only for one call:
# `PUT /api/card/:id {enable_embedding:true}` is gated behind superuser in
# Metabase 1.63.1, and the pilot's query-builder key gets 403. The flag
# persists once set, so the admin key is touched once per question and never
# again — see services/reporting/metabaseCharts.service.js, which refuses to
# authenticate anything else with it.
say "enabling static embedding"
api -X PUT "$MB/api/setting/enable-embedding-static" -d '{"value":true}' >/dev/null

embed_secret="$(api "$MB/api/session/properties" | J 'embedding-secret-key')"
if [ -z "$embed_secret" ]; then
  say "generating an embedding secret"
  embed_secret="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
  api -X PUT "$MB/api/setting/embedding-secret-key" -d "$(node -e 'process.stdout.write(JSON.stringify({value:process.argv[1]}))' "$embed_secret")" >/dev/null
fi

ADMIN_KEY_NAME="GRAV chart embedding"
admin_group="$(api "$MB/api/permissions/group" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const g=JSON.parse(s).find(x=>x.name==="Administrators");console.log(g?g.id:"")})')"
existing_admin_key="$(api "$MB/api/api-key" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).find(x=>x.name===process.argv[1]);console.log(k?k.id:"")})' "$ADMIN_KEY_NAME")"
if [ -n "$existing_admin_key" ]; then
  say "embedding admin key already present (not rotated)"
  embed_admin_key=""
else
  say "creating the embedding admin key"
  embed_admin_key="$(api -X POST "$MB/api/api-key" -d "$(node -e 'process.stdout.write(JSON.stringify({name:process.argv[1],group_id:Number(process.argv[2])}))' "$ADMIN_KEY_NAME" "$admin_group")" | J unmasked_key)"
fi

echo
say "── the chart bridge wants these in the BACKEND's .env ──"
echo "    METABASE_EMBEDDING_SECRET=$embed_secret"
if [ -n "$embed_admin_key" ]; then
  echo "    METABASE_EMBED_ADMIN_API_KEY=$embed_admin_key"
else
  echo "    METABASE_EMBED_ADMIN_API_KEY=<unchanged — delete the \"$ADMIN_KEY_NAME\" key in Metabase to rotate>"
fi
echo "    METABASE_REPORTING_COLLECTION_ID=$coll_id"
echo

echo
say "collection id: $coll_id"
say "database id:   $db_id"
say "group id:      $group_id"
echo
echo "Copy these into grav-cms/.env.local — SERVER-ONLY names, no NEXT_PUBLIC_"
echo "prefix, so Next cannot inline the key into a browser bundle:"
echo "    METABASE_PILOT_ENABLED=true"
echo "    METABASE_PILOT_SITE_URL=$MB"
echo "    METABASE_PILOT_COLLECTION_ID=$coll_id"
echo "    METABASE_PILOT_API_KEY=<the value in deploy/metabase-pilot/.env.local>"
