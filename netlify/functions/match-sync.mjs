import { db } from "./_lib/db.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";
import { clientIp, rateLimit } from "./_lib/ratelimit.mjs";

/**
 * The mailbox of an online match. The two phones talk directly (Unity Relay); when that connection breaks (a minimised
 * app, a few seconds without internet, a change of network) they keep the game going through here instead.
 *
 *   POST { id, seat, ack, msgs: [{ i, m }] }  ->  { msgs: [{ i, m }], ack, seen }
 *
 * id    the match's mailbox: a hash only its two phones can compute (guests play online too, so there is no login)
 * seat  0 (host) or 1 (guest)
 * ack   how many of the other player's messages I already have: I get the ones after it
 * msgs  my new messages, numbered; a number that is already stored is ignored (resending is harmless)
 * Answer: the other player's messages, how many of mine they have, and how many seconds ago they were last here
 * (null when never), which is how a phone knows its opponent is still around.
 */
const MAX_MESSAGES = 40, MAX_NUMBER = 4000, MAX_LENGTH = 1500;

export function readRequest(body) {
  const bad = () => { const e = new Error("Bad mailbox request"); e.statusCode = 400; e.publicCode = "bad_request"; return e; };
  const id = String(body.id || "");
  const seat = Number(body.seat), ack = Number(body.ack ?? 0);
  if (!/^[0-9a-f]{64}$/.test(id) || (seat !== 0 && seat !== 1)) throw bad();
  if (!Number.isInteger(ack) || ack < 0 || ack > MAX_NUMBER) throw bad();
  const list = Array.isArray(body.msgs) ? body.msgs : [];
  if (list.length > MAX_MESSAGES) throw bad();
  const msgs = list.map(x => {
    const i = Number(x?.i);
    if (!Number.isInteger(i) || i < 1 || i > MAX_NUMBER || x.m == null || typeof x.m !== "object" || Array.isArray(x.m)) throw bad();
    if (JSON.stringify(x.m).length > MAX_LENGTH) throw bad();
    return { i, m: x.m };
  });
  return { id, seat, ack, msgs };
}

export async function exchange(sql, { id, seat, ack, msgs }) {
  const other = 1 - seat;
  const [row] = await sql`
    with stored as (
      insert into match_sync_msgs (id, seat, i, msg)
      select ${id}, ${seat}, x.i, x.m from jsonb_to_recordset(${JSON.stringify(msgs)}::jsonb) as x(i int, m jsonb)
      on conflict do nothing
    ), me as (
      insert into match_sync_seats (id, seat, ack, seen_at) values (${id}, ${seat}, ${ack}, now())
      on conflict (id, seat) do update set ack = greatest(match_sync_seats.ack, excluded.ack), seen_at = now()
    )
    select
      (select coalesce(jsonb_agg(jsonb_build_object('i', t.i, 'm', t.msg) order by t.i), '[]'::jsonb)
         from (select i, msg from match_sync_msgs where id = ${id} and seat = ${other} and i > ${ack} order by i limit 60) t) as msgs,
      (select s.ack from match_sync_seats s where s.id = ${id} and s.seat = ${other}) as ack,
      (select extract(epoch from now() - s.seen_at)::float8 from match_sync_seats s where s.id = ${id} and s.seat = ${other}) as seen
  `;
  return { msgs: row.msgs, ack: Number(row.ack || 0), seen: row.seen == null ? null : Math.max(0, Number(row.seen)) };
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return methodNotAllowed(["POST"]);
    const sql = db();
    const request = readRequest(await readJson(event));
    // both run together: the limit must not slow a round trip down
    const [reply] = await Promise.all([exchange(sql, request), rateLimit("matchSync", clientIp(event), sql)]);
    if (Math.random() < 0.01) {
      await sql`delete from match_sync_msgs where created_at < now() - interval '1 day'`;
      await sql`delete from match_sync_seats where seen_at < now() - interval '1 day'`;
    }
    return json(200, reply);
  } catch (error) {
    return handleError(error);
  }
}
