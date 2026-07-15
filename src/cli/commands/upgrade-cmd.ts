import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { rebuildDailySnapshots, readArchivedEvents, closeMetricsDb } from '../../store/metrics-db.js';
import { runDoctor } from '../../install/doctor.js';
import { lynxHome, readLynxConfig } from '../../config/runtime.js';
import { LynxDatabase } from '../../store/database.js';
import { storedTimestampMs } from '../../store/time.js';

function readPkgVersion(): string {
  try {
    const pkgPaths = [
      path.join(process.cwd(), 'package.json'),
      path.join(path.dirname(process.argv[1]), '../package.json'),
    ];
    for (const p of pkgPaths) {
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (raw.name === 'lynx' && raw.version) return raw.version;
      }
    }
  } catch { /* fall through */ }
  return '0.1.0';
}

export async function cmdUpgrade(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const skipRebuild = args.includes('--skip-rebuild');

  console.log(`LYNX upgrade — v${readPkgVersion()}\n`);

  // 1. DB migrations (triggered by any DB open — reading events fires migrateV3)
  console.log('1/4 Database migrations...');
  try {
    readArchivedEvents(undefined, 1);
    closeMetricsDb();
    console.log('   OK — schema is up to date.');
  } catch (err) {
    console.log(`   WARNING: ${(err as Error).message}`);
  }

  // 2. Snapshot health check
  console.log('2/4 Snapshot health...');
  if (skipRebuild) {
    console.log('   Skipped (--skip-rebuild).');
  } else {
    const dbPath = path.join(lynxHome(), 'metrics.db');
    if (fs.existsSync(dbPath)) {
      let needsRebuild = false;
      let db: Database.Database | null = null;
      try {
        db = new Database(dbPath, { readonly: true });
        const projects = db.prepare('SELECT DISTINCT project FROM daily_snapshots').all() as { project: string }[];
        for (const { project } of projects) {
          const snapRow = db.prepare(
            'SELECT COALESCE(SUM(tokens_saved), 0) as tokens FROM daily_snapshots WHERE project = ?'
          ).get(project) as { tokens: number };
          const archRow = db.prepare(
            'SELECT COALESCE(SUM(tokens_saved), 0) as tokens FROM events_archive WHERE project = ?'
          ).get(project) as { tokens: number };
          const archTokens = Number(archRow.tokens || 0);
          if (archTokens > 0 && snapRow.tokens > archTokens * 1.1 + 100) {
            needsRebuild = true;
            break;
          }
        }
      } finally {
        if (db) { try { db.close(); } catch { /* ok */ } }
      }

      if (needsRebuild) {
        console.log('   Corruption detected — rebuilding snapshots...');
        if (!dryRun) {
          const result = rebuildDailySnapshots();
          console.log(`   Rebuilt ${result.projects_rebuilt} project(s). ${result.rows_before} → ${result.rows_after} rows.`);
          if (result.backup_path) console.log(`   Backup: ${result.backup_path}`);
        } else {
          console.log('   (dry run — would rebuild)');
        }
      } else {
        console.log('   OK — no corruption detected.');
      }
    } else {
      console.log('   OK — no metrics DB yet.');
    }
  }

  // 3. Index freshness
  console.log('3/4 Index freshness...');
  const dbsDir = path.join(lynxHome(), 'dbs');
  if (fs.existsSync(dbsDir)) {
    const cfg = readLynxConfig();
    const dbs = fs.readdirSync(dbsDir).filter(f => f.endsWith('.db'));
    let staleCount = 0;
    for (const f of dbs) {
      const project = f.replace(/\.db$/, '');
      try {
        const projDb = LynxDatabase.openProject(project);
        try {
          const meta = projDb.getProject(project);
          if (!meta || meta.status === 'failed') continue;
          const ageHours = (Date.now() - storedTimestampMs(meta.indexedAt)) / (1000 * 60 * 60);
          if (ageHours > cfg.stale_threshold_hours) {
            staleCount++;
            console.log(`   Stale: ${project} (${Math.round(ageHours)}h). Re-index with: lynx index ${meta.rootPath}`);
          }
        } finally { projDb.close(); }
      } catch { /* skip unreadable DBs */ }
    }
    if (staleCount === 0) console.log('   OK — all indexes fresh.');
  } else {
    console.log('   OK — no projects indexed.');
  }

  // 4. Run doctor
  console.log('4/4 Doctor...');
  if (!dryRun) {
    console.log('');
    await runDoctor();
  } else {
    console.log('   (dry run — skipping doctor)');
  }
}
