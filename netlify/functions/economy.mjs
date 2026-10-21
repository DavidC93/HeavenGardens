import { currentUser, requireUser } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";
import { clientIp, rateLimit } from "./_lib/ratelimit.mjs";
import {
  adminGrant, claimAdDouble, craft, db, disenchant, ensureStarter, grantPurchase, httpError, loadState, openPack, publicConfig,
  rewardMatch, startAdDouble
} from "./_lib/economy.mjs";
import { verifyPlayPurchase } from "./_lib/google.mjs";
import { requireSupportedClient } from "./_lib/appconfig.mjs";

/**
 * Economy API.
 *   GET  /economy?config=1         public: packs, odds, rewards, starter collection
 *   GET  /economy                  signed in: wallet, collection and shards (grants the starter set on first visit)
 *   POST /economy {action: ...}    openPack {pack} | disenchant {cardId, amount} | craft {cardId}
 *                                  | reward {mode, result, turns, matchKey} | grant {coins, apples} (admin)
 *                                  | purchase {productId, purchaseToken}   (checked with Google, paid once)
 *                                  | adStart {matchKey} -> nonce | adClaim {nonce}   (double a match reward)
 * Every response to a signed-in request carries the new state, so the app always shows the server's numbers.
 */
export async function handler(event) {
  try {
    if (event.httpMethod === "GET" && event.queryStringParameters?.config) {
      return json(200, { config: publicConfig() });
    }

    const user = await requireUser(event);
    const sql = db();
    await requireSupportedClient(event, sql);
    await ensureStarter(sql, user.id);

    if (event.httpMethod === "GET") {
      return json(200, { config: publicConfig(), state: await loadState(sql, user.id) });
    }
    if (event.httpMethod !== "POST") return methodNotAllowed(["GET", "POST"]);
    await rateLimit("economy", user.id, sql);

    const body = await readJson(event);
    let result = {};
    switch (body.action) {
      case "openPack":
        result = { cards: await openPack(sql, user.id, String(body.pack || "")) };
        break;
      case "disenchant":
        result = await disenchant(sql, user.id, String(body.cardId || ""), body.amount);
        break;
      case "craft":
        result = await craft(sql, user.id, String(body.cardId || ""));
        break;
      case "reward":
        result = await rewardMatch(sql, user.id, body);
        break;
      case "purchase": {
        const productId = String(body.productId || "");
        const purchaseToken = String(body.purchaseToken || "");
        const { orderId } = await verifyPlayPurchase(productId, purchaseToken);
        result = await grantPurchase(sql, user.id, { productId, purchaseToken, orderId });
        break;
      }
      case "adStart":
        result = await startAdDouble(sql, user.id, body.matchKey);
        break;
      case "adClaim":
        result = await claimAdDouble(sql, user.id, body.nonce);
        break;
      case "grant": {
        const me = await currentUser(event);
        if (me?.role !== "admin") throw httpError(403, "admin_required");
        await adminGrant(sql, user.id, body);
        break;
      }
      default:
        throw httpError(400, "unknown_action");
    }
    return json(200, { ...result, state: await loadState(sql, user.id) });
  } catch (error) {
    return handleError(error);
  }
}
