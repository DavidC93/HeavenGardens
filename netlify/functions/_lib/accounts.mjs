import { createSession, currentUser, sessionCookie } from "./auth.mjs";

// Accounts with several ways to sign in: email + password on app_users, platforms in user_identities.

/** Shared by every provider once its token has been verified. Returns [status, body, headers]. */
export async function signInWithIdentity(sql, event, provider, subject, displayName, link) {
  const [identity] = await sql`select user_id from user_identities where provider = ${provider} and subject = ${subject}`;
  const me = link ? await currentUser(event) : null;
  if (link && !me) return [401, { error: "auth_required" }];

  if (identity) {
    if (link && identity.user_id !== me.id) return [409, { error: "identity_in_use" }];
    const user = await userWithProviders(sql, identity.user_id);
    const session = await createSession(identity.user_id);
    return [200, { user, created: false }, { "set-cookie": sessionCookie(session.token, session.expiresAt) }];
  }

  if (link) {
    const added = await sql`
      insert into user_identities (provider, subject, user_id, display_name)
      values (${provider}, ${subject}, ${me.id}, ${displayName || null})
      on conflict do nothing
      returning user_id
    `;
    if (added.length === 0) return [409, { error: "already_linked" }];
    return [200, { user: await userWithProviders(sql, me.id), linked: true }];
  }

  const name = (displayName || "Player").slice(0, 40);
  const [created] = await sql`
    with u as (
      insert into app_users (email, display_name, password_hash, role) values (null, ${name}, null, 'user')
      returning id
    ),
    i as (
      insert into user_identities (provider, subject, user_id, display_name)
      select ${provider}, ${subject}, u.id, ${displayName || null} from u
      returning user_id
    )
    select user_id from i
  `;
  const session = await createSession(created.user_id);
  return [201, { user: await userWithProviders(sql, created.user_id), created: true },
    { "set-cookie": sessionCookie(session.token, session.expiresAt) }];
}

export async function userWithProviders(sql, userId) {
  const [user] = await sql`select id, email, display_name, role from app_users where id = ${userId}`;
  const ids = await sql`select provider from user_identities where user_id = ${userId} order by provider`;
  return { ...user, providers: ids.map(r => r.provider) };
}
