import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient, Prisma } from "@prisma/client";
import { encrypt, decrypt, hash } from "../src/lib/security";

// Physical document deletion takes the matching exclusive transaction lock.
// Acquire this session lock before starting Repeatable Read: taking a snapshot
// before waiting for a deletion lock could retain metadata for an already-unlinked file.
// Uploads may continue: only references visible in the exported DB snapshot are included.
const FILE_SNAPSHOT_LOCK = 648271430;
type Fingerprint = { rows: string; digest: string };
type FileEntry = { key: string; data: string; hash: string };
type DocumentEntry = { id: string; key: string; hash: string; bytes: number };
type BackupPayload = {
  version: 1 | 2;
  createdAt: string;
  database: string;
  dump: string;
  dumpHash: string;
  files: FileEntry[];
  documents?: DocumentEntry[];
  tables?: Record<string, Fingerprint>;
};

export function run(
  program: string,
  args: string[],
  input?: Buffer,
  env?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  return new Promise((res, rej) => {
    const p = spawn(program, args, {
        env: env || process.env,
        stdio: ["pipe", "pipe", "pipe"],
      }),
      out: Buffer[] = [];
    p.stdout.on("data", (b) => out.push(b));
    // Tool output can contain connection or row details. Keep errors private.
    p.stderr.resume();
    p.on("error", rej);
    p.on("close", (code) =>
      code === 0
        ? res(Buffer.concat(out))
        : rej(
            new Error(
              `Backup tool ${program} failed (${code}); inspect the database service logs.`,
            ),
          ),
    );
    p.stdin.on("error", () => {
      // A failing subprocess can close stdin before a dump has been fully written.
    });
    p.stdin.end(input);
  });
}
function connection(database?: string) {
  const u = new URL(process.env.DATABASE_URL!);
  const name = database || u.pathname.slice(1);
  if (!/^legacy_[a-z0-9_]+$/.test(name))
    throw new Error("DEDICATED_LEGACY_DATABASE_REQUIRED");
  u.pathname = `/${name}`;
  return {
    name,
    url: u.toString(),
    env: {
      ...process.env,
      PGHOST: u.hostname,
      PGPORT: u.port || "5432",
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: name,
    },
  };
}
function pg(tool: string, args: string[], database?: string, input?: Buffer) {
  const c = connection(database);
  return process.env.BACKUP_DOCKER_CONTAINER
    ? run(
        "docker",
        [
          "exec",
          "-i",
          process.env.BACKUP_DOCKER_CONTAINER,
          tool,
          "-U",
          "postgres",
          ...args,
        ],
        input,
      )
    : run(tool, args, input, c.env);
}
async function fingerprints(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
  const tables = await tx.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  const result: Record<string, Fingerprint> = {};
  for (const { tablename } of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablename))
      throw new Error("UNEXPECTED_TABLE_IDENTIFIER");
    // Identifiers originate only from pg_catalog and pass an identifier allowlist.
    // Hash each row before aggregating, so private contents are never returned/logged.
    const rows = await tx.$queryRaw<Fingerprint[]>(
      Prisma.sql`SELECT count(*)::text AS rows, md5(coalesce(string_agg(md5(row_to_json(t)::text), '' ORDER BY md5(row_to_json(t)::text)),'')) AS digest FROM ${Prisma.raw(`public."${tablename}"`)} t`,
    );
    result[tablename] = rows[0];
  }
  return result;
}
function sameFingerprints(
  a: Record<string, Fingerprint>,
  b: Record<string, Fingerprint>,
) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function validateFiles(payload: BackupPayload) {
  const keys = new Set<string>();
  for (const f of payload.files) {
    if (!/^[\w-]+$/.test(f.key) || keys.has(f.key))
      throw new Error("INVALID_FILE_ENTRY");
    keys.add(f.key);
    if (hash(Buffer.from(f.data, "base64")) !== f.hash)
      throw new Error("FILE_BACKUP_INTEGRITY");
  }
  if (payload.version === 2) {
    if (
      !payload.tables ||
      !payload.documents ||
      keys.size !== payload.documents.length
    )
      throw new Error("BACKUP_MANIFEST_REQUIRED");
    for (const d of payload.documents) {
      const f = payload.files.find((file) => file.key === d.key);
      if (!f) throw new Error("DOCUMENT_BACKUP_MISSING");
      const plain = decrypt(
        Buffer.from(f.data, "base64").toString(),
        "FILE_KEY",
      );
      if (plain.length !== d.bytes || hash(plain) !== d.hash)
        throw new Error("DOCUMENT_BACKUP_INTEGRITY");
    }
  }
}

