import { LynxDatabase } from '../../store/database.js';
import { ensureProjectBrief, getProjectBrief } from '../../intelligence/project-brief.js';

export async function cmdBrief(args: string[]): Promise<void> {
  const project = args[0];
  if (!project) {
    console.error('Usage: lynx brief <project_name> [--refresh]');
    process.exit(1);
  }
  const db = LynxDatabase.openProject(project);
  const refresh = args.includes('--refresh');
  const result = refresh
    ? await ensureProjectBrief(db, project, { force: true })
    : { row: getProjectBrief(db, project), generated: false };
  if (!result?.row) {
    const generated = await ensureProjectBrief(db, project, { force: true });
    if (!generated?.row) {
      console.error('No indexed project found or brief could not be generated.');
      db.close();
      process.exit(1);
    }
    console.log(generated.row.brief);
    console.log(`\nGenerated: ${generated.row.generated_at} · Cost est: $${generated.row.cost_usd_est.toFixed(4)}`);
  } else {
    console.log(result.row.brief);
    console.log(`\nGenerated: ${result.row.generated_at} · Cost est: $${result.row.cost_usd_est.toFixed(4)}${result.generated ? ' · refreshed' : ''}`);
  }
  db.close();
}
