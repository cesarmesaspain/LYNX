import { describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { analyze } from '../../../src/pipeline/phases/analyze.js';

const PROJECT = 'architecture-fixture';

function addNode(
  db: LynxDatabase,
  options: { name: string; kind: string; file: string; entry?: boolean },
): void {
  db.db.prepare(
    `INSERT INTO nodes (
      project, name, qualified_name, kind, file_path, start_line, end_line,
      is_exported, is_test, is_entry_point, properties
    ) VALUES (?, ?, ?, ?, ?, 1, 1, 0, 0, ?, '{}')`,
  ).run(
    PROJECT,
    options.name,
    `fixture.${options.name}`,
    options.kind,
    options.file,
    options.entry ? 1 : 0,
  );
}

describe('analyze architecture entry points', () => {
  it('excludes external event channels and prioritizes project routes', () => {
    const db = LynxDatabase.openMemory();
    try {
      addNode(db, { name: 'error', kind: 'Channel', file: '', entry: true });
      addNode(db, { name: 'SIGTERM', kind: 'Channel', file: '', entry: true });
      addNode(db, { name: 'index', kind: 'Module', file: 'src/index.ts', entry: true });
      addNode(db, { name: 'GET /health', kind: 'Route', file: 'src/routes/health.ts', entry: true });

      const { architecture } = analyze(db, PROJECT);

      expect(architecture.entryPoints).toEqual([
        { name: 'GET /health', qualifiedName: 'fixture.GET /health', filePath: 'src/routes/health.ts' },
        { name: 'index', qualifiedName: 'fixture.index', filePath: 'src/index.ts' },
      ]);
    } finally {
      db.close();
    }
  });
});