export async function backup() {
  const c = connection();
  const backupUrl = new URL(c.url);
  backupUrl.searchParams.set("connection_limit", "1");
  const client = new PrismaClient({ datasourceUrl: backupUrl.toString() });
  let snapshotLocked = false;
  let payload: BackupPayload;
  try {
    await client.$executeRaw`SELECT pg_advisory_lock_shared(${FILE_SNAPSHOT_LOCK})`;
    snapshotLocked = true;
    payload = await client.$transaction(
      async (tx) => {
        const [snapshot] = await tx.$queryRaw<
          { snapshot: string }[]
        >`SELECT pg_export_snapshot() AS snapshot`;
        if (!/^[A-Fa-f0-9-]+$/.test(snapshot.snapshot))
          throw new Error("INVALID_SNAPSHOT_IDENTIFIER");
        const documents = await tx.document.findMany({
          where: {
            deletedAt: null,
            state: { notIn: ["DELETED", "DELETION_PENDING"] },
          },
          select: { id: true, storageKey: true, hash: true, bytes: true },
          orderBy: { id: "asc" },
        });
        const dump = await pg("pg_dump", [
          "-Fc",
          "--no-owner",
          "--snapshot",
          snapshot.snapshot,
          "-d",
          c.name,
        ]);
        const root = resolve(process.env.STORAGE_ROOT || ".data/private");
        const files: FileEntry[] = [];
        const references: DocumentEntry[] = [];
        for (const d of documents) {
          if (!/^[\w-]+$/.test(d.storageKey))
            throw new Error("INVALID_STORAGE_KEY");
          const bytes = await readFile(resolve(root, d.storageKey));
          const plain = decrypt(bytes.toString(), "FILE_KEY");
          if (plain.length !== d.bytes || hash(plain) !== d.hash)
            throw new Error("DOCUMENT_BACKUP_INTEGRITY");
          files.push({
            key: d.storageKey,
            data: bytes.toString("base64"),
            hash: hash(bytes),
          });
          references.push({
            id: d.id,
            key: d.storageKey,
            hash: d.hash,
            bytes: d.bytes,
          });
        }
        return {
          version: 2,
          createdAt: new Date().toISOString(),
          database: c.name,
          dump: dump.toString("base64"),
          dumpHash: hash(dump),
          files,
          documents: references,
          tables: await fingerprints(tx),
        };
      },
      { isolationLevel: "RepeatableRead", maxWait: 10000, timeout: 300000 },
    );
  } finally {
    try {
      if (snapshotLocked)
        await client.$executeRaw`SELECT pg_advisory_unlock_shared(${FILE_SNAPSHOT_LOCK})`;
    } finally {
      await client.$disconnect();
    }
  }
  const dir = resolve(".data/backups");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = resolve(
    dir,
    `legacy-${Date.now()}-${randomBytes(4).toString("hex")}.enc`,
  );
  await writeFile(path, encrypt(JSON.stringify(payload), "BACKUP_KEY"), {
    mode: 0o600,
    flag: "wx",
  });
  return {
    path,
    version: payload.version,
    files: payload.files.length,
    tables: Object.keys(payload.tables || {}).length,
    bytes: Buffer.from(payload.dump, "base64").length,
  };
}

export async function restoreDrill(path: string) {
  const payload = JSON.parse(
    decrypt(await readFile(path, "utf8"), "BACKUP_KEY").toString(),
  ) as BackupPayload;
  if (![1, 2].includes(payload.version)) throw new Error("BACKUP_VERSION");
  const dump = Buffer.from(payload.dump, "base64");
  if (hash(dump) !== payload.dumpHash) throw new Error("BACKUP_INTEGRITY");
  // Validate all file paths, hashes and (v2) document plaintext before creating anything.
  validateFiles(payload);
  const target = `legacy_restore_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const started = Date.now();
  await pg("createdb", [target]);
  await pg("pg_restore", ["--no-owner", "-d", target], target, dump);
  const root = resolve(".data", target);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const f of payload.files)
    await writeFile(resolve(root, f.key), Buffer.from(f.data, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
  const client = new PrismaClient({ datasourceUrl: connection(target).url });
  let verifiedTables = 0;
  try {
    if (payload.version === 2) {
      const restored = await client.$transaction((tx) => fingerprints(tx), {
        timeout: 300000,
      });
      if (!sameFingerprints(payload.tables!, restored))
        throw new Error("RESTORED_DATABASE_INTEGRITY");
      verifiedTables = Object.keys(restored).length;
      const references = await client.document.findMany({
        where: {
          deletedAt: null,
          state: { notIn: ["DELETED", "DELETION_PENDING"] },
        },
        select: { id: true, storageKey: true, hash: true, bytes: true },
        orderBy: { id: "asc" },
      });
      if (
        JSON.stringify(
          references.map((d) => ({
            id: d.id,
            key: d.storageKey,
            hash: d.hash,
            bytes: d.bytes,
          })),
        ) !== JSON.stringify(payload.documents)
      )
        throw new Error("RESTORED_DOCUMENT_MANIFEST_MISMATCH");
    }
    const counts = [
      await client.user.count(),
      await client.charge.count(),
      await client.receipt.count(),
      await client.auditEvent.count(),
    ].join("|");
    return {
      target,
      elapsedMs: Date.now() - started,
      files: payload.files.length,
      counts,
      version: payload.version,
      verifiedTables,
      verifiedDocuments: payload.version === 2 ? payload.documents!.length : 0,
    };
  } finally {
    await client.$disconnect();
  }
}
if (process.argv[1]?.endsWith("backup.ts")) {
  if (process.argv[2] === "--restore-drill")
    console.log(JSON.stringify(await restoreDrill(process.argv[3])));
  else console.log(JSON.stringify(await backup()));
}
