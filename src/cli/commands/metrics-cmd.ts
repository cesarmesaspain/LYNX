import { rebuildDailySnapshots, summarizeHistory, readArchivedEvents } from '../../store/metrics-db.js';

export function cmdMetrics(args: string[]): void {
  const sub = args[0];

  if (sub === 'rebuild') {
    const dryRun = args.includes('--dry-run');
    console.log(dryRun ? 'Dry run — would rebuild snapshots from events_archive...' : 'Rebuilding snapshots from events_archive...');
    const result = rebuildDailySnapshots(dryRun);
    if (result.error) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    console.log(`Projects rebuilt: ${result.projects_rebuilt}`);
    console.log(`Rows before: ${result.rows_before}`);
    console.log(`Rows after: ${result.rows_after}`);
    if (result.backup_path) console.log(`Backup saved: ${result.backup_path}`);
    if (dryRun) console.log('(dry run — no changes made)');
    return;
  }

  if (sub === 'verify') {
    const project = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    if (project) {
      const history = summarizeHistory(project, 365);
      const events = readArchivedEvents(project, 50000);
      const eventTokens = events.reduce((s, e) => s + (e.tokens_saved || 0), 0);
      const eventFiles = events.reduce((s, e) => s + (e.files_avoided || 0), 0);
      const delta = history.total_tokens_saved - eventTokens;
      const status = delta === 0 ? 'OK' : delta < 0 ? 'MISSING' : 'INFLATED';
      console.log(`Project: ${project}`);
      console.log(`Snapshots: ${history.total_tokens_saved.toLocaleString()} tokens, ${history.total_events} events`);
      console.log(`Events archive: ${eventTokens.toLocaleString()} tokens, ${events.length} events`);
      console.log(`Delta: ${delta.toLocaleString()} tokens (${status})`);
    } else {
      console.log('Usage: lynx metrics verify <project>');
    }
    return;
  }

  // Default: show metrics summary
  console.log('Usage: lynx metrics <rebuild|verify>');
  console.log('  rebuild [--dry-run]  — rebuild all snapshots from events_archive');
  console.log('  verify <project>     — compare snapshots vs events_archive for a project');
}
