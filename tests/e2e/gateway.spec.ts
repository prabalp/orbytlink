import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.locator("#name").fill("prabalp");
  await page.locator("#email").fill(`prabalp-${Date.now()}@example.invalid`);
  await page.locator("#password").fill("Correct-horse-ship-2026");
  await page.locator("#confirm_password").fill("Correct-horse-ship-2026");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
});
test("navigates the gateway and issues a token for Claude", async ({ page }) => {
  for (const name of ["Connect agents", "Activity", "Settings", "Connections"]) {
    await page.locator(".sidebar nav").getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { name: name === "Connect agents" ? "Connect any agent" : name, level: 1 })).toBeVisible();
  }
  await page.locator(".sidebar nav").getByRole("link", { name: "Connect agents" }).click();
  await page.getByRole("button", { name: "Create token" }).first().click();
  await page.getByLabel("Token name").fill("Playwright");
  await expect(page.getByLabel("App tools")).toHaveValue("auto");
  await page.locator(".modal").getByRole("button", { name: "Create token" }).click();
  await expect(page.locator("textarea.token")).toHaveValue(/^ol_/);
  await page.locator(".modal").getByRole("button", { name: "Done" }).click();
  // Each token picks how its agent sees app tools.
  const mode = page.getByLabel("App tools for Playwright");
  await mode.selectOption("search");
  await expect(page.getByText("The agent now finds tools before calling them.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("App tools for Playwright")).toHaveValue("search");
});
test("opens sign-up with the email from the landing page's early-access link", async ({ browser, baseURL }) => {
  const visitor = await (await browser.newContext({ baseURL })).newPage();
  await visitor.goto("/#signup=ada%40example.invalid");
  await expect(visitor.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(visitor.locator("#email")).toHaveValue("ada@example.invalid");
  expect(new URL(visitor.url()).hash).toBe("");
});
test("creates an organization, invites a teammate by link, and promotes them to admin", async ({ page, browser, baseURL }) => {
  await page.locator(".sidebar nav").getByRole("link", { name: "Team" }).click();
  await page.getByRole("button", { name: "Create organization" }).first().click();
  await page.getByLabel("Organization name").fill("Acme Corp");
  await page.locator(".modal").getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByText("Members of Acme Corp")).toBeVisible();

  await page.getByRole("button", { name: "Invite member" }).click();
  await page.locator(".modal").getByRole("button", { name: "Create invite link" }).click();
  const link = await page.locator(".code-line").innerText();
  expect(link).toMatch(/#invite=oi_/);
  await page.locator(".modal").getByRole("button", { name: "Done" }).click();

  const guest = await browser.newContext({ baseURL });
  const bob = await guest.newPage();
  await bob.goto("/");
  await bob.getByRole("button", { name: "Sign up", exact: true }).click();
  await bob.locator("#name").fill("Bobby");
  await bob.locator("#email").fill(`bobby-${Date.now()}@example.invalid`);
  await bob.locator("#password").fill("Correct-horse-ship-2026");
  await bob.locator("#confirm_password").fill("Correct-horse-ship-2026");
  await bob.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(bob.getByRole("heading", { name: "Connections" })).toBeVisible();
  await bob.goto(link.trim());
  await bob.reload();
  await expect(bob.getByRole("dialog", { name: "Join organization" })).toBeVisible();
  await bob.getByRole("button", { name: "Join organization" }).click();
  await expect(bob.getByText("Members of Acme Corp")).toBeVisible();
  // Members cannot add connections.
  await bob.locator(".sidebar nav").getByRole("link", { name: "Connections" }).click();
  await expect(bob.getByRole("button", { name: "Add connection" })).toHaveCount(0);

  await expect(page.getByText("Bobby", { exact: true })).toBeVisible({ timeout: 8000 });
  await page.getByRole("row", { name: /Bobby/ }).getByRole("button", { name: "Make admin" }).click();
  await expect(page.getByRole("row", { name: /Bobby/ }).getByText("admin", { exact: true })).toBeVisible();
  await expect(bob.getByRole("button", { name: "Add connection" }).first()).toBeVisible({ timeout: 8000 });
  await guest.close();
});
test("browses the catalog by segment and opens a ready-made connection", async ({ page }) => {
  await page.locator(".sidebar nav").getByRole("link", { name: "Catalog" }).click();
  await expect(page.getByRole("heading", { name: "Catalog", level: 1 })).toBeVisible();
  for (const segment of ["Documents & Files", "Communication", "Project Management"])
    await expect(page.getByRole("region", { name: segment })).toBeVisible();

  await page.getByRole("radio", { name: "Communication" }).click();
  await expect(page.getByRole("region", { name: "Documents & Files" })).toHaveCount(0);
  await page.getByRole("radio", { name: "All" }).click();

  // A token-based app opens with its endpoint and bearer auth filled in.
  await page.getByPlaceholder("Search apps…").fill("github");
  await page.getByRole("button", { name: "Connect GitHub" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect GitHub" });
  await expect(dialog.locator('input[name="endpoint"]')).toHaveValue("https://api.githubcopilot.com/mcp/");
  await expect(dialog.locator("label.field", { hasText: /^Authentication/ }).locator("select")).toHaveValue("bearer");
  await dialog.getByRole("button", { name: "Close dialog" }).click();

  // An OAuth app shows the sign-in setup, including the redirect URI to register.
  await page.getByPlaceholder("Search apps…").fill("slack");
  await page.getByRole("button", { name: "Connect Slack" }).click();
  const slack = page.getByRole("dialog", { name: "Connect Slack" });
  await expect(slack.locator("label.field", { hasText: /^Authentication/ }).locator("select")).toHaveValue("oauth");
  await expect(slack.getByLabel("Authorization URL")).toHaveValue("https://slack.com/oauth/v2_user/authorize");
  await expect(slack.locator(".code-line")).toContainText("/api/oauth/callback");
  // Saving without a client ID is refused by the form.
  await slack.getByRole("button", { name: "Save connection" }).click();
  await expect(slack).toBeVisible();
});
test("generates a token in one click and fills it into the chosen agent's steps", async ({ page }) => {
  await page.locator(".sidebar nav").getByRole("link", { name: "Connect agents" }).click();
  await page.getByRole("radio", { name: /Cursor/ }).click();
  await page.getByRole("button", { name: "Generate a token for Cursor" }).click();
  await expect(page.locator(".token-pill code")).toHaveText(/^ol_.{4}•+.{4}$/);
  await expect(page.locator(".hero-token small")).toContainText("Cursor ·");
  await expect(page.locator(".snippet pre").first()).toContainText("Bearer ol_");
  await expect(page.getByRole("row", { name: /Cursor ·/ })).toBeVisible();
});
test("turns a skill on, reads it, and sees workflow templates", async ({ page }) => {
  await page.locator(".sidebar nav").getByRole("link", { name: "Skills" }).click();
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  const toggle = page.getByRole("switch", { name: "Use Test-driven development" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Test-driven development", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Test-driven development" });
  await expect(dialog.getByRole("link", { name: /mattpocock\/skills/ })).toBeVisible();
  await expect(dialog.locator(".markdown")).toContainText("red → green");
  await dialog.getByRole("button", { name: "Close dialog" }).click();

  await page.locator(".sidebar nav").getByRole("link", { name: "Workflows" }).click();
  await expect(page.getByRole("button", { name: "Use template: File an issue and announce it" })).toBeVisible();
  await expect(page.getByText("Needs Linear and Slack")).toBeVisible();
  await page.getByRole("button", { name: "New workflow" }).click();
  await expect(page.getByRole("dialog", { name: "New workflow" }).getByText("No tools are available yet")).toBeVisible();
});
test("adds an API with pasted docs and a key that is never shown again", async ({ page }) => {
  await page.locator(".sidebar nav").getByRole("link", { name: "APIs" }).click();
  await page.getByRole("button", { name: "Add API" }).first().click();
  await page.locator('input[name="name"]').fill("Billing");
  await page.getByPlaceholder("https://api.example.com/v1").fill("https://api.billing.example/v1");
  await page.getByRole("radio", { name: "Paste docs" }).click();
  await page.locator('textarea[name="docsText"]').fill(JSON.stringify({ openapi: "3.1.0", paths: { "/invoices": { get: { summary: "List invoices" } } } }));
  await page.locator('input[name="key"]').fill("sk_test_e2e_secret_value_7781");
  await page.getByRole("button", { name: "Add API", exact: true }).last().click();
  const detail = page.getByRole("dialog", { name: "Billing" });
  await expect(detail.locator(".endpoint", { hasText: "/invoices" })).toBeVisible();
  await expect(detail.getByText("••••7781")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("sk_test_e2e_secret_value_7781");
});
