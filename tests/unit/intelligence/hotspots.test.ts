import { describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { findGodComponents, findHotspots } from '../../../src/intelligence/hotspots.js';

describe('findHotspots', () => {
  it('excludes test fixtures by default but can include them explicitly', () => {
    const db = LynxDatabase.openMemory();
    try {
      const project = 'hotspots';
      db.db.prepare(`INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
        VALUES (1, ?, 'Function', 'fixtureHub', 'tests.fixtureHub', 'tests/fixtures/hub.ts', 1, 1, 0, 1, 0, '{}'),
               (2, ?, 'Function', 'productionHub', 'src.productionHub', 'src/hub.ts', 1, 1, 0, 0, 0, '{}'),
               (3, ?, 'Function', 'caller', 'src.caller', 'src/caller.ts', 1, 1, 0, 0, 0, '{}')`).run(project, project, project);
      for (let i = 0; i < 3; i++) {
        db.db.prepare(`INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, 3, ?, 'CALLS', '{}')`)
          .run(project, i < 2 ? 1 : 2);
      }

      expect(findHotspots(db, project, 10).map(h => h.name)).toEqual(['productionHub']);
      expect(findHotspots(db, project, 10, true).map(h => h.name)).toEqual(['fixtureHub', 'productionHub']);
    } finally {
      db.close();
    }
  });

  it('applies the same test-file policy to god components', () => {
    const db = LynxDatabase.openMemory();
    try {
      const project = 'god-components';
      db.db.prepare(`INSERT INTO nodes (id, project, kind, name, qualified_name, file_path, start_line, end_line, is_exported, is_test, is_entry_point, properties)
        VALUES (1, ?, 'Module', 'fixture', 'tests.fixture', 'tests/fixture.test.ts', 1, 500, 0, 1, 0, '{"lineCount":500}'),
               (2, ?, 'Module', 'production', 'src.production', 'src/production.ts', 1, 400, 0, 0, 0, '{"lineCount":400}')`).run(project, project);

      expect(findGodComponents(db, project).map(component => component.name)).toEqual(['production']);
      expect(findGodComponents(db, project, 300, true).map(component => component.name)).toEqual(['fixture', 'production']);
    } finally {
      db.close();
    }
  });
});
