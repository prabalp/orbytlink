import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { quote } from "../server/payments";
import type { ServiceAdapters } from "../server/adapters";
import { inject } from "./inject";
import { Webhook } from "standardwebhooks";

const SECRET = "cf_secret_test_123456";
let app: Express, store: Store, cookie: string;
// What Cashfree "knows": created orders, and the status each one is in.
// What Dodo "knows": checkout sessions (by session id) and payments (by payment id).
let sessions: Map<string, any>, dodoPayments: Map<string, any>;
const DODO_SECRET = `whsec_${Buffer.from("dodo-webhook-secret-for-tests-32b").toString("base64")}`;
let orders: Map<string, any>, calls: { method: string; url: string; headers: Headers; body: any }[], down: boolean;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET") => inject(app, { url, method, headers: { Cookie: cookie }, body });
const balance = async () => (await api("/api/ai")).data.balance as number;
// A webhook the way Cashfree sends it: signed over timestamp + raw body.
async function webhook(orderId: string, sign = true) {
  const body = { type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: orderId } } };
  const ts = String(Date.now());
  const signature = createHmac("sha256", SECRET).update(ts + JSON.stringify(body)).digest("base64");
  return inject(app, { url: "/api/payments/webhook", method: "POST", headers: { "x-webhook-timestamp": ts, "x-webhook-signature": sign ? signature : "AAAA" }, body });
}
const buy = async (bundle = 25, currency = "USD") => (await api("/api/payments/orders", { bundle, currency })).data;
const pay = (orderId: string, patch: Record<string, unknown> = {}) => orders.set(orderId, { ...orders.get(orderId), order_status: "PAID", ...patch });

beforeEach(async () => {
  process.env.CASHFREE_APP_ID = "app_test_id";
  process.env.CASHFREE_SECRET_KEY = SECRET;
  process.env.PAYMENT_FEE_PERCENT = "5";
  process.env.PAYMENT_FEE_FIXED_USD = "0.5";
  process.env.USD_INR_RATE = "90";
  process.env.GST_PERCENT_INR = "18";
  orders = new Map();
  sessions = new Map();
  dodoPayments = new Map();
  calls = [];
  down = false;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method || "GET", url, headers: new Headers(init.headers), body });
    if (down) return Response.json({ message: "boom" }, { status: 500 });
    if (url.startsWith("https://test.dodopayments.com/")) {
      const path = url.slice("https://test.dodopayments.com".length);
      if (init.method === "POST" && path === "/checkouts") {
        const id = `cks_${sessions.size + 1}`;
        sessions.set(id, { id, body, payment_status: null });
        return Response.json({ session_id: id, checkout_url: `https://test.checkout.dodopayments.com/session/${id}` });
      }
      const [, kind, id] = path.split("/");
      const found = (kind === "checkouts" ? sessions : dodoPayments).get(decodeURIComponent(id));
      return found ? Response.json(found) : Response.json({ message: "not found" }, { status: 404 });
    }
    if (init.method === "POST" && url.endsWith("/pg/orders")) {
      orders.set(body.order_id, { order_id: body.order_id, order_amount: body.order_amount, order_currency: body.order_currency, order_status: "ACTIVE" });
      return Response.json({ ...orders.get(body.order_id), payment_session_id: `session_${body.order_id}` });
    }
    const id = decodeURIComponent(url.split("/pg/orders/")[1] || "");
    return orders.has(id) ? Response.json(orders.get(id)) : Response.json({ message: "order not found" }, { status: 404 });
  }));
  store = new Store(":memory:");
  app = createApp(store, { test: vi.fn(), call: vi.fn() } as ServiceAdapters).app;
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Alice", email: "alice@example.invalid", password: "Correct-horse-ship-2026" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["DODO_PAYMENTS_API_KEY", "DODO_PRODUCT_ID", "DODO_PAYMENTS_WEBHOOK_KEY", "DODO_PAYMENTS_ENVIRONMENT", "DODO_FEE_PERCENT", "DODO_FEE_FIXED_USD", "CASHFREE_APP_ID", "CASHFREE_SECRET_KEY", "CASHFREE_ENV", "PAYMENT_FEE_PERCENT", "PAYMENT_FEE_FIXED_USD", "USD_INR_RATE", "GST_PERCENT_INR"]) delete process.env[k];
});

it("prices a bundle as credit + processing fee, then GST on top for rupees", () => {
  // (25 + 0.5) / 0.95 = 26.842, rounded up to the cent; the fee is what is left after the credit.
  expect(quote(25, "USD")).toEqual({ currency: "USD", credit: 25, fee: 1.85, tax: 0, total: 26.85 });
  // ₹ price before tax is whole rupees: 26.842 * 90 = 2415.8 -> 2416; GST 18% = 434.88.
  expect(quote(25, "INR")).toMatchObject({ currency: "INR", credit: 25, tax: 434.88, total: 2850.88 });
  // After Cashfree's cut (5% + 0.5) the dollar price leaves the whole credit.
  expect(26.85 - (26.85 * 0.05 + 0.5)).toBeGreaterThanOrEqual(25);
});

