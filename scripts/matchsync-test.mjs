// The match mailbox against a TEST database branch (never production):
//   DATABASE_URL=<test branch> node scripts/matchsync-test.mjs
import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";
import { exchange, readRequest } from "../netlify/functions/match-sync.mjs";

const sql = neon(process.env.DATABASE_URL);
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };
const id = crypto.createHash("sha256").update("test-" + Date.now()).digest("hex");
const bad = body => { try { readRequest(body); return false; } catch (e) { return e.publicCode === "bad_request"; } };

try {
  check("a made-up mailbox id is refused", bad({ id: "abc", seat: 0, ack: 0 }));
  check("only seats 0 and 1 exist", bad({ id, seat: 2, ack: 0 }));
  check("too many messages at once are refused", bad({ id, seat: 0, ack: 0, msgs: Array.from({ length: 41 }, (_, k) => ({ i: k + 1, m: {} })) }));
  check("an oversized message is refused", bad({ id, seat: 0, ack: 0, msgs: [{ i: 1, m: { x: "y".repeat(2000) } }] }));

  let a = await exchange(sql, readRequest({ id, seat: 0, ack: 0, msgs: [{ i: 1, m: { t: "cmd", mi: 1 } }, { i: 2, m: { t: "hash", mi: 2 } }] }));
  check("the first visit: nothing from the other player, who was never here", a.msgs.length === 0 && a.seen === null && a.ack === 0);

  let b = await exchange(sql, readRequest({ id, seat: 1, ack: 0, msgs: [] }));
  check("the other player gets both messages, in order", b.msgs.length === 2 && b.msgs[0].i === 1 && b.msgs[1].m.t === "hash");
  check("and sees the first player was just here", b.seen !== null && b.seen < 30);

  b = await exchange(sql, readRequest({ id, seat: 1, ack: 2, msgs: [{ i: 1, m: { t: "cmd", mi: 1, a: 5 } }] }));
  check("acknowledged messages are not sent again", b.msgs.length === 0);

  a = await exchange(sql, readRequest({ id, seat: 0, ack: 0, msgs: [{ i: 1, m: { t: "changed" } }] }));
  check("the first player learns how far the other got, and gets their message", a.ack === 2 && a.msgs.length === 1 && a.msgs[0].m.a === 5);

  b = await exchange(sql, readRequest({ id, seat: 1, ack: 0, msgs: [] }));
  check("a stored message never changes when it is sent again", b.msgs[0].m.t === "cmd");
  check("an acknowledgement never goes backwards", (await exchange(sql, readRequest({ id, seat: 0, ack: 1, msgs: [] }))).ack === 2);

  const other = crypto.createHash("sha256").update("other-" + Date.now()).digest("hex");
  check("another match sees none of it", (await exchange(sql, readRequest({ id: other, seat: 1, ack: 0, msgs: [] }))).msgs.length === 0);
  await sql`delete from match_sync_msgs where id in (${id}, ${other})`;
  await sql`delete from match_sync_seats where id in (${id}, ${other})`;
} catch (e) { console.error(e); failed++; }
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
