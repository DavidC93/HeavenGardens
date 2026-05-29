import { neon } from "@neondatabase/serverless";

let sqlClient;

export function getDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
}

export function db() {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    const err = new Error("Missing DATABASE_URL or NETLIFY_DATABASE_URL");
    err.statusCode = 503;
    err.publicCode = "database_not_configured";
    throw err;
  }

  if (!sqlClient) sqlClient = neon(databaseUrl);
  return sqlClient;
}

