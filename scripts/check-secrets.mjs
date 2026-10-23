import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const names = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const patterns = [
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
let failures = 0;
for (const name of names) {
  if (/\.(png|jpg|pdf|docx|zip|ico|ttf)$/.test(name)) continue;
  const text = readFileSync(name, "utf8");
  if (patterns.some((p) => p.test(text))) {
    console.error(
      `Potential credential in ${name}; inspect locally without copying values to logs.`,
    );
    failures++;
  }
}
if (failures) process.exit(1);
console.log(
  `Credential pattern scan passed (${names.length} tracked files; limited built-in patterns).`,
);
