// End-to-end test of accounts, deletion, rate limits, error reports, purchases and ad rewards against a TEST
// database branch (never production). Google's servers are replaced by fakes; the signatures are real.
//   DATABASE_URL=<test branch> node scripts/accounts-test.mjs
import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { rateLimit } from "../netlify/functions/_lib/ratelimit.mjs";
import { signInWithIdentity } from "../netlify/functions/_lib/accounts.mjs";
import { playGamesPlayer, verifyPlayPurchase, verifyAdmobCallback } from "../netlify/functions/_lib/google.mjs";
import {
  ECONOMY, ensureStarter, grantPurchase, loadState, rewardMatch, startAdDouble, verifyAdDouble, claimAdDouble
} from "../netlify/functions/_lib/economy.mjs";
import { handler as linkEmail } from "../netlify/functions/auth-link-email.mjs";
import { handler as me } from "../netlify/functions/auth-me.mjs";
import { handler as deleteAccount } from "../netlify/functions/account-delete.mjs";
import { handler as clientError } from "../netlify/functions/client-error.mjs";
import { handler as requestReset } from "../netlify/functions/auth-request-reset.mjs";

const sql = neon(process.env.DATABASE_URL);
let failures = 0;
function check(ok, what) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
}
const run = Date.now().toString(36);
const ip = `test-${run}`;
const cookieOf = res => /hg_session=([^;]+)/.exec(res?.["set-cookie"] || "")?.[1];
const ev = (token, body, extra = {}) => ({
  httpMethod: "POST", headers: { cookie: token ? `hg_session=${token}` : "", "x-nf-client-connection-ip": ip },
  body: body ? JSON.stringify(body) : null, queryStringParameters: {}, ...extra
});
const parse = res => ({ status: res.statusCode, data: JSON.parse(res.body), headers: res.headers });
async function emailUser(tag) {
  const email = `accounts-test-${run}-${tag}@example.invalid`;
  const [u] = await sql`insert into app_users (email, display_name, password_hash) values (${email}, ${tag}, 'x') returning id`;
  const token = crypto.randomBytes(24).toString("base64url");
  await sql`insert into user_sessions (user_id, token_hash, expires_at) values (${u.id}, ${crypto.createHash("sha256").update(token).digest("hex")}, now() + interval '1 hour')`;
  return { id: u.id, token, email };
}
const made = [];

