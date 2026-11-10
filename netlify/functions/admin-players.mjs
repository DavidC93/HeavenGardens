import { db } from "./_lib/db.mjs";
import { requireAdmin } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";
import { rateLimit } from "./_lib/ratelimit.mjs";
import { ECONOMY, RARITIES, ensureStarter, httpError, loadCatalog, loadState, maxCopiesOf } from "./_lib/economy.mjs";
import { loadRanks, playerRank } from "./_lib/ranks.mjs";

/**
 * Back office: players (admins only).
 *   GET  ?q=text&sort=recent|new|games   search by email, name, id or the in-game player id "HG-XXXXXXXXXX" (200 at most),
 *                          with activity (last seen, build, games) and totals for the whole game
 *   GET  ?id=<user id>      the player: account, wallet, collection, shards, recent history
 *   POST { action: "grant", userId, coins, apples, cards: {id: n}, shards: {rarity: n}, note }
 *        adds (or, with negative numbers, removes) currency, cards and shards in one atomic step; logged with the admin
 */
const int = (v, min, max) => Math.max(min, Math.min(max, Math.trunc(Number(v) || 0)));

export async function handler(event) {
  try {
    const admin = await requireAdmin(event);
    const sql = db();
    await rateLimit("economy", `admin-${admin.id}`, sql);

    if (event.httpMethod === "GET") {
      const id = event.queryStringParameters?.id;
      if (id) return json(200, await playerDetail(sql, id));
      const q = String(event.queryStringParameters?.q || "").trim().slice(0, 100);
      const like = `%${q.replace(/[\\%_]/g, m => "\\" + m)}%`;
      // the player id shown in the game is "HG-" + the first 10 hex digits of the account id
      const code = q.replace(/^hg-?/i, "").replace(/-/g, "").toLowerCase();
      const codePrefix = /^[0-9a-f]{6,32}$/.test(code) ? code + "%" : "";
      const sort = ["recent", "new", "games"].includes(event.queryStringParameters?.sort) ? event.queryStringParameters.sort : "recent";
      // last_seen_at / last_client come from migration 008; read through to_jsonb so the list works before it runs
      const rows = await sql`
        select u.id, u.email, u.display_name, u.role, u.created_at, w.coins, w.apples,
          (to_jsonb(u) ->> 'last_seen_at')::timestamptz as last_seen_at, to_jsonb(u) ->> 'last_client' as last_client,
          coalesce(m.games, 0)::int as games, coalesce(m.wins, 0)::int as wins, m.last_match,
          (select string_agg(i.provider, ',') from user_identities i where i.user_id = u.id) as providers,
          greatest((to_jsonb(u) ->> 'last_seen_at')::timestamptz, m.last_match,
            (select max(s.created_at) from user_sessions s where s.user_id = u.id)) as last_active
        from app_users u
        left join player_wallets w on w.user_id = u.id
        left join lateral (
          select count(*) as games, count(*) filter (where r.result = 'win') as wins, max(r.created_at) as last_match
          from match_results r where r.user_id = u.id
        ) m on true
        where ${q} = '' or u.email ilike ${like} or u.display_name ilike ${like} or u.id::text = ${q}
          or (${codePrefix} <> '' and replace(u.id::text, '-', '') like ${codePrefix})
        order by
          case when ${sort} = 'new' then u.created_at end desc,
          case when ${sort} = 'games' then coalesce(m.games, 0) end desc,
          last_active desc nulls last, u.created_at desc
        limit 200
      `;
      const [stats] = await sql`
        with a as (
          select u.created_at, greatest((to_jsonb(u) ->> 'last_seen_at')::timestamptz,
            (select max(r.created_at) from match_results r where r.user_id = u.id),
            (select max(s.created_at) from user_sessions s where s.user_id = u.id)) as last_active,
            exists (select 1 from match_results r where r.user_id = u.id) as played
          from app_users u
        )
        select count(*)::int as total,
          count(*) filter (where last_active > now() - interval '1 day')::int as day,
          count(*) filter (where last_active > now() - interval '7 days')::int as week,
          count(*) filter (where played)::int as played,
          count(*) filter (where created_at > now() - interval '7 days')::int as new_week
        from a
      `;
      return json(200, { players: rows, stats });
    }

    if (event.httpMethod !== "POST") return methodNotAllowed(["GET", "POST"]);
    const body = await readJson(event);
    if (body.action !== "grant") throw httpError(400, "unknown_action");
    const userId = String(body.userId || "");
    const [user] = await sql`select id from app_users where id::text = ${userId}`;
    if (!user) throw httpError(404, "player_not_found");

    const coins = int(body.coins, -10_000_000, 10_000_000);
    const apples = int(body.apples, -1_000_000, 1_000_000);
    const catalog = await loadCatalog(sql);
    const byId = Object.fromEntries(catalog.map(c => [c.id, c]));
    const cards = Object.entries(body.cards || {})
      .map(([cardId, n]) => ({ card_id: cardId, n: int(n, -100, 100) }))
      .filter(c => c.n !== 0);
    const unknown = cards.filter(c => !byId[c.card_id]).map(c => c.card_id);
    if (unknown.length > 0) return json(400, { error: "unknown_card", cards: unknown });
    const cardRows = cards.map(c => ({ ...c, max: maxCopiesOf(byId[c.card_id]) }));
    const shards = Object.entries(body.shards || {})
      .filter(([r]) => RARITIES.includes(r))
      .map(([rarity, n]) => ({ rarity, n: int(n, -100_000, 100_000) }))
      .filter(s => s.n !== 0);
    const note = String(body.note || "").slice(0, 200);
    if (coins === 0 && apples === 0 && cardRows.length === 0 && shards.length === 0) throw httpError(400, "nothing_to_grant");

    // a player who never opened the game's economy gets the starting wallet and collection first
    await ensureStarter(sql, user.id);
    await sql`
      with w as (
        update player_wallets
        set coins = greatest(0, coins + ${coins}), apples = greatest(0, apples + ${apples}), updated_at = now()
        where user_id = ${user.id}
        returning 1
      ),
      x as (select * from jsonb_to_recordset(${JSON.stringify(cardRows)}::jsonb) as x(card_id text, n int, max int)),
      c as (
        insert into player_cards (user_id, card_id, count, locked)
        select ${user.id}, x.card_id, greatest(0, least(x.max, x.n)), 0 from x
        on conflict (user_id, card_id) do update set
          count = greatest(0, least(
            (select x.max from x where x.card_id = player_cards.card_id),
            player_cards.count + (select x.n from x where x.card_id = player_cards.card_id))),
          updated_at = now()
        returning 1
      ),
      y as (select * from jsonb_to_recordset(${JSON.stringify(shards)}::jsonb) as y(rarity text, n int)),
      s as (
        insert into player_shards (user_id, rarity, amount)
        select ${user.id}, y.rarity, greatest(0, y.n) from y
        on conflict (user_id, rarity) do update set
          amount = greatest(0, player_shards.amount + (select y.n from y where y.rarity = player_shards.rarity))
        returning 1
      ),
      e as (
        insert into economy_events (user_id, kind, detail)
        values (${user.id}, 'admin_grant', ${JSON.stringify({ by: admin.id, coins, apples, cards: Object.fromEntries(cards.map(c => [c.card_id, c.n])), shards: Object.fromEntries(shards.map(s => [s.rarity, s.n])), note })}::jsonb)
        returning 1
      )
      select (select count(*) from w) as wallets, (select count(*) from c) as cards, (select count(*) from s) as shards
    `;
    // a starter card can never be removed below its locked copies' new count
    await sql`update player_cards set locked = least(locked, count) where user_id = ${user.id} and locked > count`;
    return json(200, await playerDetail(sql, user.id));
  } catch (error) {
    return handleError(error);
  }
}

