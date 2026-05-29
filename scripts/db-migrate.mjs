import fs from "node:fs/promises";
import path from "node:path";
import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
if (!databaseUrl) {
  console.error("Missing DATABASE_URL or NETLIFY_DATABASE_URL.");
  process.exit(1);
}

const sql = neon(databaseUrl);
const migrationsDir = path.join(process.cwd(), "db", "migrations");
const files = (await fs.readdir(migrationsDir)).filter(file => file.endsWith(".sql")).sort();

for (const file of files) {
  const fullPath = path.join(migrationsDir, file);
  const migrationSql = await fs.readFile(fullPath, "utf8");
  console.log(`Applying ${file}`);
  await sql.query(migrationSql);
}

console.log("Database migrations complete.");

