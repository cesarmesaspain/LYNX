/*
 * manage_adr.ts — Architecture Decision Records.
 *
 * Persists architectural knowledge as markdown in the findings table
 * with category 'adr'. Supports get, update, and sections modes.
 */

import { getDb } from '../server.js';

export async function handleManageAdr(
  args: Record<string, unknown>
): Promise<unknown> {
  const project = String(args.project || '');
  const mode = String(args.mode || 'get');
  const content = args.content ? String(args.content) : undefined;
  const sections = args.sections as string[] | undefined;

  if (!project) return { error: 'project is required' };

  const db = getDb(project);

  // Load existing ADR
  const existing = db.db
    .prepare(
      `SELECT * FROM findings WHERE project = ? AND category = 'adr' AND target_qn = '_adr_'
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(project) as { id: number; description: string; updated_at: string } | undefined;

  if (mode === 'get') {
    if (!existing) {
      return {
        content: '',
        updated_at: null,
        message: 'No ADR yet. Create one with manage_adr(mode="update", content="...")',
      };
    }
    return {
      content: existing.description,
      updated_at: existing.updated_at,
    };
  }

  if (mode === 'update') {
    if (!content) return { error: 'content is required for update mode' };

    if (existing) {
      db.db
        .prepare(
          `UPDATE findings SET description = ?, updated_at = datetime('now') WHERE id = ?`
        )
        .run(content, existing.id);
    } else {
      db.db
        .prepare(
          `INSERT INTO findings (project, target_qn, target_file, category, severity, title, description, metrics)
           VALUES (?, '_adr_', '_adr_', 'adr', 'info', 'Architecture Decision Record', ?, '{}')`
        )
        .run(project, content);
    }

    return {
      updated: true,
      size: content.length,
      updated_at: new Date().toISOString(),
    };
  }

  if (mode === 'sections') {
    if (!existing || !existing.description) {
      return { sections: [], count: 0, message: 'No ADR content to enumerate sections.' };
    }

    // Extract markdown headers (## or # lines)
    const adrSections: string[] = [];
    for (const line of existing.description.split('\n')) {
      const trimmed = line.trim();
      if (/^#{1,4}\s/.test(trimmed)) {
        adrSections.push(trimmed);
      }
    }

    if (sections && sections.length > 0) {
      // Filter sections that match requested names
      const matchingBody = adrSections
        .filter(s => sections.some(req => s.toLowerCase().includes(req.toLowerCase())))
        .join('\n');
      return {
        sections: adrSections,
        count: adrSections.length,
        matched_bodies: matchingBody || '(no matching sections found)',
      };
    }

    return {
      sections: adrSections,
      count: adrSections.length,
    };
  }

  return { error: `Unknown mode: ${mode}. Use get, update, or sections.` };
}