it("opens a Cashfree order with the right amount, return and notify URLs, and no card data", async () => {
  const o = await buy(25, "USD");
  expect(o).toMatchObject({ paymentSessionId: `session_${o.orderId}`, mode: "sandbox", quote: { total: 26.85 } });
  const sent = calls[0];
  expect(sent.url).toBe("https://sandbox.cashfree.com/pg/orders");
  expect(sent.headers.get("x-client-id")).toBe("app_test_id");
  expect(sent.headers.get("x-client-secret")).toBe(SECRET);
  expect(sent.body).toMatchObject({ order_id: o.orderId, order_amount: 26.85, order_currency: "USD", order_meta: { notify_url: "http://127.0.0.1:3100/api/payments/webhook", return_url: expect.stringContaining("pay_order={order_id}") } });
  expect(JSON.stringify(sent.body)).not.toMatch(/card/i);
  expect((await api("/api/payments")).data.history[0]).toMatchObject({ orderId: o.orderId, status: "created", creditUsd: 25 });
  // Unknown amounts and currencies are refused before Cashfree is called.
  expect((await api("/api/payments/orders", { bundle: 7, currency: "USD" })).status).toBe(400);
  expect((await api("/api/payments/orders", { bundle: 25, currency: "EUR" })).status).toBe(400);
  expect(calls).toHaveLength(1);
});

it("adds the credit once when the signed webhook arrives, however many times it is repeated", async () => {
  const o = await buy(25, "USD");
  expect(await balance()).toBe(0);
  pay(o.orderId);
  expect((await webhook(o.orderId)).status).toBe(200);
  expect(await balance()).toBe(25_000_000);
  expect((await webhook(o.orderId)).status).toBe(200);
  expect((await api(`/api/payments/orders/${o.orderId}/check`, {})).data.payment.status).toBe("paid");
  expect(await balance()).toBe(25_000_000);
  expect((await api("/api/payments")).data.history[0]).toMatchObject({ status: "paid", creditUsd: 25 });
  // It shows in the credit ledger too.
  expect((await api("/api/ai")).data.ledger[0]).toMatchObject({ type: "credit", micro: 25_000_000, by: "cashfree" });
});

it("ignores a webhook with a bad signature, and one for an order that is not paid", async () => {
  const o = await buy(10, "USD");
  pay(o.orderId);
  expect((await webhook(o.orderId, false)).status).toBe(401);
  expect(await balance()).toBe(0);
  const unpaid = await buy(10, "USD"); // Cashfree still says ACTIVE
  await webhook(unpaid.orderId);
  expect(await balance()).toBe(0);
  expect((await webhook("olp_000000000000000000000000")).status).toBe(200); // unknown order: nothing happens
});

it("does not trust the webhook's word: the amount Cashfree reports must match", async () => {
  const o = await buy(25, "USD");
  pay(o.orderId, { order_amount: 1 });
  await webhook(o.orderId);
  expect(await balance()).toBe(0);
  expect((await api("/api/payments")).data.history[0].status).toBe("mismatch");
});

it("credits when the person returns from Cashfree before the webhook, and never twice", async () => {
  const o = await buy(50, "INR");
  const first = (await api(`/api/payments/orders/${o.orderId}/check`, {})).data;
  expect(first.payment.status).toBe("created");
  pay(o.orderId);
  const done = (await api(`/api/payments/orders/${o.orderId}/check`, {})).data;
  expect(done).toMatchObject({ payment: { status: "paid", currency: "INR" }, balance: 50_000_000 });
  await webhook(o.orderId);
  expect(await balance()).toBe(50_000_000);
});

it("keeps one workspace's orders private, and records a failure without crediting", async () => {
  const o = await buy(10, "USD");
  const other = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Mallory", email: "mallory@example.invalid", password: "Correct-horse-ship-2026" } });
  const theirs = String(other.headers["set-cookie"]).split(";")[0];
  pay(o.orderId);
  expect((await inject(app, { url: `/api/payments/orders/${o.orderId}/check`, method: "POST", headers: { Cookie: theirs }, body: {} })).status).toBe(404);
  expect((await inject(app, { url: "/api/payments", headers: { Cookie: theirs } })).data.history).toEqual([]);
  down = true;
  expect((await api("/api/payments/orders", { bundle: 10, currency: "USD" })).status).toBe(502);
  expect((await api("/api/payments")).data.history.some((h: any) => h.status === "failed")).toBe(true);
});

it("is off, and the webhook does not exist, until Cashfree is configured", async () => {
  delete process.env.CASHFREE_APP_ID;
  expect((await api("/api/payments")).data.enabled).toBe(false);
  expect((await api("/api/payments/orders", { bundle: 10, currency: "USD" })).status).toBe(409);
  expect((await webhook("olp_000000000000000000000000")).status).toBe(404);
});

