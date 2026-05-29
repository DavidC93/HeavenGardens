import { db } from "./_lib/db.mjs";
import { requireUser } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";

const DECK_MIN_SIZE = 30;
const DECK_MAX_SIZE = 40;
const DECK_MAX_COPIES = 4;

function normalizeCounts(counts) {
  const result = {};
  for (const [cardId, raw] of Object.entries(counts || {})) {
    const quantity = Math.max(0, Math.min(DECK_MAX_COPIES, Math.round(Number(raw || 0))));
    if (quantity) result[cardId] = quantity;
  }
  return result;
}

function validateCounts(counts) {
  const size = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return size >= DECK_MIN_SIZE && size <= DECK_MAX_SIZE && Object.values(counts).every(value => value <= DECK_MAX_COPIES);
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
    if (!validateCounts(counts)) return json(400, { error: "invalid_deck" });

    const cardIds = Object.keys(counts);
    const existingRows = await sql`select id from cards where id = any(${cardIds}) and active = true`;
    const existing = new Set(existingRows.map(row => row.id));
    if (cardIds.some(id => !existing.has(id))) return json(400, { error: "unknown_card" });

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

