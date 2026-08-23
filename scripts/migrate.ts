import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import postgres from "postgres";
import { config } from "dotenv";

/**
 * Minimal forward-only migration runner.
 *
 * Deliberately not the Supabase CLI: this keeps migrations runnable in CI and
 * on a deploy host without installing another toolchain. Each file runs inside
 * a transaction and is recorded in schema_migrations, so re-running is a no-op.
 */
config({ path: ".env.local" });
config({ path: ".env" });

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error("SUPABASE_DB_URL is not set. Copy it from Supabase -> Project settings -> Database.");
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
const dir = join(process.cwd(), "supabase", "migrations");

async function main() {
  await sql`
    create table if not exists schema_migrations (
      name        text primary key,
      applied_at  timestamptz not null default now()
    )
  `;

  const applied = new Set(
    (await sql<{ name: string }[]>`select name from schema_migrations`).map((row) => row.name),
  );

  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`· ${file} (already applied)`);
      continue;
    }

    const contents = await readFile(join(dir, file), "utf8");

    await sql.begin(async (tx) => {
      await tx.unsafe(contents);
      await tx`insert into schema_migrations ${sql({ name: file })}`;
    });

    console.log(`✓ ${file}`);
  }

  console.log("\nMigrations up to date.");
}

main()
  .catch((error) => {
    console.error("\nMigration failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