try {
  // ---- rate limits
  {
    let refused = 0;
    for (let i = 0; i < 32; i++) { try { await rateLimit("deck", `rl-${run}`, sql); } catch (e) { if (e.statusCode === 429) refused++; } }
    check(refused === 2, `rate limit: 30 allowed, then refused (${refused} refused)`);
  }

  // ---- Play Games: code exchange with Google faked
  {
    process.env.GOOGLE_PGS_CLIENT_ID = "test-client";
    process.env.GOOGLE_PGS_CLIENT_SECRET = "test-secret";
    const fake = async (url, init) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        const body = new URLSearchParams(init.body);
        if (body.get("code") !== "good-code") return new Response("{}", { status: 400 });
        return Response.json({ access_token: "at" });
      }
      if (url.startsWith("https://games.googleapis.com/games/v1/players/me")) return Response.json({ playerId: "g123", displayName: "Gamer" });
      return new Response("", { status: 404 });
    };
    const p = await playGamesPlayer("good-code", fake);
    check(p.playerId === "g123" && p.displayName === "Gamer", "Play Games: the auth code is exchanged for the player id");
    let rejected = null;
    try { await playGamesPlayer("bad-code", fake); } catch (e) { rejected = e.publicCode; }
    check(rejected === "play_games_rejected", "Play Games: a bad code is rejected");
  }

  // ---- sign in with an identity: create, sign in again, link, conflicts
  const subject = `pgs-${run}`;
  const [s1, b1, h1] = await signInWithIdentity(sql, ev(), "google_play", subject, "Gamer", false);
  check(s1 === 201 && b1.created && b1.user.email === null && b1.user.providers.includes("google_play") && cookieOf(h1),
    "first Google Play sign-in creates an account without email, with a session");
  const googleUser = b1.user.id;
  made.push(googleUser);
  const [s2, b2] = await signInWithIdentity(sql, ev(), "google_play", subject, "Gamer", false);
  check(s2 === 200 && b2.user.id === googleUser && !b2.created, "signing in again finds the same account");

  const emailOnly = await emailUser("linker");
  made.push(emailOnly.id);
  const [s3, b3] = await signInWithIdentity(sql, ev(emailOnly.token), "google_play", `pgs2-${run}`, "Linker", true);
  check(s3 === 200 && b3.linked && b3.user.id === emailOnly.id && b3.user.providers.includes("google_play"), "an email account can link Google Play");
  const [s4, b4] = await signInWithIdentity(sql, ev(emailOnly.token), "google_play", subject, "Gamer", true);
  check(s4 === 409 && b4.error === "identity_in_use", "linking a Google Play account that belongs to someone else is refused");
  const [s5, b5] = await signInWithIdentity(sql, ev(emailOnly.token), "google_play", `pgs3-${run}`, "Again", true);
  check(s5 === 409 && b5.error === "already_linked", "an account links one Google Play account at most");
  const [s6] = await signInWithIdentity(sql, ev(null), "google_play", `pgs4-${run}`, "Nobody", true);
  check(s6 === 401, "linking needs a signed-in account");

  // ---- auth-me lists the sign-in methods; a Google account adds an email
  const googleToken = cookieOf(h1);
  let r = parse(await me({ ...ev(googleToken), httpMethod: "GET" }));
  check(r.status === 200 && r.data.user.id === googleUser && r.data.user.providers.join() === "google_play", "auth-me returns the providers");
  r = parse(await linkEmail(ev(googleToken, { email: `added-${run}@example.invalid`, password: "short" })));
  check(r.status === 400 && r.data.error === "weak_password", "adding an email: password of 8+ characters");
  r = parse(await linkEmail(ev(googleToken, { email: emailOnly.email, password: "longenough" })));
  check(r.status === 409 && r.data.error === "email_exists", "adding an email that another account uses is refused");
  r = parse(await linkEmail(ev(googleToken, { email: `added-${run}@example.invalid`, password: "longenough" })));
  check(r.status === 200 && r.data.user.email === `added-${run}@example.invalid`, "a Google account adds an email and password");
  r = parse(await linkEmail(ev(googleToken, { email: `again-${run}@example.invalid`, password: "longenough" })));
  check(r.status === 409 && r.data.error === "email_already_set", "the email cannot be replaced this way");

  // ---- purchases (Google faked; the service account JWT is really signed)
  {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT = JSON.stringify({
      client_email: "test@example.invalid", private_key: privateKey.export({ type: "pkcs8", format: "pem" })
    });
    let purchaseState = 0;
    const fake = async url => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "sa", expires_in: 3600 });
      if (url.includes("/purchases/products/apples_60/tokens/")) return Response.json({ purchaseState, orderId: "GPA.1", purchaseType: 0 });
      return new Response("", { status: 404 });
    };
    const ok = await verifyPlayPurchase("apples_60", "tok", fake);
    check(ok.orderId === "GPA.1", "purchase check: a paid purchase passes");
    purchaseState = 2;
    let err = null;
    try { await verifyPlayPurchase("apples_60", "tok", fake); } catch (e) { err = e.publicCode; }
    check(err === "purchase_pending", "purchase check: a pending purchase pays nothing yet");
    purchaseState = 1;
    try { await verifyPlayPurchase("apples_60", "tok", fake); } catch (e) { err = e.publicCode; }
    check(err === "purchase_not_paid", "purchase check: a canceled purchase is refused");
    err = null;
    try { await verifyPlayPurchase("apples_999", "tok", fake); } catch (e) { err = e.publicCode; }
    check(err === "purchase_not_found", "purchase check: an unknown product is refused");
  }
  await ensureStarter(sql, googleUser);
  const before = (await loadState(sql, googleUser)).apples;
  const token = `purchase-${run}`;
  let g = await grantPurchase(sql, googleUser, { productId: "apples_60", purchaseToken: token, orderId: "GPA.1" });
  let after = (await loadState(sql, googleUser)).apples;
  check(g.granted && after === before + 60, `a purchase adds the apples once (${before} -> ${after})`);
  g = await grantPurchase(sql, googleUser, { productId: "apples_60", purchaseToken: token, orderId: "GPA.1" });
  check(!g.granted && (await loadState(sql, googleUser)).apples === after, "the same purchase again pays nothing");
  let used = null;
  try { await grantPurchase(sql, emailOnly.id, { productId: "apples_60", purchaseToken: token }); } catch (e) { used = e.publicCode; }
  check(used === "purchase_used", "another account cannot use the same purchase");

  // ---- ad: double a match reward (AdMob's signature made with our own key)
  {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const keys = { "42": publicKey.export({ type: "spki", format: "pem" }) };
    const sign = q => `${q}&signature=${crypto.sign("sha256", Buffer.from(q), { key: privateKey, dsaEncoding: "der" }).toString("base64url")}&key_id=42`;

    const coinsBefore = (await loadState(sql, googleUser)).coins;
    const matchKey = `ai-${run}-match`;
    const reward = await rewardMatch(sql, googleUser, { mode: "ai", result: "win", turns: 10, matchKey });
    let err = null;
    try { await startAdDouble(sql, googleUser, "ai-no-such-match"); } catch (e) { err = e.publicCode; }
    check(err === "no_reward", "an ad can only double a match that paid a reward");
    const start = await startAdDouble(sql, googleUser, matchKey);
    check(start.nonce && start.coins === reward.coins, `the ad starts with a nonce for ${start.coins} coins`);
    err = null;
    try { await claimAdDouble(sql, googleUser, start.nonce); } catch (e) { err = e.publicCode; }
    check(err === "ad_not_verified", "no coins before AdMob confirms the ad");

    const query = `ad_network=5450213213286189855&ad_unit=1234&custom_data=${start.nonce}&reward_amount=1&reward_item=double&timestamp=${Date.now()}&transaction_id=tx${run}&user_id=${googleUser}`;
    err = null;
    try { await verifyAdmobCallback(sign(query).replace("reward_amount=1", "reward_amount=9"), fetch, keys); } catch (e) { err = e.publicCode; }
    check(err === "bad_signature", "a tampered AdMob callback is rejected");
    const p = await verifyAdmobCallback(sign(query), fetch, keys);
    check(p.custom_data === start.nonce && p.user_id === googleUser, "a correctly signed AdMob callback is accepted");
    check(await verifyAdDouble(sql, p.custom_data, p.user_id, p.transaction_id), "the callback marks the ad as watched");
    const claim = await claimAdDouble(sql, googleUser, start.nonce);
    const coinsAfter = (await loadState(sql, googleUser)).coins;
    check(claim.coins === reward.coins && coinsAfter === coinsBefore + 2 * reward.coins, `the reward is doubled (${coinsBefore} -> ${coinsAfter})`);
    err = null;
    try { await claimAdDouble(sql, googleUser, start.nonce); } catch (e) { err = e.publicCode; }
    check(err === "already_doubled", "an ad pays once");
    err = null;
    try { await startAdDouble(sql, googleUser, matchKey); } catch (e) { err = e.publicCode; }
    check(err === "already_doubled", "a match is doubled once");

    // daily limit
    for (let i = 0; i < ECONOMY.adDoubleDailyLimit; i++) {
      await sql`insert into ad_rewards (nonce, user_id, match_key, coins, verified_at, claimed_at) values (${`n-${run}-${i}`}, ${googleUser}, ${`m-${run}-${i}`}, 1, now(), now())`;
    }
    const m2 = `ai-${run}-second`;
    await sql`insert into match_rewards (user_id, match_key, mode, result, coins) values (${googleUser}, ${m2}, 'ai', 'win', 500)`;
    err = null;
    try { await startAdDouble(sql, googleUser, m2); } catch (e) { err = e.publicCode; }
    check(err === "ad_limit", `at most ${ECONOMY.adDoubleDailyLimit} doubled rewards a day`);
  }

  // ---- error reports
  r = parse(await clientError(ev(googleToken, { appVersion: "1.0.0", platform: "Android", device: "Pixel", errors: [
    { kind: "exception", message: `NullReference ${run}`, stack: "at X", count: 3 }, { kind: "error", message: `Second ${run}` }] })));
  const stored = await sql`select count(*)::int as n from client_errors where message like ${"%" + run} and user_id = ${googleUser}`;
  check(r.status === 200 && stored[0].n === 2, "error reports are stored with the player");
  r = parse(await clientError(ev(null, { errors: [] })));
  check(r.status === 400, "an empty error report is refused");

  // ---- password reset never returns the link outside local development
  {
    const before = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    r = parse(await requestReset(ev(null, { email: emailOnly.email })));
    check(r.status === 200 && r.data.resetUrl === undefined, "password reset does not leak the reset link");
    if (before) process.env.RESEND_API_KEY = before;
  }

  // ---- account deletion
  r = parse(await deleteAccount(ev(googleToken, {})));
  check(r.status === 400 && r.data.error === "confirmation_required", "deleting needs the confirmation");
  r = parse(await deleteAccount(ev(googleToken, { confirm: "DELETE" })));
  const left = await sql`
    select (select count(*)::int from app_users where id = ${googleUser}) as users,
           (select count(*)::int from user_identities where user_id = ${googleUser}) as ids,
           (select count(*)::int from player_wallets where user_id = ${googleUser}) as wallets,
           (select count(*)::int from player_cards where user_id = ${googleUser}) as cards,
           (select count(*)::int from ad_rewards where user_id = ${googleUser}) as ads,
           (select count(*)::int from user_sessions where user_id = ${googleUser}) as sessions,
           (select count(*)::int from iap_purchases where purchase_token = ${token} and user_id is null) as kept_purchases
  `;
  const L = left[0];
  check(r.status === 200 && /Max-Age=0/.test(r.headers["set-cookie"] || ""), "the account is deleted and the session cookie cleared");
  check(L.users + L.ids + L.wallets + L.cards + L.ads + L.sessions === 0, `nothing of the player is left (${JSON.stringify(L)})`);
  check(L.kept_purchases === 1, "the purchase record stays without the player");
  r = parse(await me({ ...ev(googleToken), httpMethod: "GET" }));
  check(r.status === 200 && r.data.user === null, "the old session no longer works");
} finally {
  for (const id of made) await sql`delete from app_users where id = ${id}`;
  await sql`delete from iap_purchases where purchase_token like ${"purchase-" + run}`;
  await sql`delete from client_errors where message like ${"%" + run}`;
}

console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
