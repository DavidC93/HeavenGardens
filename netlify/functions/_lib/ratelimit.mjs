import { db } from "./db.mjs";

// Fixed-window rate limits kept in Postgres (functions are stateless, so memory cannot be used).
// Each call counts one request in the current window of `windowSeconds` and refuses with 429 once `limit` is passed.

export const LIMITS = {
  login: { limit: 20, windowSeconds: 600 },          // per IP
  loginEmail: { limit: 10, windowSeconds: 600 },     // per email: slows password guessing on one account
  register: { limit: 10, windowSeconds: 3600 },      // per IP
  resetRequest: { limit: 5, windowSeconds: 3600 },   // per IP
  resetEmail: { limit: 3, windowSeconds: 3600 },     // per email: no mail flooding
  resetPassword: { limit: 20, windowSeconds: 3600 }, // per IP
  platformLogin: { limit: 30, windowSeconds: 600 },  // per IP
  economy: { limit: 90, windowSeconds: 60 },         // per user
  deck: { limit: 30, windowSeconds: 60 },            // per user
  clientError: { limit: 30, windowSeconds: 3600 },   // per IP
  ugsToken: { limit: 30, windowSeconds: 600 },       // per user
  accountDelete: { limit: 5, windowSeconds: 3600 },  // per user
  adCallback: { limit: 120, windowSeconds: 60 },     // per IP (AdMob's servers)
};

export function clientIp(event) {
  const h = event.headers || {};
  return String(h["x-nf-client-connection-ip"] || (h["x-forwarded-for"] || "").split(",")[0] || h["client-ip"] || "unknown").trim();
}

export async function rateLimit(bucket, key, sql = db()) {
  const rule = LIMITS[bucket];
  if (!rule) throw new Error(`unknown rate limit bucket ${bucket}`);
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / (rule.windowSeconds * 1000)) * rule.windowSeconds * 1000).toISOString();
  const rows = await sql`
    insert into rate_limits (bucket, key, window_start, count)
    values (${bucket}, ${String(key).slice(0, 200)}, ${windowStart}, 1)
    on conflict (bucket, key, window_start) do update set count = rate_limits.count + 1
    returning count
  `;
  // now and then, forget windows older than a day
  if (Math.random() < 0.01) await sql`delete from rate_limits where window_start < now() - interval '1 day'`;
  if (rows[0].count > rule.limit) {
    const err = new Error("Too many requests");
    err.statusCode = 429;
    err.publicCode = "rate_limited";
    err.retryAfter = Math.ceil((Date.parse(windowStart) + rule.windowSeconds * 1000 - now) / 1000);
    throw err;
  }
}
