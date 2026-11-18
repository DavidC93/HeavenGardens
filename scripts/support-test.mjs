// Support messages and the ranked-game log, against a TEST database branch (never production):
//   DATABASE_URL=<test branch> node scripts/support-test.mjs
import { neon } from "@neondatabase/serverless";
import { readRequest, plain } from "../netlify/functions/support.mjs";

const sql = neon(process.env.DATABASE_URL);
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };
const code = body => { try { readRequest(body); return null; } catch (e) { return e.publicCode; } };

check("a name is required", code({ name: "a", message: "hello there" }) === "bad_name");
check("an email must look like one", code({ name: "Dan", email: "not-an-email", message: "hello there" }) === "bad_email");
check("a script tag is not an email", code({ name: "Dan", email: "<script>@x.com", message: "hello there" }) === "bad_email");
check("a too short message is refused", code({ name: "Dan", message: "hi" }) === "message_too_short");
check("a huge message is refused", code({ name: "Dan", message: "x".repeat(5000) }) === "message_too_long");
const r = readRequest({ name: "Dan\u0000\u0007 <b>", email: "", message: "line1\r\nline2\u0000\n\n\n\nline3 " + "y".repeat(600) });
check("control characters are dropped, the email is optional", r.name === "Dan <b>" && r.email === null);
check("the message keeps its lines, is capped at 500", r.message.startsWith("line1\nline2\n\nline3") && r.message.length === 500);
check("tags stay plain text (shown as letters by the back office)", plain("<img src=x onerror=alert(1)>", 100) === "<img src=x onerror=alert(1)>");

try {
  // stored only as parameters: a quote or SQL in the text is just text
  const evil = "Robert'); drop table support_requests;--";
  const [row] = await sql`insert into support_requests (name, message) values (${evil}, ${evil}) returning id, name`;
  check("SQL in a message is stored as text", row.name === evil);
  const [{ n }] = await sql`select count(*)::int as n from support_requests`;
  check("the table is still there", n >= 1);
  await sql`delete from support_requests where id = ${row.id}`;
} catch (e) { console.error(e); failed++; }
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
