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
    // The tests expect a fresh install: no AI, browser or payment keys from a developer's .env.
    env: { AI_GATEWAY_API_KEY: "", BROWSER_URL: "", BROWSER_TOKEN: "", CASHFREE_APP_ID: "", CASHFREE_SECRET_KEY: "", DODO_PAYMENTS_API_KEY: "", DODO_PRODUCT_ID: "", DODO_PAYMENTS_WEBHOOK_KEY: "" },
    timeout: 15000,
  },
  reporter: "list",
});
