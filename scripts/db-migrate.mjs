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

function splitSqlStatements(source) {
  const statements = [];
  let current = "";
  let singleQuote = false;
  let doubleQuote = false;
  let dollarTag = "";

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1] || "";

    if (!singleQuote && !doubleQuote && !dollarTag && ch === "-" && next === "-") {
      while (i < source.length && source[i] !== "\n") i++;
      current += "\n";
      continue;
    }

    if (!singleQuote && !doubleQuote && ch === "$") {
      const rest = source.slice(i);
      const match = rest.match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        const tag = match[0];
        current += tag;
        i += tag.length - 1;
        dollarTag = dollarTag === tag ? "" : tag;
        continue;
      }
    }

    current += ch;

    if (dollarTag) continue;

    if (!doubleQuote && ch === "'" && source[i - 1] !== "\\") {
      singleQuote = !singleQuote;
      continue;
    }

    if (!singleQuote && ch === '"') {
      doubleQuote = !doubleQuote;
      continue;
    }

    if (!singleQuote && !doubleQuote && ch === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
    }
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

for (const file of files) {
  const fullPath = path.join(migrationsDir, file);
  const migrationSql = await fs.readFile(fullPath, "utf8");
  console.log(`Applying ${file}`);
  for (const statement of splitSqlStatements(migrationSql)) {
    await sql.query(statement);
  }
}

console.log("Database migrations complete.");
