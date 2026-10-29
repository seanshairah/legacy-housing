import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as httpsServer } from "node:https";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { assertTestDatabase } from "../safety";
export default async function setup() {
  if (process.env.LEGACY_FULL_E2E !== "true") return;
  assertTestDatabase();
  const payments = new Map<string, Record<string, string>>(),
    messages: Record<string, string>[] = [];
  const delivered = new Set<string>();
  const key = process.env.PAYNOW_INTEGRATION_KEY || "fixture-integration-key";
  const sign = (fields: Record<string, string>) => ({
    ...fields,
    hash: createHash("sha512")
      .update(Object.values(fields).join("") + key.toLowerCase())
      .digest("hex")
      .toUpperCase(),
  });
  const transport = httpServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) text += chunk;
      const data = text ? JSON.parse(text) : {};
      if (req.url === "/messages") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(messages));
        return;
      }
      if (req.url === "/control") {
        const p = payments.get(data.reference);
        if (!p) throw Error("UNKNOWN_FIXTURE_PAYMENT");
        Object.assign(p, data);
        res.end(
          JSON.stringify(
            sign({
              reference: p.reference,
              amount: p.amount,
              paynowreference: p.paynowreference,
              status: p.status,
            }),
          ),
        );
        return;
      }
      if (req.url !== "/transport") throw Error("UNKNOWN_FIXTURE_ROUTE");
      const u = new URL(data.url);
      if (u.hostname === "www.paynow.co.zw") {
        const fields = Object.fromEntries(new URLSearchParams(data.body));
        if (u.pathname.includes("initiatetransaction")) {
          const { hash: provided, ...unsigned } = fields;
          if (sign(unsigned).hash !== provided)
            throw Error("INVALID_REQUEST_SIGNATURE");
          const p = {
            reference: fields.reference,
            amount: fields.amount,
            paynowreference: `fixture-${fields.reference}`,
            status: "pending",
          };
          payments.set(p.reference, p);
          res.end(
            new URLSearchParams(
              sign({
                status: "Ok",
                pollurl: `https://www.paynow.co.zw/interface/poll?reference=${p.reference}`,
                browserurl: `https://www.paynow.co.zw/Payment/Confirm?reference=${p.reference}`,
                paynowreference: p.paynowreference,
              }),
            ).toString(),
          );
        } else {
          const p = payments.get(u.searchParams.get("reference") || "");
          if (!p) throw Error("UNKNOWN_POLL_REFERENCE");
          if (p.outage === "true") {
            res.writeHead(503);
            res.end("fixture outage");
            return;
          }
          res.end(
            new URLSearchParams(
              sign({
                reference: p.reference,
                amount: p.amount,
                paynowreference: p.paynowreference,
                status: p.status,
              }),
            ).toString(),
          );
        }
      } else {
        const b = JSON.parse(data.body),
          id = data.headers["idempotency-key"] || "";
        if (!id) throw Error("IDEMPOTENCY_HEADER_REQUIRED");
        if (!delivered.has(`${u.hostname}:${id}`)) {
          delivered.add(`${u.hostname}:${id}`);
          messages.push({
            id,
            channel: u.hostname === "api.resend.com" ? "email" : "sms",
            recipient: b.to || b.recipients?.[0],
            text: b.text || b.message,
          });
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id, accepted: true }));
      }
    } catch {
      res.writeHead(400);
      res.end("FIXTURE_REQUEST_REJECTED");
    }
  });
  transport.listen(3410, "127.0.0.1");
  await once(transport, "listening");
  mkdirSync(".data/test-tls", { recursive: true, mode: 0o700 });
  const cert = ".data/test-tls/cert.pem",
    privateKey = ".data/test-tls/key.pem";
  if (!existsSync(cert) || !existsSync(privateKey))
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        privateKey,
        "-out",
        cert,
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
  const proxy = httpsServer(
    { key: readFileSync(privateKey), cert: readFileSync(cert) },
    (req, res) => {
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: 3002,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, "x-forwarded-proto": "https" },
        },
        (out) => {
          res.writeHead(out.statusCode || 502, out.headers);
          out.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.writeHead(502);
        res.end("UPSTREAM_UNAVAILABLE");
      });
      req.pipe(upstream);
    },
  );
  proxy.listen(3443, "127.0.0.1");
  await once(proxy, "listening");
  const worker = spawn(
    process.execPath,
    [
      "--import",
      "./tests/fixtures/provider-preload.mjs",
      "--import",
      "tsx",
      "scripts/worker.ts",
    ],
    {
      env: {
        ...process.env,
        LEGACY_PROVIDER_FIXTURE: "true",
        APP_URL: "https://localhost:3443",
      },
      stdio: "ignore",
    },
  );
  return async () => {
    worker.kill("SIGTERM");
    await Promise.race([
      once(worker, "exit"),
      new Promise((r) => setTimeout(r, 6000)),
    ]);
    if (worker.exitCode === null) worker.kill("SIGKILL");
    proxy.closeAllConnections();
    await new Promise<void>((r) => proxy.close(() => r()));
    transport.closeAllConnections();
    await new Promise<void>((r) => transport.close(() => r()));
  };
}
