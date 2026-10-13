import { db } from "./_lib/db.mjs";
import { handleError, json, methodNotAllowed } from "./_lib/http.mjs";
import { clientIp, rateLimit } from "./_lib/ratelimit.mjs";
import { verifyAdmobCallback } from "./_lib/google.mjs";
import { verifyAdDouble } from "./_lib/economy.mjs";

/**
 * AdMob server-side verification callback for the rewarded "double the reward" ad (set as the SSV URL of the ad
 * unit). AdMob signs every call; the app passes our nonce as custom data and the account id as user id.
 * Answers 200 to every correctly signed call (AdMob retries otherwise), whether or not it matched an ad.
 */
export async function handler(event) {
  try {
    if (event.httpMethod !== "GET") return methodNotAllowed(["GET"]);
    const sql = db();
    await rateLimit("adCallback", clientIp(event), sql);
    const raw = event.rawQuery ?? (event.rawUrl ? new URL(event.rawUrl).search : "");
    const p = await verifyAdmobCallback(raw);
    // AdMob's "verify URL" button sends a signed call without our data
    if (!p.custom_data || !p.user_id) return json(200, { ok: true, test: true });
    const matched = await verifyAdDouble(sql, p.custom_data, p.user_id, p.transaction_id || null);
    if (!matched) console.warn("ad callback did not match a pending ad", p.transaction_id);
    return json(200, { ok: true });
  } catch (error) {
    return handleError(error);
  }
}
