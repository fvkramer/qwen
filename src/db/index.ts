import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Lazy singleton so importing this module without DATABASE_URL (e.g. at build
// time) doesn't throw; the connection is only created on first query.
let _db: ReturnType<typeof createDb> | null = null;

function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  // `prepare: false` is required for transaction-mode poolers (Neon pooled
  // connection strings, Supabase's Supavisor).
  const client = postgres(url, { prepare: false, max: 5 });
  return drizzle(client, { schema });
}

export function getDb() {
  if (!_db) {
    _db = createDb();
  }
  return _db;
}

export * as schema from "./schema";
