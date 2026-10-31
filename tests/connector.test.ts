import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
import { adapters, inputProblem, inputValidator } from "../server/adapters.js";
import { Store } from "../server/store.js";
import { connectionSchema } from "../server/schema.js";
const base = {
  id: "c",
  name: "CRM",
  endpoint: "https://api.example.com/v1",
  auth: "api-key",
  authHeader: "X-Token",
  headers: { "X-Tenant": "acme" },
  enabled: true,
  tools: [],
};
let calls: { url: string; init: RequestInit }[];
beforeEach(() => {
  process.env.OUTBOUND_HOSTS = "api.example.com";
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      const accept = new Headers(init.headers).get("accept") || "";
      // Not an MCP server: refuse MCP handshakes, answer plain HTTP.
      if (accept.includes("text/event-stream"))
        return new Response("", { status: 405 });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
describe("universal connector", () => {
  it("validates operations and keeps credentials out of plain headers", () => {
    expect(() =>
      connectionSchema.parse({
        name: "x1",
        headers: { Authorization: "Bearer leak" },
      }),
    ).toThrow();
    expect(() =>
      connectionSchema.parse({
        name: "x1",
        operations: [{ name: "up", method: "GET", path: "/../admin" }],
      }),
    ).toThrow();
    expect(() =>
      connectionSchema.parse({
        name: "x1",
        operations: [{ name: "q", method: "GET", path: "/a?b=1" }],
      }),
    ).toThrow();
  });
  it("detects an HTTP API when the endpoint does not speak MCP", async () => {
    const result = await adapters.test(
      {
        ...base,
        kind: "auto",
        operations: [
          { name: "find_contacts", method: "GET", path: "/contacts" },
        ],
      },
      "secret-token",
    );
    expect(result.protocol).toBe("api");
    expect(result.tools.map((t) => t.name)).toEqual(["GET", "find_contacts"]);
    const probe = calls.at(-1)!;
    expect(new Headers(probe.init.headers).get("X-Token")).toBe(
      "secret-token",
    );
    expect(new Headers(probe.init.headers).get("X-Tenant")).toBe("acme");
  });
  it("calls declared operations with path inputs, query, and JSON bodies", async () => {
    const c = {
      ...base,
      kind: "api",
      protocol: "api",
      auth: "basic",
      operations: [
        { name: "get_contact", method: "GET", path: "/contacts/{id}" },
        { name: "create_contact", method: "POST", path: "/contacts" },
      ],
    };
    expect(
      await adapters.call(c, "get_contact", { id: "a b", fields: "email" }, "u:p"),
    ).toEqual({ ok: true });
    expect(calls[0].url).toBe(
      "https://api.example.com/v1/contacts/a%20b?fields=email",
    );
    expect(new Headers(calls[0].init.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("u:p").toString("base64")}`,
    );
    await adapters.call(c, "create_contact", { email: "a@b.invalid" }, "u:p");
    expect(calls[1].init.method).toBe("POST");
    expect(calls[1].init.body).toBe(JSON.stringify({ email: "a@b.invalid" }));
    await expect(adapters.call(c, "undeclared", {}, "u:p")).rejects.toThrow();
  });
});
describe("legacy connection migration", () => {
  it("drops untouched placeholders and keeps configured legacy servers as MCP", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbytlink-"));
    try {
      const old = new Store(dir);
      for (const [id, name, kind] of [
        ["lead-orbit", "Lead Orbit", "lead-orbit"],
        ["universal", "Universal connector", "auto"],
      ])
        old.put("w", "connections", {
          id,
          name,
          kind,
          endpoint: "",
          auth: "none",
          enabled: true,
          status: "Not configured",
          tools: [],
        });
      old.put("w", "connections", {
        id: "configured",
        name: "My server",
        kind: "mail-orbit",
        endpoint: "https://mail.example.com/mcp",
        auth: "none",
        enabled: true,
        status: "Connected",
        tools: [{ name: "t" }],
      });
      old.db.close();
      const store = new Store(dir);
      expect(store.list("w", "connections").map((c) => c.id)).toEqual(["configured"]);
      const c = store.get("w", "connections", "configured");
      expect(c.kind).toBe("mcp");
      expect(c.disabledTools).toEqual([]);
      store.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tool input validation", () => {
  // Shaped like Mail Orbyt's tools: zod 4 / the MCP SDK emit draft 2020-12 schemas.
  const modern = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      pageSize: { type: "integer", exclusiveMinimum: 0, maximum: 200 },
      status: { type: "string", enum: ["ACTIVE", "ARCHIVED"] },
      ids: { type: "array", prefixItems: [{ type: "string" }] },
    },
    additionalProperties: false,
  };
  it("checks draft 2020-12 schemas instead of failing every call", () => {
    const check = inputValidator(modern);
    expect(check({})).toBe(true);
    expect(check({ pageSize: 50, status: "ACTIVE" })).toBe(true);
    expect(check({ pageSize: 0 })).toBe(false);
    expect(check({ status: "DELETED" })).toBe(false);
    expect(check({ unknown: 1 })).toBe(false);
  });
  it("names the wrong input so the agent can fix its call", () => {
    expect(inputProblem(modern, { pageSize: 10 })).toBeNull();
    expect(inputProblem(modern, { status: "DELETED" })).toBe("status must be equal to one of the allowed values (ACTIVE, ARCHIVED)");
    expect(inputProblem(modern, { pageSize: 500 })).toBe("pageSize must be <= 200");
    expect(inputProblem(modern, { secretish: 1 })).toBe("input must NOT have additional properties (secretish)");
  });
  it("checks 2019-09, draft-07, older and undeclared drafts", () => {
    const body = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    for (const $schema of ["https://json-schema.org/draft/2019-09/schema", "http://json-schema.org/draft-07/schema#", "http://json-schema.org/draft-04/schema#", undefined]) {
      const check = inputValidator({ ...body, ...($schema ? { $schema } : {}) });
      expect(check({ q: "acme" })).toBe(true);
      expect(check({})).toBe(false);
    }
  });
  it("leaves a schema it cannot compile to the upstream server", () => {
    const check = inputValidator({ type: "object", properties: { a: { $ref: "#/missing" } } });
    expect(check({ a: 1 })).toBe(true);
    expect(inputValidator(undefined)({ any: "thing" })).toBe(true);
  });
});
