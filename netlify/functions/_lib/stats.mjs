import { httpError, loadCatalog, RARITIES } from "./economy.mjs";
import { leagueOf, seasonAt } from "./ranks.mjs";

// A player's statistics (games by kind, wins, streaks, fastest win), their collection by kind and rarity, their rank,
// and their recent games with the opponent of each online game. The full view is the player's own; others see a
// public profile (nickname only, never the sign-in name or email).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_OF = r => r.kind || (r.mode === "online" ? "casual" : "practice");

function totals(rows) {
  const blank = () => ({ games: 0, wins: 0, losses: 0, draws: 0 });
  const out = { all: blank(), online: blank(), ai: blank(), byKind: { practice: blank(), ranked: blank(), casual: blank(), friend: blank() } };
  for (const r of rows) {
    const n = Number(r.n);
    const add = t => {
      t.games += n;
      if (r.result === "win") t.wins += n; else if (r.result === "draw") t.draws += n; else t.losses += n;
    };
    add(out.all);
    add(r.mode === "online" ? out.online : out.ai);
    add(out.byKind[KIND_OF(r)] || out.byKind.practice);
  }
  return out;
}

/** Longest run of wins, and the current run (wins > 0, losses < 0), newest game first. */
function streaks(results) {
  let best = 0, run = 0;
  for (const r of [...results].reverse()) {
    run = r === "win" ? run + 1 : 0;
    best = Math.max(best, run);
  }
  let current = 0;
  for (const r of results) {
    if (r === "win") { if (current < 0) break; current++; }
    else if (r === "draw") break;
    else { if (current > 0) break; current--; }
  }
  return { best, current };
}

async function collection(sql, userId) {
  const [catalog, owned] = await Promise.all([
    loadCatalog(sql),
    sql`select card_id, count from player_cards where user_id = ${userId} and count > 0`
  ]);
  const have = Object.fromEntries(owned.map(r => [r.card_id, Number(r.count)]));
  const kindOf = c => c.god ? "god" : c.kind;
  const blank = () => ({ owned: 0, total: 0 });
  const byKind = { monster: blank(), spell: blank(), god: blank() };
  const byRarity = Object.fromEntries(RARITIES.map(r => [r, blank()]));
  let copies = 0;
  for (const c of catalog) {
    const k = byKind[kindOf(c)];
    const r = byRarity[c.rarity];
    if (k) k.total++;
    if (r) r.total++;
    if (have[c.id]) {
      if (k) k.owned++;
      if (r) r.owned++;
      copies += have[c.id];
    }
  }
  return { owned: Object.keys(have).filter(id => catalog.some(c => c.id === id)).length, total: catalog.length, copies, byKind, byRarity };
}

async function rankOf(sql, cfg, userId) {
  const season = seasonAt(cfg);
  const [r] = await sql`select points, best_league, games, wins, streak, reached_at from player_ranks where user_id = ${userId} and season = ${season.id}`;
  if (!r) return { season, league: 1, points: 0, best: 1, games: 0, wins: 0, place: null };
  let place = null;
  if (Number(r.games) > 0) {
    const [p] = await sql`select count(*)::int + 1 as place from player_ranks
      where season = ${season.id} and games > 0 and (points > ${r.points} or (points = ${r.points} and reached_at < ${r.reached_at}))`;
    place = p.place;
  }
  return { season, league: leagueOf(cfg, Number(r.points)).league, points: Number(r.points), best: Number(r.best_league), games: Number(r.games), wins: Number(r.wins), streak: Number(r.streak), place };
}

/** Everything the statistics screen shows (the player's own). */
export async function myStats(sql, cfg, userId) {
  const [user] = await sql`select nickname, created_at from app_users where id = ${userId}`;
  if (!user) throw httpError(404, "not_found");
  const [grouped, order, speed, rank, coll, recent] = await Promise.all([
    sql`select mode, kind, result, count(*)::int as n from match_results where user_id = ${userId} and mode in ('ai', 'online') group by mode, kind, result`,
    sql`select result from match_results where user_id = ${userId} and mode in ('ai', 'online') order by created_at desc limit 500`,
    sql`select min(turns) filter (where result = 'win' and turns > 0)::int as fastest, round(avg(turns))::int as average
      from match_results where user_id = ${userId} and mode in ('ai', 'online')`,
    rankOf(sql, cfg, userId),
    collection(sql, userId),
    recentGames(sql, userId, 20)
  ]);
  return {
    nickname: user.nickname,
    memberSince: user.created_at,
    totals: totals(grouped),
    streaks: streaks(order.map(r => r.result)),
    fastestWin: speed[0]?.fastest ?? null,
    averageTurns: speed[0]?.average ?? null,
    rank,
    collection: coll,
    recent
  };
}

/** The last games, newest first; an online game names its opponent (their nickname and public id when they have an account). */
export async function recentGames(sql, userId, limit = 20) {
  const rows = await sql`
    select m.match_key, m.mode, m.kind, m.result, m.turns, m.created_at, m.opponent_name, m.ai_level,
      o.user_id as opponent_id, ou.nickname as opponent_nickname, rm.delta as rank_delta, rm.result as rank_result
    from match_results m
    left join lateral (
      select x.user_id from match_results x where m.mode = 'online' and x.match_key = m.match_key and x.user_id <> m.user_id limit 1
    ) o on true
    left join app_users ou on ou.id = o.user_id
    left join ranked_matches rm on rm.user_id = m.user_id and rm.match_key = m.match_key
    where m.user_id = ${userId} and m.mode in ('ai', 'online')
    order by m.created_at desc
    limit ${limit}
  `;
  return rows.map(r => ({
    kind: KIND_OF(r),
    mode: r.mode,
    result: r.result,
    turns: Number(r.turns),
    at: r.created_at,
    aiLevel: r.mode === "ai" ? r.ai_level : null,
    opponent: r.mode !== "online" ? null : {
      id: r.opponent_id || null,
      name: r.opponent_nickname || r.opponent_name || null
    },
    // ranked: the points it moved (null while an online win waits for the opponent)
    points: r.rank_result ? Number(r.rank_delta || 0) : null
  }));
}

/** What anyone signed in may see about a player: the public name, rank, record and collection size. */
export async function publicProfile(sql, cfg, targetId) {
  const id = String(targetId || "");
  if (!UUID.test(id)) throw httpError(400, "bad_user");
  const [user] = await sql`select nickname, created_at, ugs_player_id from app_users where id = ${id}`;
  if (!user) throw httpError(404, "not_found");
  const [grouped, order, speed, rank, coll] = await Promise.all([
    sql`select mode, kind, result, count(*)::int as n from match_results where user_id = ${id} and mode in ('ai', 'online') group by mode, kind, result`,
    sql`select result from match_results where user_id = ${id} and mode in ('ai', 'online') order by created_at desc limit 500`,
    sql`select min(turns) filter (where result = 'win' and turns > 0)::int as fastest from match_results where user_id = ${id} and mode in ('ai', 'online')`,
    rankOf(sql, cfg, id),
    collection(sql, id)
  ]);
  const t = totals(grouped);
  return {
    id,
    nickname: user.nickname || "Gardener",
    memberSince: user.created_at,
    // friend requests go to the Unity player behind the account
    friendId: user.ugs_player_id || null,
    totals: { all: t.all, online: t.online, ai: t.ai },
    streaks: { best: streaks(order.map(r => r.result)).best },
    fastestWin: speed[0]?.fastest ?? null,
    rank: { league: rank.league, points: rank.points, best: rank.best, place: rank.place, games: rank.games, wins: rank.wins },
    collection: { owned: coll.owned, total: coll.total }
  };
}
