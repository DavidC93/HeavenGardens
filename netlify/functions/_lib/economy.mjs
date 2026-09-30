import crypto from "node:crypto";
import { db } from "./db.mjs";

// ---------------------------------------------------------------- configuration (the app shows what the server sends)

export const RARITIES = ["bronze", "silver", "gold", "emerald", "diamond"];

export const ECONOMY = {
  version: 1,
  start: { coins: 1000, apples: 10 },
  maxCopies: 4,
  maxGodCopies: 1,
  shardsPerCard: 5,
  craftCost: 50,
  // starter collection: can never be disenchanted
  starter: {
    m_016: 3, m_012: 2, m_006: 2, m_037: 2, m_039: 2, m_024: 1, m_041: 1, m_045: 1, m_033: 1, m_008: 1, m_010: 1,
    m_043: 1, m_062: 1, m_002: 1, m_009: 1, m_007: 1, m_064: 1,
    m_047: 2, m_048: 1, m_049: 1, m_051: 1, m_070: 1, m_075: 1,
    g_004: 1
  },
  rewards: {
    ai: { win: 500, lose: 200 },
    online: { win: 1000, lose: 500 }
  },
  // a game must last this many turns to earn anything, and AI rewards are at least this far apart
  rewardMinTurns: 6,
  aiRewardCooldownSeconds: 45,
  packs: [
    {
      id: "basic", cost: { coins: 1000 },
      slots: [
        { count: 1, odds: { bronze: 70, silver: 30 } },
        { count: 1, odds: { silver: 70, gold: 25, emerald: 5 } }
      ]
    },
    {
      id: "big", cost: { coins: 3000 },
      slots: [
        { count: 3, odds: { bronze: 65, silver: 35 } },
        { count: 1, odds: { silver: 70, gold: 25, emerald: 5 } },
        { count: 1, odds: { gold: 80, emerald: 17, diamond: 3 } }
      ]
    },
    {
      id: "premium", cost: { apples: 50 },
      slots: [
        { count: 3, odds: { bronze: 45, silver: 45, gold: 10 } },
        { count: 1, odds: { gold: 75, emerald: 20, diamond: 5 } },
        { count: 1, odds: { gold: 60, emerald: 30, diamond: 10 } }
      ]
    }
  ]
};

export function httpError(status, code, message = code) {
  const err = new Error(message);
  err.statusCode = status;
  err.publicCode = code;
  return err;
}

// ---------------------------------------------------------------- catalog helpers

function cardRarity(row) {
  const r = String(row.payload?.rarity || "bronze").toLowerCase();
  return RARITIES.includes(r) ? r : "bronze";
}

function isGod(row) {
  return row.payload?.god === true;
}

export async function loadCatalog(sql) {
  const rows = await sql`select id, kind, payload from cards where active = true order by id`;
  return rows.map(row => ({ id: row.id, rarity: cardRarity(row), god: isGod(row) }));
}

export function maxCopiesOf(card) {
  return card.god ? ECONOMY.maxGodCopies : ECONOMY.maxCopies;
}

// ---------------------------------------------------------------- state

export async function loadState(sql, userId) {
  const [wallets, cards, shards] = await Promise.all([
    sql`select coins, apples, starter_granted_at from player_wallets where user_id = ${userId}`,
    sql`select card_id, count, locked from player_cards where user_id = ${userId} and count > 0 order by card_id`,
    sql`select rarity, amount from player_shards where user_id = ${userId}`
  ]);
  const wallet = wallets[0];
  return {
    initialized: !!wallet,
    coins: wallet ? Number(wallet.coins) : 0,
    apples: wallet ? Number(wallet.apples) : 0,
    cards: Object.fromEntries(cards.map(r => [r.card_id, { count: Number(r.count), locked: Number(r.locked) }])),
    shards: Object.fromEntries(RARITIES.map(r => [r, Number(shards.find(s => s.rarity === r)?.amount || 0)]))
  };
}

/** First visit: starting coins, apples and the starter collection (locked). Safe to call repeatedly. */
export async function ensureStarter(sql, userId) {
  const created = await sql`
    insert into player_wallets (user_id, coins, apples, starter_granted_at)
    values (${userId}, ${ECONOMY.start.coins}, ${ECONOMY.start.apples}, now())
    on conflict (user_id) do nothing
    returning user_id
  `;
  if (created.length === 0) return false;
  const catalog = new Set((await loadCatalog(sql)).map(c => c.id));
  const starter = Object.entries(ECONOMY.starter).filter(([id]) => catalog.has(id)).map(([card_id, n]) => ({ card_id, n }));
  await sql`
    insert into player_cards (user_id, card_id, count, locked)
    select ${userId}, x.card_id, x.n, x.n from jsonb_to_recordset(${JSON.stringify(starter)}::jsonb) as x(card_id text, n int)
    on conflict (user_id, card_id) do update set count = greatest(player_cards.count, excluded.count), locked = greatest(player_cards.locked, excluded.locked)
  `;
  await sql`insert into economy_events (user_id, kind, detail) values (${userId}, 'starter', ${JSON.stringify({ ...ECONOMY.start, cards: ECONOMY.starter })}::jsonb)`;
  return true;
}

