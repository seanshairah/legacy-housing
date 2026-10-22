import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encrypt, decrypt, hash } from "../src/lib/security";
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
      out: Buffer[] = [],
      err: Buffer[] = [];
    p.stdout.on("data", (b) => out.push(b));
    p.stderr.on("data", (b) => err.push(b));
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
    p.stdin.end(input);
  });
}
function connection(database?: string) {
  const u = new URL(process.env.DATABASE_URL!);
  const name = database || u.pathname.slice(1);
  if (!/^legacy_[a-z0-9_]+$/.test(name))
    throw new Error("DEDICATED_LEGACY_DATABASE_REQUIRED");
  return {
    name,
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
export async function backup() {
  const c = connection(),
    dump = await pg("pg_dump", ["-Fc", "--no-owner", "-d", c.name]);
  const root = resolve(process.env.STORAGE_ROOT || ".data/private"),
    files: { key: string; data: string; hash: string }[] = [];
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (!e.isFile() || !/^[\w-]+$/.test(e.name))
      throw new Error("UNEXPECTED_PRIVATE_STORAGE_ENTRY");
    const b = await readFile(resolve(root, e.name));
    files.push({ key: e.name, data: b.toString("base64"), hash: hash(b) });
  }
  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    database: c.name,
    dump: dump.toString("base64"),
    dumpHash: hash(dump),
    files,
  };
  const dir = resolve(".data/backups");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = resolve(dir, `legacy-${Date.now()}.enc`);
  await writeFile(path, encrypt(JSON.stringify(payload), "BACKUP_KEY"), {
    mode: 0o600,
    flag: "wx",
  });
  return { path, files: files.length, bytes: dump.length };
}
export async function restoreDrill(path: string) {
  const payload = JSON.parse(
    decrypt(await readFile(path, "utf8"), "BACKUP_KEY").toString(),
  ) as {
    version: number;
    dump: string;
    dumpHash: string;
    files: { key: string; data: string; hash: string }[];
  };
  if (payload.version !== 1) throw new Error("BACKUP_VERSION");
  const dump = Buffer.from(payload.dump, "base64");
  if (hash(dump) !== payload.dumpHash) throw new Error("BACKUP_INTEGRITY");
  const target = `legacy_restore_${Date.now()}`;
  const started = Date.now();
  await pg("createdb", [target]);
  await pg("pg_restore", ["--no-owner", "-d", target], target, dump);
  const root = resolve(".data", target);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const f of payload.files) {
    if (!/^[\w-]+$/.test(f.key)) throw new Error("INVALID_FILE_ENTRY");
    const b = Buffer.from(f.data, "base64");
    if (hash(b) !== f.hash) throw new Error("FILE_BACKUP_INTEGRITY");
    await writeFile(resolve(root, f.key), b, { mode: 0o600, flag: "wx" });
  }
  const counts = (
    await pg(
      "psql",
      [
        "-d",
        target,
        "-tAc",
        'SELECT (SELECT count(*) FROM "User"),(SELECT count(*) FROM "Charge"),(SELECT count(*) FROM "Receipt"),(SELECT count(*) FROM "AuditEvent");',
      ],
      target,
    )
  )
    .toString()
    .trim();
  return {
    target,
    elapsedMs: Date.now() - started,
    files: payload.files.length,
    counts,
  };
}
if (process.argv[1]?.endsWith("backup.ts")) {
  if (process.argv[2] === "--restore-drill")
    console.log(JSON.stringify(await restoreDrill(process.argv[3])));
  else console.log(JSON.stringify(await backup()));
}