async function playerDetail(sql, id) {
  const [user] = await sql`
    select id, email, display_name, role, created_at, to_jsonb(u) ->> 'nickname' as nickname,
      (to_jsonb(u) ->> 'last_seen_at')::timestamptz as last_seen_at, to_jsonb(u) ->> 'last_client' as last_client
    from app_users u where id::text = ${String(id)}
  `;
  if (!user) throw httpError(404, "player_not_found");
  let providers = [];
  try { providers = (await sql`select provider from user_identities where user_id = ${user.id}`).map(r => r.provider); }
  catch { /* sign-in methods table not migrated yet */ }
  const [state, events, matchTotals, matches] = await Promise.all([
    loadState(sql, user.id),
    sql`select kind, detail, created_at from economy_events where user_id = ${user.id} order by created_at desc limit 30`,
    sql`select mode, result, count(*)::int as n from match_results where user_id = ${user.id} group by mode, result`,
    sql`select mode, result, turns, created_at from match_results where user_id = ${user.id} order by created_at desc limit 15`,
  ]);
  const ranks = await loadRanks(sql);
  const rank = await playerRank(sql, ranks, user.id);
  const leagues = ranks.leagues.map(l => ({ league: l.league, he: l.he }));
  return { player: { ...user, providers }, state, events, matchTotals, matches, rank, leagues, maxCopies: ECONOMY.maxCopies };
}
