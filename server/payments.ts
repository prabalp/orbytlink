import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Identity } from "./schema.js";
import { grantCredits } from "./ai.js";

// Buying AI credit. Rupee orders go to Cashfree; dollar orders go to Dodo Payments (merchant of
// record, so it adds and remits sales tax) when Dodo is configured, otherwise to Cashfree too.
// Card details never reach OrbytLink: the person pays on the provider's own checkout page, and credit
// is added only after the server has asked the provider whether the order is paid (the webhooks and
// the return page all go through settle(), so a forged webhook cannot add credit, and the same
// payment can never add it twice).
//
//   CASHFREE_APP_ID, CASHFREE_SECRET_KEY   from the Cashfree dashboard (use the sandbox pair first)
//   CASHFREE_ENV                           "sandbox" (default) or "production"
//   PAYMENT_FEE_PERCENT / PAYMENT_FEE_FIXED_USD   Cashfree's cut, added to the price so the credit is paid in full
//   USD_INR_RATE                           rupees per dollar for ₹ prices
//   GST_PERCENT_INR                        GST added to ₹ prices (0 until you are registered)
//   DODO_PAYMENTS_API_KEY                  from the Dodo dashboard (a dodo_test_ key first)
//   DODO_PAYMENTS_ENVIRONMENT              "test_mode" (default) or "live_mode"
//   DODO_PAYMENTS_WEBHOOK_KEY              the endpoint's signing secret (whsec_…)
//   DODO_PRODUCT_ID                        a one-time, pay-what-you-want USD product; the amount is set per order
//   DODO_FEE_PERCENT / DODO_FEE_FIXED_USD  Dodo's cut on dollar orders (international cards: 5.5% + $0.40)
export const cashfreeConfigured = () => !!process.env.CASHFREE_APP_ID && !!process.env.CASHFREE_SECRET_KEY;
export const dodoConfigured = () => !!process.env.DODO_PAYMENTS_API_KEY && !!process.env.DODO_PRODUCT_ID;
export const paymentsConfigured = () => cashfreeConfigured() || dodoConfigured();
export type Provider = "cashfree" | "dodo";
// Which provider takes an order in this currency, or null when none can.
export const providerFor = (currency: Currency): Provider | null =>
  currency === "USD" && dodoConfigured() ? "dodo" : cashfreeConfigured() ? "cashfree" : null;
