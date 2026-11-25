import { db } from "./_lib/db.mjs";
import { requireAdmin } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed } from "./_lib/http.mjs";

/**
 * Back office: errors the app reported from players' devices (admins only).
 *   GET ?days=1|7|30[&version=0.0.17]
 *       the same error (kind, message, top line of the stack) grouped: how many times it happened, in how many reports
 *       and for how many players, which app versions, first and last time, and the newest stack and device
 */
export async function handler(event) {
  try {
    await requireAdmin(event);
    if (event.httpMethod !== "GET") return methodNotAllowed(["GET"]);
    const sql = db();
    const q = event.queryStringParameters || {};
    const days = [1, 7, 30, 90].includes(Number(q.days)) ? Number(q.days) : 7;
    const version = typeof q.version === "string" && q.version.length > 0 && q.version.length <= 40 ? q.version : null;
    const groups = await sql`
      select kind, message, split_part(coalesce(stack, ''), E'\n', 1) as top,
        sum(count)::int as total, count(*)::int as reports, count(distinct user_id)::int as players,
        array_remove(array_agg(distinct app_version), null) as versions,
        min(created_at) as first_seen, max(created_at) as last_seen,
        (array_agg(stack order by created_at desc))[1] as stack,
        (array_agg(device order by created_at desc))[1] as device,
        (array_agg(platform order by created_at desc))[1] as platform
      from client_errors
      where created_at > now() - make_interval(days => ${days})
        and (${version}::text is null or app_version = ${version})
      group by kind, message, top
      order by total desc, last_seen desc
      limit 100
    `;
    const [totals] = await sql`
      select coalesce(sum(count), 0)::int as total, count(*)::int as reports, count(distinct user_id)::int as players
      from client_errors
      where created_at > now() - make_interval(days => ${days})
        and (${version}::text is null or app_version = ${version})
    `;
    const versions = await sql`
      select app_version as version, sum(count)::int as total
      from client_errors
      where created_at > now() - interval '90 days' and app_version is not null
      group by app_version order by max(created_at) desc limit 20
    `;
    return json(200, { days, version, totals, groups, versions });
  } catch (error) {
    return handleError(error);
  }
}
