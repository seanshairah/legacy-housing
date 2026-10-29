#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  node --input-type=module - <<'JS'
import {randomBytes} from 'node:crypto';import {writeFileSync} from 'node:fs';
const key=()=>randomBytes(32).toString('hex');
writeFileSync('.env',`DATABASE_URL="postgresql://postgres@127.0.0.1:5432/legacy_dev"\nAPP_URL="http://localhost:3001"\nDATA_KEY="${key()}"\nFILE_KEY="${key()}"\nBACKUP_KEY="${key()}"\nLOCAL_DB_PASSWORD="${key()}"\nLOCAL_DEMO="true"\nSTORAGE_ROOT=".data/private"\nCLAMAV_HOST="127.0.0.1"\nPAYNOW_MODE="disabled"\n`,{mode:0o600,flag:'wx'});
JS
fi
npm ci --cache /workspace/.npm --no-audit --no-fund
LH_DB_CONTAINER=legacy-local-db
if docker inspect housing-onboarding-db >/dev/null 2>&1; then LH_DB_CONTAINER=housing-onboarding-db; fi
if ! docker inspect "$LH_DB_CONTAINER" >/dev/null 2>&1; then
  docker run -d --name "$LH_DB_CONTAINER" -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:5432:5432 postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97
else docker start "$LH_DB_CONTAINER" >/dev/null; fi
for attempt in $(seq 1 30); do docker exec "$LH_DB_CONTAINER" pg_isready -U postgres && break; sleep 1; done
for database in legacy_dev legacy_test; do
  LH_EXISTS=$(docker exec "$LH_DB_CONTAINER" psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$database'")
  if [ "$LH_EXISTS" != "1" ]; then docker exec "$LH_DB_CONTAINER" createdb -U postgres "$database"; fi
done
if ! docker inspect legacy-scanner >/dev/null 2>&1; then
  docker run -d --health-cmd="clamdscan --ping 1" --health-interval=15s --health-timeout=10s --health-retries=20 --name legacy-scanner -p 127.0.0.1:3310:3310 -e CLAMAV_NO_FRESHCLAMD=true clamav/clamav:stable@sha256:e19130cdebaeacc71fa46eab3ed6f69941f2f22aa5e08d55e9197f8edf43ce5e
else docker start legacy-scanner >/dev/null; fi
npm run db:deploy
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/legacy_test npm run db:deploy
npm run db:seed
