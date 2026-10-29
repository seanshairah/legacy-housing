import { lookup } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
// Preserve the platform-provided proxy route inside BuildKit; never bypass it.
const raw = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
await mkdir(".data", { recursive: true, mode: 0o700 });
let files = ["-f", "compose.yaml"];
if (raw) {
  const hostname = new URL(raw).hostname;
  const address = (await lookup(hostname, { family: 4 })).address;
  await writeFile(
    ".data/cloud-build.json",
    JSON.stringify({
      services: { web: { build: { extra_hosts: [`${hostname}:${address}`] } } },
    }),
    { mode: 0o600 },
  );
  files = [...files, "-f", ".data/cloud-build.json"];
}
const child = spawn("docker", ["compose", ...files, "build", "web"], {
  stdio: "inherit",
  env: {
    ...process.env,
    BUILDX_CONFIG: process.env.BUILDX_CONFIG || `${process.cwd()}/.data/buildx`,
  },
});
child.on("exit", (code) => process.exit(code || 0));
