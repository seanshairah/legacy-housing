import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://localhost:3002",
    ...devices["Desktop Chrome"],
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 3002",
    url: "http://localhost:3002/api/health",
    reuseExistingServer: false,
    env: {
      DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/legacy_test",
      APP_URL: "http://localhost:3002",
    },
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
