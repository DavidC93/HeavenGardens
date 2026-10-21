// Checks the minimum-version gate against a test database branch.
//   DATABASE_URL=<test branch> node scripts/appconfig-test.mjs
import { neon } from "@neondatabase/serverless";
import { clientVersions, normalizeVersions, requireSupportedClient, saveClientVersions } from "../netlify/functions/_lib/appconfig.mjs";

const sql = neon(process.env.DATABASE_URL);
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };
const ev = header => ({ headers: header ? { "x-hg-client": header } : {} });
async function refused(header) {
  try { await requireSupportedClient(ev(header), sql); return null; } catch (e) { return e.publicCode; }
}

const before = await clientVersions(sql);
try {
  check("normalize: recommended never below min", normalizeVersions({ android: { min: 50, recommended: 10 } }).android.recommended === 50);
  check("normalize: junk becomes 0", normalizeVersions({ android: { min: "x" } }).android.min === 0);

  await saveClientVersions(sql, { android: { min: 1000, recommended: 2000 } }, null);
  const v = await clientVersions(sql);
  check("saved and read back", v.android.min === 1000 && v.android.recommended === 2000);
  check("older build refused", await refused("android/999") === "update_required");
  check("minimum build allowed", await refused("android/1000") === null);
  check("newer build allowed", await refused("android/5000") === null);
  check("no header (back office, editor) allowed", await refused(null) === null);
  check("other platform allowed", await refused("other/1") === null);
  check("build 0 (unknown) allowed", await refused("android/0") === null);
} finally {
  await saveClientVersions(sql, before, null);
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
