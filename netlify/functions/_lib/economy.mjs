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
  // golden apples for real money (Google Play one-time products; the store shows its own local prices,
  // usd is only a fallback label)
  appleProducts: [
    { id: "apples_60", apples: 60, usd: "0.99" },
    { id: "apples_330", apples: 330, usd: "4.99" },
    { id: "apples_700", apples: 700, usd: "9.99" },
    { id: "apples_1500", apples: 1500, usd: "19.99" }
  ],
  // "watch an ad to double the reward": at most this many per player in 24 hours
  adDoubleDailyLimit: 10,
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
 * (a card already owned the maximum number of times). A pack never holds the same card twice.
 */
export function drawPack(pack, catalog, owned, rand = secureRandom) {
  const byRarity = Object.fromEntries(RARITIES.map(r => [r, catalog.filter(c => c.rarity === r)]));
  const counts = Object.fromEntries(Object.entries(owned).map(([id, v]) => [id, v.count]));
  const inPack = new Set();
  const available = r => byRarity[r].filter(c => !inPack.has(c.id));
  const results = [];
  for (const slot of pack.slots) {
    for (let i = 0; i < slot.count; i++) {
      const rolled = RARITIES.indexOf(rollRarity(slot.odds, rand));
      // a rarity with no card left for this pack falls back to the nearest lower one, then to a higher one
      let idx = rolled;
      while (idx > 0 && available(RARITIES[idx]).length === 0) idx--;
      if (available(RARITIES[idx]).length === 0) {
        idx = rolled;
        while (idx < RARITIES.length - 1 && available(RARITIES[idx]).length === 0) idx++;
      }
      const rarity = RARITIES[idx];
      const pool = available(rarity);
      if (pool.length === 0) continue;
      const card = pool[Math.floor(rand() * pool.length)];
      inPack.add(card.id);
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

// ---------------------------------------------------------------- golden apples for money

/**
 * Credits a store purchase that Google has confirmed. The purchase token is the key, so retries and replays pay
 * nothing more; a token already used by another account is refused.
 */
export async function grantPurchase(sql, userId, { productId, purchaseToken, orderId = null, store = "google_play" }) {
  const product = ECONOMY.appleProducts.find(p => p.id === productId);
  if (!product) throw httpError(400, "unknown_product");
  const done = await sql`
    with p as (
      insert into iap_purchases (purchase_token, user_id, store, product_id, order_id, apples)
      values (${purchaseToken}, ${userId}, ${store}, ${productId}, ${orderId}, ${product.apples})
      on conflict (purchase_token) do nothing
      returning apples
    ),
    w as (
      update player_wallets set apples = apples + (select apples from p), updated_at = now()
      where user_id = ${userId} and exists (select 1 from p)
      returning apples
    ),
    e as (
      insert into economy_events (user_id, kind, detail)
      select ${userId}, 'purchase', ${JSON.stringify({ productId, orderId, apples: product.apples, store })}::jsonb from p
      returning 1
    )
    select apples from w
  `;
  if (done.length > 0) return { apples: product.apples, granted: true };
  const [existing] = await sql`select user_id from iap_purchases where purchase_token = ${purchaseToken}`;
  if (existing && existing.user_id !== userId) throw httpError(409, "purchase_used");
  return { apples: product.apples, granted: false };
}

// ---------------------------------------------------------------- ad: double a match reward

async function adsToday(sql, userId) {
  const [row] = await sql`
    select count(*)::int as n from ad_rewards where user_id = ${userId} and claimed_at > now() - interval '24 hours'
  `;
  return row.n;
}

/**
 * Before showing the ad: checks the match paid a reward that has not been doubled and the daily limit, and returns
 * the nonce the app passes to AdMob as custom data (it comes back in the signed callback).
 */
export async function startAdDouble(sql, userId, matchKey) {
  const key = String(matchKey || "").slice(0, 80);
  const [reward] = await sql`select coins from match_rewards where user_id = ${userId} and match_key = ${key}`;
  if (!reward || Number(reward.coins) <= 0) throw httpError(400, "no_reward");
  if (await adsToday(sql, userId) >= ECONOMY.adDoubleDailyLimit) throw httpError(429, "ad_limit");
  const nonce = crypto.randomBytes(18).toString("base64url");
  const rows = await sql`
    insert into ad_rewards (nonce, user_id, match_key, coins)
    values (${nonce}, ${userId}, ${key}, ${Number(reward.coins)})
    on conflict (user_id, match_key) do update set nonce = ad_rewards.nonce
    returning nonce, coins, claimed_at, verified_at
  `;
  const r = rows[0];
  if (r.claimed_at) throw httpError(409, "already_doubled");
  // the ad was already watched for this match but not claimed: keep that nonce
  return { nonce: r.nonce, coins: Number(r.coins), verified: !!r.verified_at };
}

/** AdMob's signed callback said the ad was watched to the end. */
export async function verifyAdDouble(sql, nonce, userId, transactionId) {
  const rows = await sql`
    update ad_rewards set verified_at = now(), transaction_id = ${transactionId}
    where nonce = ${String(nonce || "")} and user_id::text = ${String(userId || "")} and verified_at is null
    returning nonce
  `;
  return rows.length > 0;
}

/** After the ad: pays the extra coins once, if AdMob has confirmed it (409 ad_not_verified: try again shortly). */
export async function claimAdDouble(sql, userId, nonce) {
  const [row] = await sql`select verified_at, claimed_at from ad_rewards where nonce = ${String(nonce || "")} and user_id = ${userId}`;
  if (!row) throw httpError(400, "unknown_ad");
  if (row.claimed_at) throw httpError(409, "already_doubled");
  if (!row.verified_at) throw httpError(409, "ad_not_verified");
  if (await adsToday(sql, userId) >= ECONOMY.adDoubleDailyLimit) throw httpError(429, "ad_limit");
  const done = await sql`
    with a as (
      update ad_rewards set claimed_at = now()
      where nonce = ${nonce} and user_id = ${userId} and verified_at is not null and claimed_at is null
      returning coins, match_key
    ),
    w as (
      update player_wallets set coins = coins + (select coins from a), updated_at = now()
      where user_id = ${userId} and exists (select 1 from a)
      returning coins
    ),
    e as (
      insert into economy_events (user_id, kind, detail)
      select ${userId}, 'ad_double', jsonb_build_object('matchKey', a.match_key, 'coins', a.coins) from a
      returning 1
    )
    select coins from a
  `;
  if (done.length === 0) throw httpError(409, "already_doubled");
  return { coins: Number(done[0].coins) };
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
    packs: ECONOMY.packs,
    appleProducts: ECONOMY.appleProducts,
    adDoubleDailyLimit: ECONOMY.adDoubleDailyLimit
  };
}

export { db };
