import { db } from "./_lib/db.mjs";
import { requireUser } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";
import { rateLimit } from "./_lib/ratelimit.mjs";
import { ECONOMY, deckOwnershipProblems, httpError, maxDecks } from "./_lib/economy.mjs";

/**
 * Saved decks. A player keeps up to ECONOMY.decks.free decks (more with bought slots); a deck may be an unfinished
 * draft, and exactly one complete deck is active (the one played with).
 *   GET  /deck                       the active deck's counts (app versions before 0.0.8)
 *   GET  /deck?all=1                 { decks: [{id, name, active, complete, counts, updatedAt}], slots: {free, bought, max} }
 *   PUT  /deck {counts}              replace the active deck (app versions before 0.0.8; the deck must be complete)
 *   POST /deck {action: "save", id?, name, counts, activate?}   create (no id) or update a deck, drafts allowed
 *   POST /deck {action: "activate", id}                        play with this deck (it must be complete)
 *   POST /deck {action: "delete", id}
 * Every POST answers with the full list, as GET ?all=1 does.
 */

const DECK_MIN_SIZE = 30;
const DECK_MAX_SIZE = 40;
const DECK_MAX_COPIES = 4;
const MAX_GODS = 3;
const MIN_GODS = 1;
const NAME_MAX = 24;

function normalizeCounts(counts) {
  const result = {};
  for (const [cardId, raw] of Object.entries(counts || {})) {
    const quantity = Math.max(0, Math.min(DECK_MAX_COPIES, Math.round(Number(raw || 0))));
    if (quantity) result[cardId] = quantity;
  }
  return result;
}

// Gods (cards with payload.god = true) are a side selection of 1-3 and do not count toward the 30-40 deck size.
function deckShape(counts, godIds) {
  let size = 0;
  let gods = 0;
  for (const [cardId, value] of Object.entries(counts)) {
    if (godIds.has(cardId)) gods += 1;
    else size += value;
  }
  return { size, gods };
}

const isComplete = ({ size, gods }) => size >= DECK_MIN_SIZE && size <= DECK_MAX_SIZE && gods >= MIN_GODS && gods <= MAX_GODS;

/** Checks the cards (known, owned, within the limits) and returns the cleaned counts with the deck's shape. */
async function checkCards(sql, userId, rawCounts) {
  const counts = normalizeCounts(rawCounts);
  const cardIds = Object.keys(counts);
  const rows = cardIds.length === 0 ? [] : await sql`
    select id, coalesce((payload->>'god')::boolean, false) as god
    from cards
    where id = any(${cardIds}) and active = true
  `;
  const existing = new Set(rows.map(row => row.id));
  if (cardIds.some(id => !existing.has(id))) throw httpError(400, "unknown_card");
  const godIds = new Set(rows.filter(row => row.god).map(row => row.id));
  for (const id of godIds) counts[id] = 1;
  const shape = deckShape(counts, godIds);
  // a draft may be short, but never over the limits
  if (shape.size > DECK_MAX_SIZE || shape.gods > MAX_GODS) throw httpError(400, "invalid_deck");
  // decks are built from the player's own collection
  const missing = await deckOwnershipProblems(sql, userId, counts);
  if (missing.length > 0) {
    const err = httpError(400, "cards_not_owned");
    err.extra = { cards: missing };
    throw err;
  }
  return { counts, shape };
}

async function godIdsOf(sql) {
  const rows = await sql`select id from cards where active = true and coalesce((payload->>'god')::boolean, false)`;
  return new Set(rows.map(r => r.id));
}

async function listDecks(sql, userId) {
  const [decks, cards, wallets, godIds] = await Promise.all([
    sql`select id, name, is_active, position, updated_at from user_decks where user_id = ${userId} order by position, created_at`,
    sql`
      select c.deck_id, c.card_id, c.quantity
      from user_deck_cards c join user_decks d on d.id = c.deck_id
      where d.user_id = ${userId}
    `,
    sql`select deck_slots from player_wallets where user_id = ${userId}`,
    godIdsOf(sql)
  ]);
  const bought = Number(wallets[0]?.deck_slots || 0);
  return {
    decks: decks.map(d => {
      const counts = Object.fromEntries(cards.filter(c => c.deck_id === d.id).map(c => [c.card_id, Number(c.quantity)]));
      return { id: d.id, name: d.name, active: d.is_active, complete: isComplete(deckShape(counts, godIds)), counts, updatedAt: d.updated_at };
    }),
    slots: { free: ECONOMY.decks.free, bought, max: maxDecks(bought), extraMax: ECONOMY.decks.extraMax, extraApples: ECONOMY.decks.extraApples }
  };
}

async function writeCards(sql, deckId, counts) {
  const entries = Object.entries(counts).map(([card_id, quantity]) => ({ card_id, quantity }));
  await sql`delete from user_deck_cards where deck_id = ${deckId}`;
  if (entries.length === 0) return;
  await sql`
    insert into user_deck_cards (deck_id, card_id, quantity)
    select ${deckId}, x.card_id, x.quantity from jsonb_to_recordset(${JSON.stringify(entries)}::jsonb) as x(card_id text, quantity int)
  `;
}

