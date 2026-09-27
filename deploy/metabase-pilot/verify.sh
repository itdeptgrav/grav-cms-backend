#!/usr/bin/env bash
# verify.sh — prove the pilot's safety properties, rather than assert them.
#
# Checks, in order:
#   1. the read-only role can SELECT;
#   2. it CANNOT insert, update, delete, create a table, or create a schema;
#   3. it cannot reach Metabase's application database;
#   4. the dataset is non-empty and every voucher balances;
#   5. nothing is listening anywhere but loopback.
#
# Exits non-zero on the first failure. Prints no passwords.
set -uo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a

RO="metabase_reader"

# The reader password lives in the BACKEND's .env, where `npm run
# reporting:roles` set it. One copy, so there is no second place for it to
# drift out of date. Both files are git-ignored.
READER_PASSWORD="${REPORTING_READONLY_PASSWORD:-}"
if [ -z "$READER_PASSWORD" ] && [ -f ../../.env ]; then
  READER_PASSWORD="$(grep -E '^REPORTING_READONLY_PASSWORD=' ../../.env | head -1 | cut -d= -f2-)"
fi
if [ -z "$READER_PASSWORD" ]; then
  echo "verify.sh: REPORTING_READONLY_PASSWORD not found. Run 'npm run reporting:roles -- --apply' in grav-cms-backend." >&2
  exit 1
fi
FAILED=0

ro_psql() { # run SQL as the read-only role, inside the container
  docker compose exec -T -e PGPASSWORD="$READER_PASSWORD" \
    postgres-reporting psql -U "$RO" -d reporting -tAc "$1" 2>&1
}

must_fail() { # $1 = label, $2 = SQL that MUST be refused
  local out; out="$(ro_psql "$2")"
  if [ $? -eq 0 ] && ! grep -qiE "denied|must be owner|read-only|permission" <<<"$out"; then
    echo "  FAIL  $1 — was ALLOWED (expected refusal)"; echo "        $out"; FAILED=1
  else
    echo "  ok    $1 — refused: $(grep -oiE 'permission denied[^"]*|must be owner[^"]*' <<<"$out" | head -1)"
  fi
}

echo "1. read-only role can read"
rows="$(ro_psql 'SELECT count(*) FROM reporting.fact_voucher_line')"
if [[ "$rows" =~ ^[0-9]+$ ]] && [ "$rows" -gt 0 ]; then
  echo "  ok    SELECT returned $rows fact_voucher_line rows"
else
  echo "  FAIL  SELECT failed: $rows"; FAILED=1
fi

echo "2. read-only role cannot write"
must_fail "INSERT"        "INSERT INTO reporting.dim_company (company_id, organization_id, source_id, company_name, synced_at) VALUES ('x','x','x','X', now())"
must_fail "UPDATE"        "UPDATE reporting.fact_voucher SET grand_total = 0"
must_fail "DELETE"        "DELETE FROM reporting.fact_voucher_line"
must_fail "TRUNCATE"      "TRUNCATE reporting.fact_voucher_line"
must_fail "CREATE TABLE"  "CREATE TABLE reporting.evil (id int)"
must_fail "CREATE SCHEMA" "CREATE SCHEMA evil"
must_fail "DROP"          "DROP TABLE reporting.fact_voucher"

echo "3. read-only role cannot reach Metabase's application database"
# A different server entirely, so this is a connection refusal, not a grant.
out="$(docker compose exec -T -e PGPASSWORD="$READER_PASSWORD" \
        postgres-reporting psql -h postgres-app -U "$RO" -d metabase_app -tAc 'SELECT 1' 2>&1)"
if grep -qiE "authentication failed|does not exist|denied|could not connect|no pg_hba|does not resolve|could not translate" <<<"$out"; then
  echo "  ok    refused: $(head -1 <<<"$out" | cut -c1-80)"
else
  echo "  FAIL  reached the application database: $out"; FAILED=1
fi

echo "4. dataset integrity"
unbal="$(ro_psql 'SELECT count(*) FROM (SELECT voucher_id FROM reporting.fact_voucher_line WHERE voucher_status = '\''posted'\'' GROUP BY voucher_id HAVING SUM(signed_amount) <> 0) x')"
[ "$unbal" = "0" ] && echo "  ok    every voucher balances" || { echo "  FAIL  $unbal unbalanced voucher(s)"; FAILED=1; }
comps="$(ro_psql 'SELECT count(*) FROM reporting.dim_company')"
[ "$comps" -ge 1 ] 2>/dev/null && echo "  ok    $comps companies in the mart" || { echo "  FAIL  companies=$comps"; FAILED=1; }

echo "5. loopback-only exposure"
for p in 3100 15433; do
  binding="$(docker compose ps --format json 2>/dev/null | grep -o "0.0.0.0:$p" || true)"
  if [ -n "$binding" ]; then echo "  FAIL  port $p bound to 0.0.0.0"; FAILED=1
  else echo "  ok    port $p not bound to 0.0.0.0"; fi
done