// ── Dodo Payments for dollars ────────────────────────────────────────────────
function useDodo() {
  process.env.DODO_PAYMENTS_API_KEY = "dodo_test_key";
  process.env.DODO_PRODUCT_ID = "pdt_credit";
  process.env.DODO_PAYMENTS_WEBHOOK_KEY = DODO_SECRET;
}
// Dodo "takes" the payment for a session: the session gets a payment, the payment carries our metadata.
function dodoPay(sessionId: string, patch: Record<string, unknown> = {}) {
  const s = sessions.get(sessionId);
  const paymentId = `pay_${sessionId}`;
  s.payment_status = "succeeded";
  s.payment_id = paymentId;
  dodoPayments.set(paymentId, { payment_id: paymentId, status: "succeeded", currency: "USD", total_amount: s.body.product_cart[0].amount + 200, metadata: s.body.metadata, ...patch });
}
function dodoWebhook(orderId: string, secret = DODO_SECRET) {
  const raw = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_x", metadata: { order_id: orderId } } });
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const now = new Date();
  const signature = new Webhook(secret).sign(id, now, raw);
  return inject(app, { url: "/api/payments/dodo/webhook", method: "POST", headers: { "webhook-id": id, "webhook-timestamp": String(Math.floor(now.getTime() / 1000)), "webhook-signature": signature, "Content-Type": "application/json" }, body: JSON.parse(raw) });
}

it("sends dollar orders to Dodo and rupee orders to Cashfree", async () => {
  useDodo();
  const info = (await api("/api/payments")).data;
  expect(info).toMatchObject({ currencies: ["INR", "USD"], providers: { INR: "cashfree", USD: "dodo" } });
  // Dodo's cut by default: 5.5% + $0.40, and tax is added on Dodo's page.
  expect(quote(25, "USD")).toEqual({ currency: "USD", credit: 25, fee: 1.88, tax: 0, total: 26.88, taxAtCheckout: true });
  const usd = await buy(25, "USD");
  expect(usd).toMatchObject({ provider: "dodo", checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_1", mode: "test_mode" });
  const sent = calls.find((c) => c.url === "https://test.dodopayments.com/checkouts")!;
  expect(sent.headers.get("authorization")).toBe("Bearer dodo_test_key");
  expect(sent.body).toMatchObject({ product_cart: [{ product_id: "pdt_credit", quantity: 1, amount: 2688 }], metadata: { order_id: usd.orderId }, return_url: `http://127.0.0.1:3100/?pay_order=${usd.orderId}#settings` });
  const inr = await buy(25, "INR");
  expect(inr).toMatchObject({ provider: "cashfree", paymentSessionId: `session_${inr.orderId}` });
  expect(calls.filter((c) => c.url.includes("cashfree"))).toHaveLength(1);
});

it("credits a Dodo order once, from the signed webhook or the return page", async () => {
  useDodo();
  const o = await buy(25, "USD");
  expect((await dodoWebhook(o.orderId)).status).toBe(200); // not paid yet: nothing happens
  expect(await balance()).toBe(0);
  dodoPay("cks_1");
  expect((await dodoWebhook(o.orderId)).status).toBe(200);
  expect(await balance()).toBe(25_000_000);
  await dodoWebhook(o.orderId);
  expect((await api(`/api/payments/orders/${o.orderId}/check`, {})).data.payment).toMatchObject({ status: "paid", provider: "dodo" });
  expect(await balance()).toBe(25_000_000);
  expect((await api("/api/ai")).data.ledger[0]).toMatchObject({ type: "credit", micro: 25_000_000, by: "dodo" });
});

it("refuses a forged Dodo webhook, and a Dodo payment that doesn't match the order", async () => {
  useDodo();
  const o = await buy(10, "USD");
  dodoPay("cks_1");
  expect((await dodoWebhook(o.orderId, `whsec_${Buffer.from("some-other-secret-0123456789abcd").toString("base64")}`)).status).toBe(401);
  expect(await balance()).toBe(0);
  const short = await buy(25, "USD");
  dodoPay("cks_2", { total_amount: 100 });
  await dodoWebhook(short.orderId);
  expect(await balance()).toBe(0);
  expect((await api("/api/payments")).data.history[0]).toMatchObject({ orderId: short.orderId, status: "mismatch" });
});

it("offers only the currencies a configured provider can take", async () => {
  delete process.env.CASHFREE_APP_ID;
  useDodo();
  expect((await api("/api/payments")).data).toMatchObject({ enabled: true, currencies: ["USD"] });
  expect((await api("/api/payments/orders", { bundle: 10, currency: "INR" })).status).toBe(409);
  expect((await webhook("olp_000000000000000000000000")).status).toBe(404); // Cashfree's webhook is off
});
