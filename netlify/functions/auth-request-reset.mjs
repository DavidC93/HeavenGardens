import { db } from "./_lib/db.mjs";
import { normalizeEmail, randomToken, sha256 } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";

async function sendResetEmail({ email, resetUrl }) {
  if (!process.env.RESEND_API_KEY || !process.env.PASSWORD_RESET_FROM) return false;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.PASSWORD_RESET_FROM,
      to: email,
      subject: "Heaven Gardens password reset",
      html: `<p>לחץ על הקישור כדי לאפס סיסמה:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>הקישור תקף לשעה.</p>`
    })
  });

  if (!response.ok) {
    console.error("Resend failed", response.status, await response.text());
    return false;
  }

  return true;
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return methodNotAllowed(["POST"]);

    const body = await readJson(event);
    const email = normalizeEmail(body.email);
    const sql = db();
    const rows = await sql`select id, email from app_users where email = ${email} limit 1`;
    const user = rows[0];
    if (!user) return json(200, { ok: true });

    const token = randomToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await sql`
      insert into password_reset_tokens (user_id, token_hash, expires_at)
      values (${user.id}, ${sha256(token)}, ${expiresAt.toISOString()})
    `;

    const origin = event.headers.origin || process.env.SITE_URL || "https://heaven-gardens.netlify.app";
    const resetUrl = `${origin}/legacy-card-battle.html?resetToken=${encodeURIComponent(token)}`;
    const emailSent = await sendResetEmail({ email: user.email, resetUrl });
    const devFallback = !emailSent && !process.env.RESEND_API_KEY ? { resetUrl } : {};

    return json(200, { ok: true, emailSent, ...devFallback });
  } catch (error) {
    return handleError(error);
  }
}

