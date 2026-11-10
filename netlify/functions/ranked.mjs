import { db } from "./_lib/db.mjs";
import { currentUser, requireAdmin, requireUser } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";
import { clientIp, rateLimit } from "./_lib/ratelimit.mjs";
import { httpError, loadState } from "./_lib/economy.mjs";
import {
  adminAdjust, adminResetNickname, distribution, leaderboard, loadRank, loadRanks, publicStatus, reportMatch, saveRanks,
  setNickname, startMatch
} from "./_lib/ranks.mjs";

/**
 * Ranked play (signed-in players only).
 *   GET                      the player's rank: season, points, league, the computer's level, the leagues
 *                            (+ seasonReward when a new season just paid the last one, settled = matches counted as lost)
 *   GET ?board=1             the season's top 100 and the player's place
 *   GET ?admin=1             (admins) { config, distribution }
 *   POST { action: "start", matchKey }                 -> { aiLevel, rank }    a ranked match against the computer
 *   POST { action: "report", matchKey, result, turns } -> { outcome, rank, state }  win | lose | draw (concede = lose)
 *   POST { action: "nickname", name }                  -> { rank }
 *   POST { action: "saveConfig", config }              (admins) -> { config }
 *   POST { action: "adjust", userId, points, note }    (admins) set a player's points by hand
 *   POST { action: "resetNickname", userId }           (admins) back to a generated name
 */
export async function handler(event) {
  try {
    const sql = db();
    const q = event.queryStringParameters || {};
    if (event.httpMethod === "GET") {
      if (q.admin) {
        await requireAdmin(event);
        const config = await loadRanks(sql);
        return json(200, { config, distribution: await distribution(sql, config) });
      }
      const cfg = await loadRanks(sql);
      if (q.board) {
        const user = await currentUser(event);
        await rateLimit("ranked", user?.id || clientIp(event), sql);
        return json(200, await leaderboard(sql, cfg, user?.id || null));
      }
      const user = await requireUser(event);
      await rateLimit("ranked", user.id, sql);
      const loaded = await loadRank(sql, user.id, cfg);
      return json(200, { rank: await publicStatus(sql, user.id, cfg, loaded) });
    }
    if (event.httpMethod !== "POST") return methodNotAllowed(["GET", "POST"]);
    const body = await readJson(event);

    if (["saveConfig", "adjust", "resetNickname"].includes(body.action)) {
      const admin = await requireAdmin(event);
      switch (body.action) {
        case "saveConfig": return json(200, { config: await saveRanks(sql, body.config, admin.id) });
        case "adjust": return json(200, await adminAdjust(sql, await loadRanks(sql), admin.id, body));
        case "resetNickname": return json(200, { nickname: await adminResetNickname(sql, admin.id, body.userId) });
      }
    }

    const user = await requireUser(event);
    await rateLimit("ranked", user.id, sql);
    const cfg = await loadRanks(sql);
    switch (body.action) {
      case "start": {
        const r = await startMatch(sql, user.id, cfg, body.matchKey);
        return json(200, { aiLevel: r.aiLevel, rank: await publicStatus(sql, user.id, cfg, r) });
      }
      case "report": {
        const r = await reportMatch(sql, user.id, cfg, body);
        const paid = r.outcome.rewards?.length > 0 || r.seasonReward;
        return json(200, { outcome: r.outcome, rank: await publicStatus(sql, user.id, cfg, r), ...(paid ? { state: await loadState(sql, user.id) } : {}) });
      }
      case "nickname": {
        await setNickname(sql, user.id, body.name);
        const loaded = await loadRank(sql, user.id, cfg);
        return json(200, { rank: await publicStatus(sql, user.id, cfg, loaded) });
      }
      default:
        throw httpError(400, "unknown_action");
    }
  } catch (error) {
    return handleError(error);
  }
}
