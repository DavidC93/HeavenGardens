import { db } from "./_lib/db.mjs";
import { currentUser } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";
import { clientIp, rateLimit } from "./_lib/ratelimit.mjs";

/**
 * A message to support from the game's help screen (signed in or not).
 *   POST { name, email?, message, appVersion?, platform?, device?, language? }  ->  { ok: true, id }
 *
 * Everything typed is treated as plain text: control characters are dropped, lengths are capped, the email must look
 * like one. Values only ever reach the database as query parameters and the back office as text, never as HTML.
 */
export const LIMITS = { name: 40, email: 120, message: 500 };
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

/** Plain text: no control characters (line breaks kept in the message), trimmed, capped. */
export function plain(value, max, multiline = false) {
  let s = String(value ?? "").normalize("NFC");
  s = multiline ? s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n")
                : s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ");
  return s.trim().slice(0, max);
}

export function readRequest(body) {
  const bad = code => { const e = new Error(code); e.statusCode = 400; e.publicCode = code; return e; };
  const name = plain(body.name, LIMITS.name);
  const email = plain(body.email, LIMITS.email);
  const message = plain(body.message, LIMITS.message, true);
  if (name.length < 2) throw bad("bad_name");
  if (email && !EMAIL.test(email)) throw bad("bad_email");
  if (message.length < 5) throw bad("message_too_short");
  // anything longer than allowed was cut above; a client that sends far more is not ours
  if (String(body.message ?? "").length > LIMITS.message * 4) throw bad("message_too_long");
  return {
    name, email: email || null, message,
    appVersion: plain(body.appVersion, 40) || null, platform: plain(body.platform, 20) || null,
    device: plain(body.device, 120) || null, language: plain(body.language, 20) || null,
  };
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return methodNotAllowed(["POST"]);
    const sql = db();
    await rateLimit("support", clientIp(event), sql);
    const r = readRequest(await readJson(event));
    let userId = null;
    try { userId = (await currentUser(event))?.id || null; } catch { /* guests write too */ }
    const [row] = await sql`
      insert into support_requests (user_id, name, email, message, app_version, platform, device, language)
      values (${userId}, ${r.name}, ${r.email}, ${r.message}, ${r.appVersion}, ${r.platform}, ${r.device}, ${r.language})
      returning id
    `;
    return json(200, { ok: true, id: Number(row.id) });
  } catch (error) {
    return handleError(error);
  }
}