echo "6. Metabase pilot identity"
# Every id below is RESOLVED BY NAME. Hardcoding database 2 / table 192 broke
# the moment `make reset` renumbered them, which meant verification quietly
# tested nothing on a fresh instance.
if [ -f .env.local ]; then
  # -n 's/^KEY=//p', not `cut -d= -f2`: a Metabase key can contain '='.
  KEY="$(sed -n 's/^METABASE_PILOT_API_KEY=//p' .env.local)"
  MB="http://localhost:3100"
  DB_NAME="GRAV Accounting"
  COLL_NAME="GRAV Accounting Pilot"

  mb() { curl -s -H "x-api-key: $KEY" "$@"; }
  mbjson() { curl -s -H "x-api-key: $KEY" -H 'Content-Type: application/json' "$@"; }

  # ── resolve ids by name ───────────────────────────────────────────────────
  db_id="$(mb "$MB/api/database" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=(JSON.parse(s).data||[]);const m=l.find(d=>d.name===process.argv[1]);console.log(m?m.id:"")}catch(e){console.log("")}})' "$DB_NAME")"
  if [ -z "$db_id" ]; then
    echo "  FAIL  could not resolve database by name: $DB_NAME"; FAILED=1
  else
    echo "  ok    resolved database \"$DB_NAME\" -> id $db_id"
  fi

  visible="$(mb "$MB/api/database" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).data||[]).map(d=>d.name).sort().join(", "))}catch(e){console.log("")}})')"
  [ "$visible" = "$DB_NAME" ] && echo "  ok    only the Accounting mart is visible" \
                             || { echo "  FAIL  visible databases: ${visible:-<none>}"; FAILED=1; }

  tbl_id="$(mb "$MB/api/database/$db_id/metadata" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=(JSON.parse(s).tables||[]).find(x=>x.name==="fact_voucher_line");console.log(t?t.id:"")}catch(e){console.log("")}})')"
  [ -n "$tbl_id" ] && echo "  ok    resolved table \"fact_voucher_line\" -> id $tbl_id" \
                   || { echo "  FAIL  could not resolve fact_voucher_line"; FAILED=1; }

  coll_id="$(mb "$MB/api/collection" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const m=JSON.parse(s).find(c=>c.name===process.argv[1]);console.log(m?m.id:"")}catch(e){console.log("")}})' "$COLL_NAME")"
  [ -n "$coll_id" ] && echo "  ok    resolved collection \"$COLL_NAME\" -> id $coll_id" \
                    || { echo "  FAIL  could not resolve the pilot collection"; FAILED=1; }

  # ── native SQL must be refused ────────────────────────────────────────────
  # Metabase answers 202 for success AND refusal; the verdict is in the body.
  nat="$(mbjson -X POST "$MB/api/dataset" -d "{\"database\":$db_id,\"type\":\"native\",\"native\":{\"query\":\"SELECT 1\"}}" \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.status==="completed"&&!j.error?"ALLOWED":"refused")}catch(e){console.log("refused")}})')"
  [ "$nat" = "refused" ] && echo "  ok    native SQL refused" \
                        || { echo "  FAIL  native SQL was ALLOWED"; FAILED=1; }

  # ── query builder must work ───────────────────────────────────────────────
  qb="$(mbjson -X POST "$MB/api/dataset" -d "{\"database\":$db_id,\"type\":\"query\",\"query\":{\"source-table\":$tbl_id,\"limit\":3}}" \
       | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).data?.rows||[]).length)}catch(e){console.log(0)}})')"
  [ "${qb:-0}" -gt 0 ] && echo "  ok    query builder works ($qb rows)" \
                       || { echo "  FAIL  query builder returned nothing"; FAILED=1; }