/** Makes one deck the active one (and no other). */
async function activate(sql, userId, deckId) {
  await sql`update user_decks set is_active = false where user_id = ${userId} and is_active and id <> ${deckId}`;
  await sql`update user_decks set is_active = true where user_id = ${userId} and id = ${deckId}`;
}

function cleanName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}

async function saveDeck(sql, userId, body) {
  const name = cleanName(body.name);
  if (!name) throw httpError(400, "name_required");
  const { counts, shape } = await checkCards(sql, userId, body.counts);
  let deckId = body.id ? String(body.id) : null;

  const [taken] = await sql`select id from user_decks where user_id = ${userId} and name = ${name} and id::text <> ${deckId || ""}`;
  if (taken) throw httpError(409, "name_taken");

  if (deckId) {
    const [deck] = await sql`select id, is_active from user_decks where id::text = ${deckId} and user_id = ${userId}`;
    if (!deck) throw httpError(404, "deck_not_found");
    // the deck played with can never become incomplete
    if (deck.is_active && !isComplete(shape)) throw httpError(400, "active_incomplete");
    await sql`update user_decks set name = ${name} where id = ${deck.id}`;
  } else {
    const [{ n }] = await sql`select count(*)::int as n from user_decks where user_id = ${userId}`;
    const [wallet] = await sql`select deck_slots from player_wallets where user_id = ${userId}`;
    if (n >= maxDecks(wallet?.deck_slots)) throw httpError(409, "deck_limit");
    const [{ next }] = await sql`select coalesce(max(position), -1) + 1 as next from user_decks where user_id = ${userId}`;
    const created = await sql`
      insert into user_decks (user_id, name, is_active, position)
      values (${userId}, ${name}, false, ${next})
      returning id
    `;
    deckId = created[0].id;
  }
  await writeCards(sql, deckId, counts);
  // the first complete deck becomes the active one, and so does any deck saved with "activate"
  const [active] = await sql`select id from user_decks where user_id = ${userId} and is_active`;
  if (isComplete(shape) && (body.activate === true || !active)) await activate(sql, userId, deckId);
  return deckId;
}

/** App versions before 0.0.8: one deck, replaced as a whole (it must be complete). */
async function legacyPut(sql, userId, body) {
  const { counts, shape } = await checkCards(sql, userId, body.counts);
  if (shape.size < DECK_MIN_SIZE) throw httpError(400, "invalid_deck");
  let [deck] = await sql`select id from user_decks where user_id = ${userId} and is_active`;
  if (!deck) {
    const [existing] = await sql`select id from user_decks where user_id = ${userId} and name = 'Default'`;
    deck = existing || (await sql`insert into user_decks (user_id, name, is_active) values (${userId}, 'Default', false) returning id`)[0];
    await activate(sql, userId, deck.id);
  }
  await writeCards(sql, deck.id, counts);
  return counts;
}

export async function handler(event) {
  try {
    const user = await requireUser(event);
    const sql = db();

    if (event.httpMethod === "GET") {
      if (event.queryStringParameters?.all) return json(200, await listDecks(sql, user.id));
      const rows = await sql`
        select c.card_id, c.quantity
        from user_decks d
        join user_deck_cards c on c.deck_id = d.id
        where d.user_id = ${user.id} and d.is_active
        order by c.card_id
      `;
      const counts = Object.fromEntries(rows.map(row => [row.card_id, Number(row.quantity)]));
      return json(200, { counts });
    }

    if (event.httpMethod !== "PUT" && event.httpMethod !== "POST") return methodNotAllowed(["GET", "PUT", "POST"]);
    await rateLimit("deck", user.id, sql);
    const body = await readJson(event);

    if (event.httpMethod === "PUT") {
      const counts = await legacyPut(sql, user.id, body);
      return json(200, { ok: true, counts });
    }

    let id = null;
    switch (body.action) {
      case "save":
        id = await saveDeck(sql, user.id, body);
        break;
      case "activate": {
        const deckId = String(body.id || "");
        const list = await listDecks(sql, user.id);
        const deck = list.decks.find(d => d.id === deckId);
        if (!deck) throw httpError(404, "deck_not_found");
        if (!deck.complete) throw httpError(400, "deck_incomplete");
        await activate(sql, user.id, deckId);
        id = deckId;
        break;
      }
      case "delete": {
        const deckId = String(body.id || "");
        const removed = await sql`delete from user_decks where id::text = ${deckId} and user_id = ${user.id} returning is_active`;
        if (removed.length === 0) throw httpError(404, "deck_not_found");
        // the active deck is gone: play with the most recently saved complete deck, if there is one
        if (removed[0].is_active) {
          const list = await listDecks(sql, user.id);
          const next = list.decks.filter(d => d.complete).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
          if (next) await activate(sql, user.id, next.id);
        }
        break;
      }
      default:
        throw httpError(400, "unknown_action");
    }
    return json(200, { id, ...(await listDecks(sql, user.id)) });
  } catch (error) {
    if (error?.extra && error.statusCode) return json(error.statusCode, { error: error.publicCode, ...error.extra });
    return handleError(error);
  }
}
