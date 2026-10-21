// App settings kept in the database (app_settings), changed by the owner from the back office.

const PLATFORMS = ["android"];
let cached = null;

/** { android: { min, recommended } }: build numbers (Android versionCode). Cached for a minute per function instance. */
export async function clientVersions(sql) {
  if (cached && cached.expires > Date.now()) return cached.value;
  let row = null;
  // a database without the table yet (before migration 005) lets every build play
  try { [row] = await sql`select value from app_settings where key = 'client_versions'`; }
  catch (e) { console.warn('app_settings unavailable', e.message); }
  const value = normalizeVersions(row?.value);
  cached = { value, expires: Date.now() + 60_000 };
  return value;
}

export function normalizeVersions(raw) {
  const out = {};
  for (const p of PLATFORMS) {
    const v = raw?.[p] || {};
    const min = Math.max(0, Math.trunc(Number(v.min) || 0));
    const recommended = Math.max(min, Math.trunc(Number(v.recommended) || 0));
    out[p] = { min, recommended };
  }
  return out;
}

export async function saveClientVersions(sql, value, adminId) {
  const clean = normalizeVersions(value);
  await sql`
    insert into app_settings (key, value, updated_at, updated_by)
    values ('client_versions', ${JSON.stringify(clean)}::jsonb, now(), ${adminId})
    on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by
  `;
  cached = null;
  return clean;
}

/**
 * The app sends its platform and build number in X-HG-Client ("android/413974"). Builds below the minimum are refused
 * with 426 update_required, so an outdated app can never use a server that changed under it. Requests without the
 * header (the back office, editor and Windows builds) are not checked.
 */
export async function requireSupportedClient(event, sql) {
  const header = event.headers?.["x-hg-client"] || event.headers?.["X-HG-Client"] || "";
  const [platform, build] = String(header).split("/");
  if (!PLATFORMS.includes(platform)) return;
  const versions = await clientVersions(sql);
  const n = Math.trunc(Number(build) || 0);
  if (n > 0 && n < versions[platform].min) {
    const err = new Error("This version of the app is too old");
    err.statusCode = 426;
    err.publicCode = "update_required";
    throw err;
  }
}
