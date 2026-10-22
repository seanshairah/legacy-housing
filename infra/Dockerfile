FROM postgres:16@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97 AS pgtools
FROM node:24-trixie-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client && rm -rf /var/lib/apt/lists/*
COPY --from=pgtools /usr/lib/postgresql/16/bin/pg_dump /usr/local/bin/pg_dump
COPY --from=pgtools /usr/lib/postgresql/16/bin/pg_restore /usr/local/bin/pg_restore
COPY --from=pgtools /usr/lib/postgresql/16/bin/psql /usr/local/bin/psql
COPY --from=pgtools /usr/lib/postgresql/16/bin/createdb /usr/local/bin/createdb
COPY --from=pgtools /usr/lib/x86_64-linux-gnu/libpq.so.5* /usr/lib/x86_64-linux-gnu/
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN --mount=type=secret,id=platform-ca if [ -f /run/secrets/platform-ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/platform-ca npm ci --no-audit --no-fund; else npm ci --no-audit --no-fund; fi
FROM dependencies AS build
COPY --chown=node:node . .
RUN npm run build
FROM build AS runtime
ENV NODE_ENV=production
RUN mkdir -p /app/.data/private /app/.data/backups && chmod 700 /app/.data/private /app/.data/backups && chown -R node:node /app/.data /app/.next
USER node
EXPOSE 3000
CMD ["npm","start"]