export const currencies = () => (["INR", "USD"] as const).filter((c) => providerFor(c));
export const dodoMode = () => (process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" ? "live_mode" : "test_mode");
const dodoApi = () => (dodoMode() === "live_mode" ? "https://live.dodopayments.com" : "https://test.dodopayments.com");
export const cashfreeMode = () => (process.env.CASHFREE_ENV === "production" ? "production" : "sandbox");
const api = () => (cashfreeMode() === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg");
const VERSION = "2023-08-01";
export const BUNDLES = [10, 25, 50, 100]; // dollars of credit
export const MIN_BUNDLE = BUNDLES[0];

const safe = (message: string, status = 409) => Object.assign(new Error(message), { safe: true, status });
const env = (name: string, fallback: number, min: number, max: number) => {
  const n = Number(process.env[name]?.trim() || NaN);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};
export const pricing = () => ({
  feePercent: env("PAYMENT_FEE_PERCENT", 3, 0, 30),
  feeFixedUsd: env("PAYMENT_FEE_FIXED_USD", 0, 0, 10),
  usdInr: env("USD_INR_RATE", 90, 1, 1000),
  gstPercent: env("GST_PERCENT_INR", 0, 0, 50),
  dodoFeePercent: env("DODO_FEE_PERCENT", 5.5, 0, 30),
  dodoFeeFixedUsd: env("DODO_FEE_FIXED_USD", 0.4, 0, 10),
});

export type Currency = "USD" | "INR";
// What a bundle costs: the credit, plus enough to cover the processing fee, plus tax where it applies.
// Dodo adds sales tax on its own checkout page, so a Dodo quote says so instead of including it.
export function quote(creditUsd: number, currency: Currency) {
  const p = pricing();
  if (currency === "USD" && providerFor("USD") === "dodo") {
    const price = Math.ceil(((creditUsd + p.dodoFeeFixedUsd) / (1 - p.dodoFeePercent / 100)) * 100) / 100;
    return { currency, credit: creditUsd, fee: Math.round((price - creditUsd) * 100) / 100, tax: 0, total: price, taxAtCheckout: true };
  }
  const gross = (creditUsd + p.feeFixedUsd) / (1 - p.feePercent / 100); // price before tax, in dollars
  if (currency === "USD") {
    const price = Math.ceil(gross * 100) / 100;
    return { currency, credit: creditUsd, fee: Math.round((price - creditUsd) * 100) / 100, tax: 0, total: price };
  }
  const price = Math.ceil(gross * p.usdInr); // whole rupees
  const tax = Math.round(((price * p.gstPercent) / 100) * 100) / 100;
  return { currency, credit: creditUsd, fee: Math.round((price - creditUsd * p.usdInr) * 100) / 100, tax, total: Math.round((price + tax) * 100) / 100 };
}

// ── Orders table ─────────────────────────────────────────────────────────────
const ready = new WeakSet<Store>();
function ensure(store: Store) {
  if (ready.has(store)) return;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS payments(order_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, user TEXT NOT NULL, credit_usd INTEGER NOT NULL, currency TEXT NOT NULL, amount TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, paid_at INTEGER);
    CREATE INDEX IF NOT EXISTS payments_workspace ON payments(workspace, created_at);
  `);
  // Added with Dodo: which provider holds the order, and its own id there (the checkout session).
  const cols = (store.db.prepare("PRAGMA table_info(payments)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("provider")) store.db.exec("ALTER TABLE payments ADD COLUMN provider TEXT NOT NULL DEFAULT 'cashfree'");
  if (!cols.includes("provider_ref")) store.db.exec("ALTER TABLE payments ADD COLUMN provider_ref TEXT");
  ready.add(store);
}
export type Payment = { orderId: string; creditUsd: number; currency: Currency; amount: string; status: string; provider: Provider; createdAt: string; paidAt: string | null };
const shape = (r: any): Payment => ({ orderId: r.order_id, creditUsd: r.credit_usd, currency: r.currency, amount: r.amount, status: r.status, provider: r.provider, createdAt: new Date(r.created_at).toISOString(), paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null });
export function listPayments(store: Store, workspace: string, limit = 20): Payment[] {
  ensure(store);
  return (store.db.prepare("SELECT * FROM payments WHERE workspace=? ORDER BY created_at DESC LIMIT ?").all(workspace, limit) as any[]).map(shape);
}

// ── Talking to Cashfree ──────────────────────────────────────────────────────
async function cashfree(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${api()}${path}`, {
    method,
    headers: { "x-client-id": process.env.CASHFREE_APP_ID!, "x-client-secret": process.env.CASHFREE_SECRET_KEY!, "x-api-version": VERSION, "Content-Type": "application/json", Accept: "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!r) throw safe("Cashfree could not be reached. Nothing was charged.", 502);
  const data: any = await r.json().catch(() => null);
  if (!r.ok || !data) throw safe(`Cashfree refused the request (HTTP ${r.status}${data?.message ? `: ${String(data.message).slice(0, 120)}` : ""}). Nothing was charged.`, 502);
  return data;
}

// ── Talking to Dodo ──────────────────────────────────────────────────────────
async function dodo(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${dodoApi()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.DODO_PAYMENTS_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!r) throw safe("Dodo Payments could not be reached. Nothing was charged.", 502);
  const data: any = await r.json().catch(() => null);
  if (!r.ok || !data) throw safe(`Dodo Payments refused the request (HTTP ${r.status}${data?.message ? `: ${String(data.message).slice(0, 120)}` : ""}). Nothing was charged.`, 502);
  return data;
}

const orderInput = z.object({ bundle: z.number().int().refine((n) => BUNDLES.includes(n), "Pick one of the listed amounts"), currency: z.enum(["USD", "INR"]) });
const origin = () => (process.env.APP_ORIGIN || "http://127.0.0.1:3100").replace(/\/+$/, "");
export async function createOrder(store: Store, identity: Identity, input: unknown) {
  ensure(store);
  if (!paymentsConfigured()) throw safe("Online payments are not switched on for this OrbytLink server yet.");
  const { bundle, currency } = orderInput.parse(input);
  const provider = providerFor(currency);
  if (!provider) throw safe(`Payments in ${currency} are not switched on for this OrbytLink server yet.`);
  // A small guard against a stuck button or a script creating orders in a loop.
  const recent = (store.db.prepare("SELECT count(*) AS n FROM payments WHERE workspace=? AND created_at>?").get(identity.workspace, Date.now() - 3_600_000) as { n: number }).n;
  if (recent >= 20) throw safe("Too many payment attempts in the last hour. Try again later.", 429);
  const q = quote(bundle, currency);
  const orderId = `olp_${randomBytes(12).toString("hex")}`;
  store.db.prepare("INSERT INTO payments(order_id, workspace, user, credit_usd, currency, amount, status, created_at, provider) VALUES (?,?,?,?,?,?,?,?,?)").run(orderId, identity.workspace, identity.user, bundle, currency, q.total.toFixed(2), "created", Date.now(), provider);
  try {
    const email = identity.user.includes("@") ? identity.user.slice(0, 100) : undefined;
    if (provider === "dodo") {
      const session = await dodo("POST", "/checkouts", {
        product_cart: [{ product_id: process.env.DODO_PRODUCT_ID, quantity: 1, amount: Math.round(q.total * 100) }],
        ...(email ? { customer: { email } } : {}),
        billing_currency: "USD",
        feature_flags: { allow_currency_selection: false, allow_discount_code: false },
        metadata: { order_id: orderId, workspace: identity.workspace, credit_usd: String(bundle) },
        return_url: `${origin()}/?pay_order=${orderId}#settings`,
      });
      if (typeof session.session_id !== "string" || typeof session.checkout_url !== "string" || !/^https:\/\//.test(session.checkout_url))
        throw safe("Dodo Payments did not return a checkout page. Nothing was charged.", 502);
      store.db.prepare("UPDATE payments SET provider_ref=? WHERE order_id=?").run(session.session_id, orderId);
      store.audit(identity.workspace, identity.user, "payment.started", `${orderId} · dodo · ${currency} ${q.total}`);
      return { orderId, provider, checkoutUrl: session.checkout_url as string, mode: dodoMode(), quote: q };
    }
    const order = await cashfree("POST", "/orders", {
      order_id: orderId,
      order_amount: q.total,
      order_currency: currency,
      order_note: `OrbytLink AI credit $${bundle}`,
      // Cashfree requires a customer id and phone; OrbytLink does not collect a phone number.
      customer_details: { customer_id: `u_${createHash("sha256").update(identity.user).digest("hex").slice(0, 24)}`, customer_phone: "9999999999", ...(email ? { customer_email: email } : {}) },
      order_meta: { return_url: `${origin()}/?pay_order={order_id}#settings`, notify_url: `${origin()}/api/payments/webhook` },
    });
    if (typeof order.payment_session_id !== "string") throw safe("Cashfree did not return a payment session. Nothing was charged.", 502);
    store.audit(identity.workspace, identity.user, "payment.started", `${orderId} · ${currency} ${q.total}`);
    return { orderId, provider, paymentSessionId: order.payment_session_id as string, mode: cashfreeMode(), quote: q };
  } catch (error) {
    store.db.prepare("UPDATE payments SET status='failed' WHERE order_id=? AND status='created'").run(orderId);
    throw error;
  }
}

// Ask Cashfree what happened to an order and bring our record in line. Safe to call any number of
// times, from the webhook, the return page and the polling that follows.
export async function settle(store: Store, orderId: string, workspace?: string): Promise<Payment | null> {
  ensure(store);
  const row = store.db.prepare("SELECT * FROM payments WHERE order_id=?").get(orderId) as any;
  if (!row || (workspace && row.workspace !== workspace)) return null;
  if (row.status !== "created") return shape(row);
  if (row.provider === "dodo") return settleDodo(store, row);
  const order = await cashfree("GET", `/orders/${encodeURIComponent(orderId)}`);
  const status = String(order.order_status || "");
  if (status === "PAID") {
    // The order Cashfree reports must be the one we created: same amount, same currency.
    if (String(order.order_currency) !== row.currency || Math.abs(Number(order.order_amount) - Number(row.amount)) > 0.001) {
      store.db.prepare("UPDATE payments SET status='mismatch' WHERE order_id=? AND status='created'").run(orderId);
      store.audit(row.workspace, "cashfree", "payment.mismatch", `${orderId} · expected ${row.currency} ${row.amount}, got ${order.order_currency} ${order.order_amount}`);
      return shape(store.db.prepare("SELECT * FROM payments WHERE order_id=?").get(orderId));
    }
    // One transaction: the status flips from "created" exactly once, and only that run adds credit.
    store.transaction(() => {
      const flipped = Number(store.db.prepare("UPDATE payments SET status='paid', paid_at=? WHERE order_id=? AND status='created'").run(Date.now(), orderId).changes);
      if (flipped) grantCredits(store, row.workspace, row.credit_usd * 1_000_000, "cashfree", `Payment ${orderId}`);
    });
  } else if (status === "EXPIRED" || status === "TERMINATED" || status === "TERMINATION_REQUESTED") {
    store.db.prepare("UPDATE payments SET status='expired' WHERE order_id=? AND status='created'").run(orderId);
  }
  return shape(store.db.prepare("SELECT * FROM payments WHERE order_id=?").get(orderId));
}

// A Dodo order is paid when its checkout session has a succeeded payment that carries our order id,
// in dollars, for at least the amount we asked (Dodo adds tax on top, never takes anything off).
async function settleDodo(store: Store, row: any): Promise<Payment> {
  const orderId: string = row.order_id;
  const reread = () => shape(store.db.prepare("SELECT * FROM payments WHERE order_id=?").get(orderId));
  if (!row.provider_ref) return shape(row);
  const session = await dodo("GET", `/checkouts/${encodeURIComponent(row.provider_ref)}`);
  if (session.payment_status !== "succeeded" || typeof session.payment_id !== "string") {
    if (session.payment_status === "cancelled") store.db.prepare("UPDATE payments SET status='expired' WHERE order_id=? AND status='created'").run(orderId);
    return reread();
  }
  const payment = await dodo("GET", `/payments/${encodeURIComponent(session.payment_id)}`);
  const cents = Math.round(Number(row.amount) * 100);
  if (payment.status !== "succeeded") return reread();
  if (payment.metadata?.order_id !== orderId || String(payment.currency) !== "USD" || !(Number(payment.total_amount) >= cents)) {
    store.db.prepare("UPDATE payments SET status='mismatch' WHERE order_id=? AND status='created'").run(orderId);
    store.audit(row.workspace, "dodo", "payment.mismatch", `${orderId} · expected USD ${row.amount}, got ${payment.currency} ${Number(payment.total_amount) / 100} for ${payment.metadata?.order_id ?? "no order"}`);
    return reread();
  }
  store.transaction(() => {
    const flipped = Number(store.db.prepare("UPDATE payments SET status='paid', paid_at=? WHERE order_id=? AND status='created'").run(Date.now(), orderId).changes);
    if (flipped) grantCredits(store, row.workspace, row.credit_usd * 1_000_000, "dodo", `Payment ${orderId}`);
  });
  return reread();
}

// ── Webhook ──────────────────────────────────────────────────────────────────
// Cashfree signs timestamp + raw body with the secret key (HMAC-SHA256, base64).
export function validSignature(raw: string, timestamp: string, signature: string) {
  const secret = process.env.CASHFREE_SECRET_KEY;
  if (!secret || !timestamp || !signature) return false;
  const expected = createHmac("sha256", secret).update(timestamp + raw).digest();
  const given = Buffer.from(signature, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
// The webhook only tells us which order to look at; settle() decides what is true.
export const orderIdFrom = (payload: any): string | null => {
  const id = payload?.data?.order?.order_id;
  return typeof id === "string" && /^olp_[a-f0-9]{24}$/.test(id) ? id : null;
};

// Dodo signs webhooks with Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature over the
// raw body). Returns the order the event names, or null; settle() then asks Dodo what is true.
export function dodoOrderFrom(raw: string, headers: Record<string, unknown>): { ok: boolean; orderId: string | null } {
  const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY;
  if (!secret) return { ok: false, orderId: null };
  let event: any;
  try {
    event = new Webhook(secret).verify(raw, {
      "webhook-id": String(headers["webhook-id"] ?? ""),
      "webhook-timestamp": String(headers["webhook-timestamp"] ?? ""),
      "webhook-signature": String(headers["webhook-signature"] ?? ""),
    });
  } catch {
    return { ok: false, orderId: null };
  }
  const id = event?.data?.metadata?.order_id;
  return { ok: true, orderId: typeof id === "string" && /^olp_[a-f0-9]{24}$/.test(id) ? id : null };
}