// ---------------------------------------------------------------- packs

function secureRandom() {
  return crypto.randomInt(0, 1_000_000) / 1_000_000;
}

export function rollRarity(odds, rand = secureRandom) {
  const entries = Object.entries(odds).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = rand() * total;
  for (const [rarity, w] of entries) {
    if (x < w) return rarity;
    x -= w;
  }
  return entries[entries.length - 1][0];
}

/**
 * Draws a pack. Returns the cards drawn, and for each whether it was added to the collection or turned into shards
 * (a card already owned the maximum number of times).
 */
export function drawPack(pack, catalog, owned, rand = secureRandom) {
  const byRarity = Object.fromEntries(RARITIES.map(r => [r, catalog.filter(c => c.rarity === r)]));
  const counts = Object.fromEntries(Object.entries(owned).map(([id, v]) => [id, v.count]));
  const results = [];
  for (const slot of pack.slots) {
    for (let i = 0; i < slot.count; i++) {
      let rarity = rollRarity(slot.odds, rand);
      // if a rarity has no cards at all, fall back to the nearest lower one that does
      let idx = RARITIES.indexOf(rarity);
      while (byRarity[RARITIES[idx]].length === 0 && idx > 0) idx--;
      rarity = RARITIES[idx];
      const pool = byRarity[rarity];
      if (pool.length === 0) continue;
      const card = pool[Math.floor(rand() * pool.length)];
      const have = counts[card.id] || 0;
      if (have >= maxCopiesOf(card)) {
        results.push({ cardId: card.id, rarity, shards: ECONOMY.shardsPerCard });
      } else {
        counts[card.id] = have + 1;
        results.push({ cardId: card.id, rarity, shards: 0, isNew: have === 0 });
      }
    }
  }
  return results;
}

function summarize(results) {
  const cardDeltas = {};
  const shardDeltas = {};
  for (const r of results) {
    if (r.shards > 0) shardDeltas[r.rarity] = (shardDeltas[r.rarity] || 0) + r.shards;
    else cardDeltas[r.cardId] = (cardDeltas[r.cardId] || 0) + 1;
  }
  return {
    cards: Object.entries(cardDeltas).map(([card_id, n]) => ({ card_id, n })),
    shards: Object.entries(shardDeltas).map(([rarity, n]) => ({ rarity, n }))
  };
}

/** Pays for and opens a pack in one atomic statement (nothing is added if the payment fails). */
export async function openPack(sql, userId, packId) {
  const pack = ECONOMY.packs.find(p => p.id === packId);
  if (!pack) throw httpError(400, "unknown_pack");
  const coins = pack.cost.coins || 0;
  const apples = pack.cost.apples || 0;
  const [catalog, state] = await Promise.all([loadCatalog(sql), loadState(sql, userId)]);
  if (state.coins < coins || state.apples < apples) throw httpError(402, "not_enough_currency");
  const results = drawPack(pack, catalog, state.cards);
  const { cards, shards } = summarize(results);
  const maxById = Object.fromEntries(catalog.map(c => [c.id, maxCopiesOf(c)]));
  const cardRows = cards.map(c => ({ ...c, max: maxById[c.card_id] }));
  const paid = await sql`
    with w as (
      update player_wallets set coins = coins - ${coins}, apples = apples - ${apples}, updated_at = now()
      where user_id = ${userId} and coins >= ${coins} and apples >= ${apples}
      returning coins, apples
    ),
    c as (
      insert into player_cards (user_id, card_id, count)
      select ${userId}, x.card_id, least(x.n, x.max) from w, jsonb_to_recordset(${JSON.stringify(cardRows)}::jsonb) as x(card_id text, n int, max int)
      on conflict (user_id, card_id) do update set count = least(player_cards.count + excluded.count, ${ECONOMY.maxCopies}), updated_at = now()
      returning 1
    ),
    s as (
      insert into player_shards (user_id, rarity, amount)
      select ${userId}, x.rarity, x.n from w, jsonb_to_recordset(${JSON.stringify(shards)}::jsonb) as x(rarity text, n int)
      on conflict (user_id, rarity) do update set amount = player_shards.amount + excluded.amount
      returning 1
    ),
    e as (
      insert into economy_events (user_id, kind, detail)
      select ${userId}, 'pack', ${JSON.stringify({ pack: packId, cost: pack.cost, results })}::jsonb from w
      returning 1
    )
    select coins, apples from w
  `;
  if (paid.length === 0) throw httpError(402, "not_enough_currency");
  return results;
}

// ---------------------------------------------------------------- disenchant / craft

