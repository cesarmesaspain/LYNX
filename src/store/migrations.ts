import type BetterSqlite3 from 'better-sqlite3';

export interface SchemaMigration {
  version: number;
  name: string;
  up: (db: BetterSqlite3.Database) => void;
}

const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

export function runSchemaMigrations(
  db: BetterSqlite3.Database,
  migrations: readonly SchemaMigration[],
): void {
  db.exec(SCHEMA_MIGRATIONS_DDL);

  const appliedRows = db
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; name: string }>;
  const applied = new Map(appliedRows.map((row) => [row.version, row.name]));
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const seen = new Set<number>();

  for (const migration of ordered) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(`Invalid schema migration version: ${migration.version}`);
    }
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate schema migration version: ${migration.version}`);
    }
    seen.add(migration.version);

    const appliedName = applied.get(migration.version);
    if (appliedName !== undefined) {
      if (appliedName !== migration.name) {
        throw new Error(
          `Schema migration ${migration.version} name mismatch: expected "${appliedName}", received "${migration.name}"`,
        );
      }
      continue;
    }

    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
        .run(migration.version, migration.name);
    });
    apply();
  }
}