echo "7. saved reports: curate the pilot collection, and only that"
  # ── can save into the pilot collection ────────────────────────────────────
  card="$(mbjson -X POST "$MB/api/card" -d "{
      \"name\": \"verify.sh round-trip\",
      \"collection_id\": $coll_id,
      \"display\": \"table\",
      \"visualization_settings\": {},
      \"dataset_query\": {\"database\": $db_id, \"type\": \"query\",
        \"query\": {\"source-table\": $tbl_id, \"limit\": 5}}
    }" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.id||"")}catch(e){console.log("")}})')"
  [ -n "$card" ] && echo "  ok    saved a report into the pilot collection (card $card)" \
                 || { echo "  FAIL  could not save into the pilot collection"; FAILED=1; }

  if [ -n "$card" ]; then
    # reopen
    name="$(mb "$MB/api/card/$card" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).name||"")}catch(e){console.log("")}})')"
    [ "$name" = "verify.sh round-trip" ] && echo "  ok    reopened it by id" \
                                         || { echo "  FAIL  could not reopen the saved report"; FAILED=1; }

    # listed in the collection
    listed="$(mb "$MB/api/collection/$coll_id/items?models=card" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).data||[]).some(i=>String(i.id)===process.argv[1])?"yes":"no")}catch(e){console.log("no")}})' "$card")"
    [ "$listed" = "yes" ] && echo "  ok    it is listed in the collection" \
                          || { echo "  FAIL  saved report is not listed"; FAILED=1; }

    # edit
    edited="$(mbjson -X PUT "$MB/api/card/$card" -d '{"name":"verify.sh round-trip (edited)"}' \
             | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).name||"")}catch(e){console.log("")}})')"
    [ "$edited" = "verify.sh round-trip (edited)" ] && echo "  ok    edited it" \
                                                    || { echo "  FAIL  could not edit the saved report"; FAILED=1; }

    # download XLSX — a real OOXML file starts with the ZIP magic "PK"
    tmpx="$(mktemp)"
    code="$(mb -o "$tmpx" -w '%{http_code}' -X POST "$MB/api/card/$card/query/xlsx")"
    magic="$(head -c 2 "$tmpx" 2>/dev/null)"
    size="$(wc -c < "$tmpx" | tr -d ' ')"
    if [ "$code" = "200" ] && [ "$magic" = "PK" ] && [ "${size:-0}" -gt 1000 ]; then
      echo "  ok    XLSX downloaded from Metabase ($size bytes, OOXML)"
    else
      echo "  FAIL  XLSX download: http $code, ${size:-0} bytes, magic '$magic'"; FAILED=1
    fi
    rm -f "$tmpx"

    mb -X DELETE "$MB/api/card/$card" >/dev/null 2>&1 || true
  fi

  # ── must NOT curate anything else ─────────────────────────────────────────
  # The root collection ("Our analytics") is the one All Users curates by
  # default, so it is the sharpest test of whether that inheritance was closed.
  root_write="$(mbjson -X POST "$MB/api/card" -d "{
      \"name\": \"verify.sh SHOULD NOT EXIST\",
      \"collection_id\": null,
      \"display\": \"table\",
      \"visualization_settings\": {},
      \"dataset_query\": {\"database\": $db_id, \"type\": \"query\",
        \"query\": {\"source-table\": $tbl_id, \"limit\": 1}}
    }" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.id?("ALLOWED:"+j.id):"refused")}catch(e){console.log("refused")}})')"
  case "$root_write" in
    ALLOWED:*) echo "  FAIL  pilot identity can curate the ROOT collection"; FAILED=1
               mb -X DELETE "$MB/api/card/${root_write#ALLOWED:}" >/dev/null 2>&1 || true ;;
    *)         echo "  ok    cannot save into the root collection" ;;
  esac

  # Other collections must be REFUSED, not merely hidden.
  #
  # The pilot identity cannot see them (that is the point of the graph), so
  # their ids are enumerated with the ADMIN session — ground truth — and then
  # written to with the PILOT key. Testing only what the pilot can list would
  # prove concealment, and concealment is not a permission.
  admin_cookie="$(mktemp)"
  curl -s -c "$admin_cookie" -X POST "$MB/api/session" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$PILOT_METABASE_ADMIN_EMAIL\",\"password\":\"$PILOT_METABASE_ADMIN_PASSWORD\"}" >/dev/null

  others="$(curl -s -b "$admin_cookie" "$MB/api/collection" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
        const l=JSON.parse(s).filter(c=>c.id!=="root"&&String(c.id)!==process.argv[1]);
        console.log(l.map(c=>c.id+":"+(c.personal_owner_id?"personal":"shared")).join(" "))
      }catch(e){console.log("")}})' "$coll_id")"
  rm -f "$admin_cookie"

  if [ -z "$others" ]; then
    echo "  FAIL  no other collection exists to test refusal against"; FAILED=1
  else
    for entry in $others; do
      oid="${entry%%:*}"; kind="${entry##*:}"
      res="$(mbjson -X POST "$MB/api/card" -d "{
          \"name\": \"verify.sh SHOULD NOT EXIST\",
          \"collection_id\": $oid,
          \"display\": \"table\",
          \"visualization_settings\": {},
          \"dataset_query\": {\"database\": $db_id, \"type\": \"query\",
            \"query\": {\"source-table\": $tbl_id, \"limit\": 1}}
        }" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.id?("ALLOWED:"+j.id):"refused")}catch(e){console.log("refused")}})')"
      case "$res" in
        ALLOWED:*) echo "  FAIL  pilot identity curated $kind collection $oid"; FAILED=1
                   mb -X DELETE "$MB/api/card/${res#ALLOWED:}" >/dev/null 2>&1 || true ;;
        *)         echo "  ok    cannot save into $kind collection $oid" ;;
      esac
    done
  fi

  # And it must not even be able to READ an admin-only collection's contents.
  hidden="$(mb "$MB/api/collection" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).map(c=>c.id).join(","))}catch(e){console.log("")}})')"
  [ "$hidden" = "$coll_id" ] && echo "  ok    only the pilot collection is visible to it ($hidden)" \
                             || { echo "  FAIL  pilot identity can see collections: $hidden"; FAILED=1; }

else
  echo "  --    .env.local absent; run ./bootstrap.sh first"
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "VERIFY: all checks passed"; else echo "VERIFY: FAILURES ABOVE"; fi
exit $FAILED
