import crypto from "node:crypto";
import { db } from "./db.mjs";

const SESSION_COOKIE = "hg_session";
const SESSION_DAYS = 14;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, storedHash) {
  const [scheme, salt, hash] = String(storedHash || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, "base64url");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function getCookie(event, name) {
  const raw = event.headers?.cookie || event.headers?.Cookie || "";
  return raw
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const index = part.indexOf("=");
      return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    })
    .find(([key]) => key === name)?.[1] || "";
}

export function sessionCookie(token, expiresAt) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expiresAt.toUTCString()}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function createSession(userId) {
  const sql = db();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await sql`
    insert into user_sessions (user_id, token_hash, expires_at)
    values (${userId}, ${sha256(token)}, ${expiresAt.toISOString()})
  `;
  return { token, expiresAt };
}

export async function currentUser(event) {
  const token = getCookie(event, SESSION_COOKIE);
  if (!token) return null;

  const sql = db();
  const rows = await sql`
    select u.id, u.email, u.display_name, u.role
    from user_sessions s
    join app_users u on u.id = s.user_id
    where s.token_hash = ${sha256(token)}
      and s.expires_at > now()
    limit 1
  `;

  const user = rows[0] || null;
  if (user) await touchLastSeen(sql, user.id, event);
  return user;
}

/**
 * Remembers when the player last used the game and with which build (the X-HG-Client header, e.g. "android/448147").
 * Only the game sends that header, so the back office never makes an admin look active in the game. At most one write
 * a minute per player, and a failure (e.g. before migration 008) never breaks the request.
 */
async function touchLastSeen(sql, userId, event) {
  const header = String(event.headers?.["x-hg-client"] || event.headers?.["X-HG-Client"] || "").slice(0, 40);
  const client = /^[a-z]+\/\d+$/.test(header) ? header : null;
  if (!client) return;
  try {
    await sql`
      update app_users set last_seen_at = now(), last_client = ${client}
      where id = ${userId}
        and (last_seen_at is null or last_seen_at < now() - interval '1 minute' or last_client is distinct from ${client})
    `;
  } catch { /* column missing until migration 008 runs */ }
}

export async function requireUser(event) {
  const user = await currentUser(event);
  if (!user) {
    const err = new Error("Authentication required");
    err.statusCode = 401;
    err.publicCode = "auth_required";
    throw err;
  }
  return user;
}

export async function requireAdmin(event) {
  const user = await requireUser(event);
  if (user.role !== "admin") {
    const err = new Error("Admin role required");
    err.statusCode = 403;
    err.publicCode = "admin_required";
    throw err;
  }
  return user;
}

export { normalizeEmail, randomToken, sha256, SESSION_COOKIE };

