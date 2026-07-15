import { describe, expect, it } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { ensureProjectBrief } from '../../../src/intelligence/project-brief.js';

describe('ensureProjectBrief', () => {
  it('uses source-backed entry points instead of synthetic event channels', async () => {
    const db = LynxDatabase.openMemory();
    const project = 'brief-fixture';
    try {
      db.db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run(project, '/tmp/brief-fixture');
      db.db.prepare(`
        INSERT INTO nodes (
          id, project, kind, name, qualified_name, file_path,
          start_line, end_line, is_exported, is_test, is_entry_point, properties
        ) VALUES
          (1, ?, 'Channel', 'error', 'brief.channel.error', '', 1, 1, 0, 0, 1, '{}'),
          (2, ?, 'Module', 'cli', 'brief.module.cli', 'src/cli/index.ts', 1, 1, 0, 0, 1, '{}'),
          (3, ?, 'Module', 'fixture', 'brief.module.fixture', 'tests/fixtures/index.ts', 1, 1, 0, 1, 1, '{}')
      `).run(project, project, project);

      const result = await ensureProjectBrief(db, project, { force: true, allowLlm: false });
      expect(result).not.toBeNull();

      const brief = JSON.parse(result!.row.brief) as { sections: Array<{ title: string; content: string }> };
      const entrySection = brief.sections.find(section =>
        section.title === 'Puntos de entrada' || section.title === 'Entry points',
      );
      expect(entrySection?.content).toContain('cli (src/cli/index.ts)');
      expect(entrySection?.content).not.toContain('error');
      expect(entrySection?.content).not.toContain('fixture');

      db.db.prepare("UPDATE project_briefs SET digest_hash = 'stale' WHERE project = ?").run(project);
      const refreshed = await ensureProjectBrief(db, project, { allowLlm: false });
      expect(refreshed?.generated).toBe(true);
    } finally {
      db.close();
    }
  });
});
