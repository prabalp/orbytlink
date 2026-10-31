import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:3100",
    headless: true,
    viewport: { width: 1440, height: 1050 },
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: true,
    timeout: 15000,
  },
  reporter: "list",
});
