import { db } from "./_lib/db.mjs";
import { requireUser } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";
import { deckOwnershipProblems } from "./_lib/economy.mjs";

const DECK_MIN_SIZE = 30;
const DECK_MAX_SIZE = 40;
const DECK_MAX_COPIES = 4;
const MAX_GODS = 3;

function normalizeCounts(counts) {
  const result = {};
  for (const [cardId, raw] of Object.entries(counts || {})) {
    const quantity = Math.max(0, Math.min(DECK_MAX_COPIES, Math.round(Number(raw || 0))));
    if (quantity) result[cardId] = quantity;
  }
  return result;
}

// Gods (cards with payload.god = true) are a side selection of up to 3 and do not count toward the 30-40 deck size.
function validateCounts(counts, godIds) {
  let size = 0;
  let gods = 0;
  for (const [cardId, value] of Object.entries(counts)) {
    if (godIds.has(cardId)) gods += 1;
    else size += value;
  }
  return size >= DECK_MIN_SIZE && size <= DECK_MAX_SIZE && gods <= MAX_GODS && Object.values(counts).every(value => value <= DECK_MAX_COPIES);
}

export async function handler(event) {
  try {
    const user = await requireUser(event);
    const sql = db();

    if (event.httpMethod === "GET") {
      const rows = await sql`
        select c.card_id, c.quantity
        from user_decks d
        join user_deck_cards c on c.deck_id = d.id
        where d.user_id = ${user.id}
          and d.name = 'Default'
        order by c.card_id
      `;
      const counts = Object.fromEntries(rows.map(row => [row.card_id, Number(row.quantity)]));
      return json(200, { counts });
    }

    if (event.httpMethod !== "PUT") return methodNotAllowed(["GET", "PUT"]);

    const body = await readJson(event);
    const counts = normalizeCounts(body.counts);

    const cardIds = Object.keys(counts);
    const existingRows = await sql`
      select id, coalesce((payload->>'god')::boolean, false) as god
      from cards
      where id = any(${cardIds}) and active = true
    `;
    const existing = new Set(existingRows.map(row => row.id));
    if (cardIds.some(id => !existing.has(id))) return json(400, { error: "unknown_card" });
    const godIds = new Set(existingRows.filter(row => row.god).map(row => row.id));
    for (const id of godIds) counts[id] = 1;
    if (!validateCounts(counts, godIds)) return json(400, { error: "invalid_deck" });
    // decks are built from the player's own collection
    const missing = await deckOwnershipProblems(sql, user.id, counts);
    if (missing.length > 0) return json(400, { error: "cards_not_owned", cards: missing });

    const deckRows = await sql`
      insert into user_decks (user_id, name, is_active)
      values (${user.id}, 'Default', true)
      on conflict (user_id, name) do update set is_active = true
      returning id
    `;

    const deckId = deckRows[0].id;
    await sql`delete from user_deck_cards where deck_id = ${deckId}`;
    for (const [cardId, quantity] of Object.entries(counts)) {
      await sql`
        insert into user_deck_cards (deck_id, card_id, quantity)
        values (${deckId}, ${cardId}, ${quantity})
      `;
    }

    return json(200, { ok: true, counts });
  } catch (error) {
    return handleError(error);
  }
}