export async function disenchant(sql, userId, cardId, amount) {
  const n = Math.max(1, Math.min(ECONOMY.maxCopies, Math.floor(Number(amount) || 1)));
  const catalog = await loadCatalog(sql);
  const card = catalog.find(c => c.id === cardId);
  if (!card) throw httpError(400, "unknown_card");
  const shards = n * ECONOMY.shardsPerCard;
  const done = await sql`
    with pc as (
      update player_cards set count = count - ${n}, updated_at = now()
      where user_id = ${userId} and card_id = ${cardId} and count - locked >= ${n}
      returning count
    ),
    s as (
      insert into player_shards (user_id, rarity, amount)
      select ${userId}, ${card.rarity}, ${shards} from pc
      on conflict (user_id, rarity) do update set amount = player_shards.amount + excluded.amount
      returning amount
    ),
    e as (
      insert into economy_events (user_id, kind, detail)
      select ${userId}, 'disenchant', ${JSON.stringify({ cardId, n, rarity: card.rarity, shards })}::jsonb from pc
      returning 1
    )
    select count from pc
  `;
  if (done.length === 0) throw httpError(400, "cannot_disenchant");
  return { rarity: card.rarity, shards };
}

export async function craft(sql, userId, cardId) {
  const catalog = await loadCatalog(sql);
  const card = catalog.find(c => c.id === cardId);
  if (!card) throw httpError(400, "unknown_card");
  const cost = ECONOMY.craftCost;
  const max = maxCopiesOf(card);
  const done = await sql`
    with owned as (
      select coalesce((select count from player_cards where user_id = ${userId} and card_id = ${cardId}), 0) as n
    ),
    s as (
      update player_shards set amount = amount - ${cost}
      where user_id = ${userId} and rarity = ${card.rarity} and amount >= ${cost} and (select n from owned) < ${max}
      returning amount
    ),
    pc as (
      insert into player_cards (user_id, card_id, count)
      select ${userId}, ${cardId}, 1 from s
      on conflict (user_id, card_id) do update set count = player_cards.count + 1, updated_at = now()
      returning count
    ),
    e as (
      insert into economy_events (user_id, kind, detail)
      select ${userId}, 'craft', ${JSON.stringify({ cardId, rarity: card.rarity, cost })}::jsonb from s
      returning 1
    )
    select amount from s
  `;
  if (done.length === 0) throw httpError(400, "cannot_craft");
  return { rarity: card.rarity };
}

// ---------------------------------------------------------------- match rewards

export async function rewardMatch(sql, userId, body) {
  const mode = body.mode === "online" ? "online" : "ai";
  const result = body.result === "win" ? "win" : "lose";
  const turns = Math.floor(Number(body.turns) || 0);
  const matchKey = String(body.matchKey || "").slice(0, 80);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(matchKey)) throw httpError(400, "bad_match_key");
  if (turns < ECONOMY.rewardMinTurns) return { coins: 0, reason: "too_short" };
  if (mode === "ai") {
    const recent = await sql`
      select 1 from match_rewards
      where user_id = ${userId} and mode = 'ai' and created_at > now() - make_interval(secs => ${ECONOMY.aiRewardCooldownSeconds})
      limit 1
    `;
    if (recent.length > 0) return { coins: 0, reason: "too_fast" };
  }
  const coins = ECONOMY.rewards[mode][result];
  const done = await sql`
    with r as (
      insert into match_rewards (user_id, match_key, mode, result, coins)
      values (${userId}, ${matchKey}, ${mode}, ${result}, ${coins})
      on conflict (user_id, match_key) do nothing
      returning coins
    ),
    w as (
      update player_wallets set coins = coins + (select coins from r), updated_at = now()
      where user_id = ${userId} and exists (select 1 from r)
      returning coins
    ),
    e as (
      insert into economy_events (user_id, kind, detail)
      select ${userId}, 'reward', ${JSON.stringify({ mode, result, turns, matchKey, coins })}::jsonb from r
      returning 1
    )
    select coins from w
  `;
  if (done.length === 0) return { coins: 0, reason: "already_rewarded" };
  return { coins };
}

// ---------------------------------------------------------------- admin

export async function adminGrant(sql, userId, body) {
  const coins = Math.max(0, Math.min(1_000_000, Math.floor(Number(body.coins) || 0)));
  const apples = Math.max(0, Math.min(100_000, Math.floor(Number(body.apples) || 0)));
  await sql`update player_wallets set coins = coins + ${coins}, apples = apples + ${apples}, updated_at = now() where user_id = ${userId}`;
  await sql`insert into economy_events (user_id, kind, detail) values (${userId}, 'admin_grant', ${JSON.stringify({ coins, apples })}::jsonb)`;
}

// ---------------------------------------------------------------- decks

/** Card ids in a deck that the player does not own often enough (empty = the deck is fine). */
export async function deckOwnershipProblems(sql, userId, counts) {
  await ensureStarter(sql, userId);
  const state = await loadState(sql, userId);
  return Object.entries(counts).filter(([id, n]) => (state.cards[id]?.count || 0) < n).map(([id]) => id);
}

export function publicConfig() {
  return {
    version: ECONOMY.version,
    start: ECONOMY.start,
    maxCopies: ECONOMY.maxCopies,
    maxGodCopies: ECONOMY.maxGodCopies,
    shardsPerCard: ECONOMY.shardsPerCard,
    craftCost: ECONOMY.craftCost,
    starter: ECONOMY.starter,
    rewards: ECONOMY.rewards,
    rewardMinTurns: ECONOMY.rewardMinTurns,
    packs: ECONOMY.packs
  };
}

export { db };
