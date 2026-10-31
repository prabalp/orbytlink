import { afterEach, describe, expect, it } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { Store } from "../server/store.js";
import { hostAllowed, isPublicAddress, safeEndpoint } from "../server/adapters.js";

describe("credential vault", () => {
  it("encrypts, redacts, and never stores plaintext", () => {
    const store = new Store(":memory:");
    const secret = "secret-token-012345";
    store.secret("alpha", "c", secret);
    expect(store.secret("alpha", "c")).toBe(secret);
    const raw = store.db
      .prepare("SELECT value FROM secrets WHERE workspace=?")
      .get("alpha") as any;
    expect(raw.value).not.toContain(secret);
    expect(raw.value.startsWith("v2:")).toBe(true);
    expect(
      JSON.stringify(store.redact("alpha", { nested: { output: `Header Bearer ${secret}`, token: "x" } })),
    ).not.toContain(secret);
    expect(store.secret("beta", "c")).toBeUndefined();
  });
  it("refuses a ciphertext moved to another workspace or connection", () => {
    const store = new Store(":memory:");
    store.secret("alpha", "c", "alpha-only-secret");
    const { value } = store.db
      .prepare("SELECT value FROM secrets WHERE workspace='alpha' AND id='c'")
      .get() as any;
    store.db.prepare("INSERT INTO secrets VALUES('beta','c',?)").run(value);
    store.db.prepare("INSERT INTO secrets VALUES('alpha','d',?)").run(value);
    expect(() => store.secret("beta", "c")).toThrow();
    expect(() => store.secret("alpha", "d")).toThrow();
  });
  it("reads and upgrades entries written before authenticated data was bound", () => {
    const store = new Store(":memory:");
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", store.key, iv);
    const enc = Buffer.concat([c.update("legacy-secret", "utf8"), c.final()]);
    store.db
      .prepare("INSERT INTO secrets VALUES('w','c',?)")
      .run(`${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${enc.toString("hex")}`);
    expect(store.secret("w", "c")).toBe("legacy-secret");
    const { value } = store.db.prepare("SELECT value FROM secrets WHERE id='c'").get() as any;
    expect(value.startsWith("v2:")).toBe(true);
    expect(store.secret("w", "c")).toBe("legacy-secret");
  });
  it("destroys a connection's credential with the connection", () => {
    const store = new Store(":memory:");
    store.put("w", "connections", { id: "c", name: "x" });
    store.secret("w", "c", "gone");
    store.remove("w", "connections", "c");
    expect(store.secret("w", "c")).toBeUndefined();
  });
  it("isolates all workspace reads and writes", () => {
    const store = new Store(":memory:");
    const row = store.put("alpha", "connections", { name: "Private" });
    expect(() => store.get("beta", "connections", row.id)).toThrow("Record not found");
    expect(() => store.remove("beta", "connections", row.id)).toThrow();
  });
});

describe("outbound destinations", () => {
  afterEach(() => {
    delete process.env.OUTBOUND_HOSTS;
  });
  it("allows only global unicast addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["93.184.216.34", "198.41.128.1", "199.36.158.100", "2606:4700::6810:84e5"])
      expect(isPublicAddress(ip), ip).toBe(true);
  });
  it("matches exact, wildcard-subdomain, and any-host allowlist rules", () => {
    expect(hostAllowed("api.example.com", "api.example.com")).toBe(true);
    expect(hostAllowed("evil.com", "api.example.com")).toBe(false);
    expect(hostAllowed("mcp.example.com", "*.example.com")).toBe(true);
    expect(hostAllowed("example.com", "*.example.com")).toBe(false);
    expect(hostAllowed("notexample.com", "*.example.com")).toBe(false);
    expect(hostAllowed("anything.dev", "*")).toBe(true);
    expect(hostAllowed("anything.dev", "")).toBe(false);
  });
  it("rejects unallowlisted hosts, URL credentials, queries, and private IP literals", async () => {
    process.env.OUTBOUND_HOSTS = "*";
    await expect(safeEndpoint("http://example.com/mcp")).rejects.toThrow();
    await expect(safeEndpoint("https://user:secret@example.com/mcp")).rejects.toThrow();
    await expect(safeEndpoint("https://example.com/mcp?key=secret")).rejects.toThrow();
    await expect(safeEndpoint("https://127.0.0.1/mcp")).rejects.toThrow("Private");
    await expect(safeEndpoint("https://[::1]/mcp")).rejects.toThrow("Private");
    process.env.OUTBOUND_HOSTS = "";
    await expect(safeEndpoint("https://example.com/mcp")).rejects.toThrow("OUTBOUND_HOSTS");
  });
});
