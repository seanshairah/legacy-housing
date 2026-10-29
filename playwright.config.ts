import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
import { defineConfig, devices } from "@playwright/test";
const full = process.env.LEGACY_FULL_E2E === "true";
if (full) {
  Object.assign(process.env, {
    LEGACY_E2E_BASE_URL: "https://localhost:3443",
    LEGACY_PROVIDER_FIXTURE: "true",
    RETENTION_EXECUTION_ENABLED: "true",
    PAYNOW_MODE: "live",
    PAYNOW_INTEGRATION_ID: "fixture-integration-id",
    PAYNOW_INTEGRATION_KEY: "fixture-integration-key",
    PAYNOW_CURRENCY: "USD",
    RESEND_API_KEY: "fixture-email-key",
    EMAIL_FROM: "training@example.invalid",
    SMSPOP_API_KEY: "fixture-sms-key",
    SMSPOP_SENDER_ID: "TEST",
  });
}
export default defineConfig({
  globalSetup: "./tests/browser/global-setup.ts",
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: process.env.LEGACY_E2E_BASE_URL || "http://localhost:3002",
    ignoreHTTPSErrors: full,
    ...devices["Desktop Chrome"],
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      process.env.LEGACY_E2E_PRODUCTION === "true"
        ? full
          ? "node --import ./tests/fixtures/provider-preload.mjs node_modules/next/dist/bin/next start --port 3002"
          : "npm run start -- --port 3002"
        : "npm run dev -- --port 3002",
    url: "http://localhost:3002/api/health",
    reuseExistingServer: false,
    env: {
      DATABASE_URL: process.env.DATABASE_URL!,
      APP_URL: process.env.LEGACY_E2E_BASE_URL || "http://localhost:3002",
    },
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
