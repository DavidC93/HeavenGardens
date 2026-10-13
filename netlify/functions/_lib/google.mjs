import crypto from "node:crypto";

// Server-side checks against Google: Play Games sign-in, Play Store purchases and AdMob reward callbacks.
// Secrets live only in Netlify environment variables (set by the owner in the Netlify UI, never in the repo):
//   GOOGLE_PGS_CLIENT_ID, GOOGLE_PGS_CLIENT_SECRET   web OAuth client of the Play Games Services project
//   GOOGLE_PLAY_SERVICE_ACCOUNT                      service account key (JSON) with access to the Play Developer API
//   ANDROID_PACKAGE_NAME                             optional, defaults to com.heavengardens.cardbattle

export const PACKAGE_NAME = () => process.env.ANDROID_PACKAGE_NAME || "com.heavengardens.cardbattle";

function failure(statusCode, code, message) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.publicCode = code;
  return err;
}

function requiredEnv(name, code) {
  const value = process.env[name];
  if (!value) throw failure(503, code, `Missing ${name}`);
  return value;
}

// ------------------------------------------------------------------ Play Games sign-in

/**
 * Exchanges the one-time server auth code from Play Games Services v2 (RequestServerSideAccess) for the player's
 * stable id. The code can only be used once and only by our web client, so it cannot be forged or replayed.
 */
export async function playGamesPlayer(authCode, fetchImpl = fetch) {
  if (!authCode || typeof authCode !== "string" || authCode.length > 2048) throw failure(400, "invalid_auth_code");
  const tokenRes = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: authCode,
      client_id: requiredEnv("GOOGLE_PGS_CLIENT_ID", "play_games_not_configured"),
      client_secret: requiredEnv("GOOGLE_PGS_CLIENT_SECRET", "play_games_not_configured"),
      grant_type: "authorization_code",
      redirect_uri: ""
    }).toString()
  });
  if (!tokenRes.ok) throw failure(401, "play_games_rejected", `token exchange failed (${tokenRes.status})`);
  const { access_token: accessToken } = await tokenRes.json();
  const meRes = await fetchImpl("https://games.googleapis.com/games/v1/players/me", {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!meRes.ok) throw failure(401, "play_games_rejected", `player lookup failed (${meRes.status})`);
  const me = await meRes.json();
  if (!me.playerId) throw failure(401, "play_games_rejected", "no player id");
  return { playerId: String(me.playerId), displayName: String(me.displayName || "").slice(0, 40) };
}

// ------------------------------------------------------------------ service account (Play Developer API)

let cachedToken = null;

/** OAuth access token for the service account (JWT bearer grant), cached until shortly before it expires. */
export async function serviceAccountToken(scope, fetchImpl = fetch) {
  if (cachedToken && cachedToken.scope === scope && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  let key;
  try { key = JSON.parse(requiredEnv("GOOGLE_PLAY_SERVICE_ACCOUNT", "iap_not_configured")); }
  catch (e) { if (e.publicCode) throw e; throw failure(503, "iap_not_configured", "service account JSON is invalid"); }
  const now = Math.floor(Date.now() / 1000);
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: key.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
  })}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), key.private_key).toString("base64url");
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString()
  });
  if (!res.ok) throw failure(502, "iap_auth_failed", `service account token failed (${res.status})`);
  const body = await res.json();
  cachedToken = { scope, token: body.access_token, expires: Date.now() + (body.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

// ------------------------------------------------------------------ Play Store purchases

/**
 * Asks Google whether a one-time product purchase is real and paid. Returns the order id; throws otherwise.
 * purchaseState: 0 purchased, 1 canceled, 2 pending.
 */
export async function verifyPlayPurchase(productId, purchaseToken, fetchImpl = fetch) {
  if (!/^[a-z0-9_.]{1,100}$/.test(productId || "")) throw failure(400, "invalid_product");
  if (!purchaseToken || typeof purchaseToken !== "string" || purchaseToken.length > 4096) throw failure(400, "invalid_purchase_token");
  const token = await serviceAccountToken("https://www.googleapis.com/auth/androidpublisher", fetchImpl);
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(PACKAGE_NAME())}` +
    `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404 || res.status === 400 || res.status === 410) throw failure(400, "purchase_not_found");
  if (!res.ok) throw failure(502, "purchase_check_failed", `Play Developer API ${res.status}`);
  const p = await res.json();
  if (p.purchaseState === 2) throw failure(409, "purchase_pending");
  if (p.purchaseState !== 0) throw failure(400, "purchase_not_paid");
  return { orderId: p.orderId || null, testPurchase: p.purchaseType === 0 };
}

// ------------------------------------------------------------------ AdMob server-side verification

const ADMOB_KEYS_URL = "https://www.gstatic.com/admob/reward/verifier-keys.json";
let cachedKeys = null;

async function admobKeys(fetchImpl) {
  if (cachedKeys && cachedKeys.expires > Date.now()) return cachedKeys.keys;
  const res = await fetchImpl(ADMOB_KEYS_URL);
  if (!res.ok) throw failure(502, "ad_keys_unavailable");
  const body = await res.json();
  const keys = Object.fromEntries((body.keys || []).map(k => [String(k.keyId), k.pem]));
  cachedKeys = { keys, expires: Date.now() + 6 * 3600 * 1000 };
  return keys;
}

/**
 * Checks an AdMob rewarded-ad callback. The signed content is the raw query string up to "&signature=";
 * the signature is ECDSA/SHA-256 with one of Google's published keys. Returns the parsed parameters.
 */
export async function verifyAdmobCallback(rawQuery, fetchImpl = fetch, keysOverride = null) {
  const query = String(rawQuery || "").replace(/^\?/, "");
  const sigIndex = query.indexOf("&signature=");
  if (sigIndex < 0) throw failure(400, "unsigned_callback");
  const message = query.slice(0, sigIndex);
  const params = new URLSearchParams(query);
  const signature = params.get("signature");
  const keyId = params.get("key_id");
  const keys = keysOverride || await admobKeys(fetchImpl);
  const pem = keys[String(keyId)];
  if (!pem || !signature) throw failure(400, "unknown_key");
  const ok = crypto.verify("sha256", Buffer.from(message), { key: pem, dsaEncoding: "der" }, Buffer.from(signature, "base64url"));
  if (!ok) throw failure(400, "bad_signature");
  return Object.fromEntries(params.entries());
}
