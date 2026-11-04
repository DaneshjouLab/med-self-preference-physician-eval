import { mkdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema";

export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

interface Handle {
  db: DB;
  migrate: () => Promise<void>;
  close: () => Promise<void>;
}

/** In-memory (dataDir undefined) or on-disk PGlite database. Used for local dev and tests. */
export function openPglite(dataDir?: string): Handle {
  if (dataDir) mkdirSync(path.dirname(dataDir), { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzlePglite(client, { schema });
  return {
    db: db as unknown as DB,
    migrate: () => migratePglite(db, { migrationsFolder: MIGRATIONS_DIR }),
    close: () => client.close(),
  };
}

export function openPostgres(connectionString: string): Handle {
  const serverless = process.env.VERCEL === "1";
  const pool = new Pool({
    connectionString,
    // A Vercel function instance should hold at most one database connection.
    // Long-running Node servers can keep a conventional local pool.
    max: serverless ? 1 : 10,
    idleTimeoutMillis: serverless ? 5_000 : 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: serverless,
  });
  const db = drizzlePg(pool, { schema });
  return {
    db: db as unknown as DB,
    migrate: () => migratePg(db, { migrationsFolder: MIGRATIONS_DIR }),
    close: () => pool.end(),
  };
}

export function openFromEnv(): Handle {
  const url = process.env.DATABASE_URL?.trim();
  if (url) return openPostgres(url);
  return openPglite(path.resolve(/*turbopackIgnore: true*/ process.env.PGLITE_DIR?.trim() || "./.data/pglite"));
}

// One shared handle per server process (survives Next.js dev hot reloads).
const globalForDb = globalThis as unknown as { __peDb?: Promise<DB> };

export function getDb(): Promise<DB> {
  if (!globalForDb.__peDb) {
    globalForDb.__peDb = (async () => {
      const handle = openFromEnv();
      // Vercel may start several function instances concurrently. Migrations
      // are therefore run as an explicit deployment step instead of on every
      // cold start. Local development and persistent Node servers retain the
      // convenient migrate-on-start behavior unless explicitly disabled.
      const migrateOnStartup = process.env.MIGRATE_ON_STARTUP
        ? process.env.MIGRATE_ON_STARTUP === "true"
        : process.env.VERCEL !== "1";
      if (migrateOnStartup) await handle.migrate();
      return handle.db;
    })();
  }
  return globalForDb.__peDb;
}
