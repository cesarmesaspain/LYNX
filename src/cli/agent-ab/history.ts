import * as fs from "node:fs";

export interface AgentABIndexEntry {
  timestamp?: string;
  base_name?: string;
  project?: string;
  seed?: number;
  model?: string;
  tasks?: number;
  valid?: boolean;
  invalid_reasons?: string[];
  executed_runs?: number;
  evaluated_runs?: number;
  complete_pairs?: number;
  lynx?: {
    success_rate?: number;
    median_wall_ms?: number;
    total_cost_usd?: number;
  };
  baseline?: {
    success_rate?: number;
    median_wall_ms?: number;
    total_cost_usd?: number;
  };
  context_limit_hit?: boolean;
  [key: string]: unknown;
}

export type AgentABHistoryExclusionReason =
  "invalid_flag" | "legacy_empty_tasks" | "malformed_json";

export interface AgentABHistoryExclusion {
  line: number;
  reason: AgentABHistoryExclusionReason;
  base_name?: string;
  invalid_reasons?: string[];
}

export interface AgentABHistorySummary {
  included: AgentABIndexEntry[];
  excluded: AgentABHistoryExclusion[];
  total_lines: number;
  included_count: number;
  excluded_count: number;
  excluded_by_reason: Record<AgentABHistoryExclusionReason, number>;
}

export function summarizeAgentABIndexLines(
  lines: string[],
): AgentABHistorySummary {
  const included: AgentABIndexEntry[] = [];
  const excluded: AgentABHistoryExclusion[] = [];

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = raw.trim();
    if (!line) return;

    let entry: AgentABIndexEntry;
    try {
      entry = JSON.parse(line) as AgentABIndexEntry;
    } catch {
      excluded.push({ line: lineNumber, reason: "malformed_json" });
      return;
    }

    if (entry.valid === false) {
      excluded.push({
        line: lineNumber,
        reason: "invalid_flag",
        base_name: entry.base_name,
        invalid_reasons: entry.invalid_reasons,
      });
      return;
    }

    if (typeof entry.tasks !== "number" || entry.tasks <= 0) {
      excluded.push({
        line: lineNumber,
        reason: "legacy_empty_tasks",
        base_name: entry.base_name,
      });
      return;
    }

    included.push(entry);
  });

  const excludedByReason: Record<AgentABHistoryExclusionReason, number> = {
    invalid_flag: 0,
    legacy_empty_tasks: 0,
    malformed_json: 0,
  };
  for (const item of excluded) excludedByReason[item.reason] += 1;

  return {
    included,
    excluded,
    total_lines: included.length + excluded.length,
    included_count: included.length,
    excluded_count: excluded.length,
    excluded_by_reason: excludedByReason,
  };
}

export function readAgentABIndex(indexPath: string): AgentABHistorySummary {
  let content: string;
  try {
    content = fs.readFileSync(indexPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return summarizeAgentABIndexLines([]);
    }
    throw error;
  }
  const normalized = content.split(String.fromCharCode(13)).join("");
  return summarizeAgentABIndexLines(normalized.split(String.fromCharCode(10)));
}

export interface AgentABWilsonInterval {
  rate: number;
  lower: number;
  upper: number;
  wins: number;
  ties: number;
  losses: number;
  total: number;
}

export interface AgentABHistoryProjectAggregate {
  project: string;
  runs: number;
  cost_runs: number;
  wall_time_runs: number;
  quality_runs: number;
  evaluated_runs: number;
  cost_coverage_rate: number | null;
  wall_time_coverage_rate: number | null;
  quality_coverage_rate: number | null;
  lynx_cost_usd: number;
  baseline_cost_usd: number;
  cost_savings_usd: number;
  cost_savings_rate: number | null;
  lynx_wall_ms: number;
  baseline_wall_ms: number;
  wall_time_savings_ms: number;
  wall_time_savings_rate: number | null;
  cost_win_rate: AgentABWilsonInterval;
  wall_time_win_rate: AgentABWilsonInterval;
}

export interface AgentABHistoryAggregate {
  runs: number;
  cost_runs: number;
  wall_time_runs: number;
  quality_runs: number;
  evaluated_runs: number;
  cost_coverage_rate: number | null;
  wall_time_coverage_rate: number | null;
  quality_coverage_rate: number | null;
  projects: number;
  lynx_cost_usd: number;
  baseline_cost_usd: number;
  cost_savings_usd: number;
  cost_savings_rate: number | null;
  lynx_wall_ms: number;
  baseline_wall_ms: number;
  wall_time_savings_ms: number;
  wall_time_savings_rate: number | null;
  macro_cost_savings_rate: number | null;
  macro_wall_time_savings_rate: number | null;
  project_cost_savings_win_rate: AgentABWilsonInterval;
  project_wall_time_savings_win_rate: AgentABWilsonInterval;
  cost_win_rate: AgentABWilsonInterval;
  wall_time_win_rate: AgentABWilsonInterval;
  by_project: AgentABHistoryProjectAggregate[];
}

export function wilsonInterval(
  wins: number,
  total: number,
  z = 1.96,
  ties = 0,
): AgentABWilsonInterval {
  if (total <= 0) {
    return {
      rate: 0,
      lower: 0,
      upper: 0,
      wins: 0,
      ties: 0,
      losses: 0,
      total: 0,
    };
  }

  const rate = wins / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const centre = rate + zSquared / (2 * total);
  const margin =
    z * Math.sqrt((rate * (1 - rate) + zSquared / (4 * total)) / total);

  return {
    rate,
    lower: Math.max(0, (centre - margin) / denominator),
    upper: Math.min(1, (centre + margin) / denominator),
    wins,
    ties,
    losses: Math.max(0, total - wins - ties),
    total,
  };
}

function collectAgentABComparableMetrics(entries: AgentABIndexEntry[]) {
  const costComparable = entries.filter(
    (entry) =>
      typeof entry.lynx?.total_cost_usd === "number" &&
      typeof entry.baseline?.total_cost_usd === "number",
  );
  const wallComparable = entries.filter(
    (entry) =>
      typeof entry.lynx?.median_wall_ms === "number" &&
      typeof entry.baseline?.median_wall_ms === "number",
  );
  const qualityComparable = entries.filter(
    (entry) =>
      typeof entry.evaluated_runs === "number" && entry.evaluated_runs > 0,
  );
  return {
    costComparable,
    wallComparable,
    qualityComparable,
    comparableEntries: new Set([...costComparable, ...wallComparable]),
    evaluatedRuns: qualityComparable.reduce(
      (sum, entry) => sum + entry.evaluated_runs!,
      0,
    ),
  };
}

function aggregateAgentABProject(
  project: string,
  entries: AgentABIndexEntry[],
): AgentABHistoryProjectAggregate {
  const {
    costComparable,
    wallComparable,
    qualityComparable,
    comparableEntries,
    evaluatedRuns,
  } = collectAgentABComparableMetrics(entries);
  const lynxCost = costComparable.reduce(
    (sum, entry) => sum + entry.lynx!.total_cost_usd!,
    0,
  );
  const baselineCost = costComparable.reduce(
    (sum, entry) => sum + entry.baseline!.total_cost_usd!,
    0,
  );
  const costWins = costComparable.filter(
    (entry) => entry.lynx!.total_cost_usd! < entry.baseline!.total_cost_usd!,
  ).length;
  const costTies = costComparable.filter(
    (entry) => entry.lynx!.total_cost_usd! === entry.baseline!.total_cost_usd!,
  ).length;
  const lynxWall = wallComparable.reduce(
    (sum, entry) => sum + entry.lynx!.median_wall_ms!,
    0,
  );
  const baselineWall = wallComparable.reduce(
    (sum, entry) => sum + entry.baseline!.median_wall_ms!,
    0,
  );
  const wallWins = wallComparable.filter(
    (entry) => entry.lynx!.median_wall_ms! < entry.baseline!.median_wall_ms!,
  ).length;
  const wallTies = wallComparable.filter(
    (entry) => entry.lynx!.median_wall_ms! === entry.baseline!.median_wall_ms!,
  ).length;

  return {
    project,
    runs: comparableEntries.size,
    cost_runs: costComparable.length,
    wall_time_runs: wallComparable.length,
    quality_runs: qualityComparable.length,
    evaluated_runs: evaluatedRuns,
    cost_coverage_rate:
      entries.length > 0 ? costComparable.length / entries.length : null,
    wall_time_coverage_rate:
      entries.length > 0 ? wallComparable.length / entries.length : null,
    quality_coverage_rate:
      entries.length > 0 ? qualityComparable.length / entries.length : null,
    lynx_cost_usd: lynxCost,
    baseline_cost_usd: baselineCost,
    cost_savings_usd: baselineCost - lynxCost,
    cost_savings_rate:
      baselineCost > 0 ? (baselineCost - lynxCost) / baselineCost : null,
    lynx_wall_ms: lynxWall,
    baseline_wall_ms: baselineWall,
    wall_time_savings_ms: baselineWall - lynxWall,
    wall_time_savings_rate:
      baselineWall > 0 ? (baselineWall - lynxWall) / baselineWall : null,
    cost_win_rate: wilsonInterval(
      costWins,
      costComparable.length,
      1.96,
      costTies,
    ),
    wall_time_win_rate: wilsonInterval(
      wallWins,
      wallComparable.length,
      1.96,
      wallTies,
    ),
  };
}

export function aggregateAgentABHistory(
  entries: AgentABIndexEntry[],
): AgentABHistoryAggregate {
  const projectNames = [
    ...new Set(entries.map((entry) => entry.project || "unknown")),
  ];
  const byProject = projectNames
    .map((project) =>
      aggregateAgentABProject(
        project,
        entries.filter((entry) => (entry.project || "unknown") === project),
      ),
    )
    .filter((project) => project.runs > 0)
    .sort((a, b) => a.project.localeCompare(b.project));
  const projectCostRates = byProject
    .map((project) => project.cost_savings_rate)
    .filter((rate): rate is number => rate !== null);
  const projectCostWins = projectCostRates.filter((rate) => rate > 0).length;
  const projectWallRates = byProject
    .map((project) => project.wall_time_savings_rate)
    .filter((rate): rate is number => rate !== null);
  const projectWallWins = projectWallRates.filter((rate) => rate > 0).length;

  const {
    costComparable,
    wallComparable,
    qualityComparable,
    comparableEntries,
    evaluatedRuns,
  } = collectAgentABComparableMetrics(entries);
  const lynxCost = costComparable.reduce(
    (sum, entry) => sum + entry.lynx!.total_cost_usd!,
    0,
  );
  const baselineCost = costComparable.reduce(
    (sum, entry) => sum + entry.baseline!.total_cost_usd!,
    0,
  );
  const costWins = costComparable.filter(
    (entry) => entry.lynx!.total_cost_usd! < entry.baseline!.total_cost_usd!,
  ).length;
  const costTies = costComparable.filter(
    (entry) => entry.lynx!.total_cost_usd! === entry.baseline!.total_cost_usd!,
  ).length;
  const lynxWall = wallComparable.reduce(
    (sum, entry) => sum + entry.lynx!.median_wall_ms!,
    0,
  );
  const baselineWall = wallComparable.reduce(
    (sum, entry) => sum + entry.baseline!.median_wall_ms!,
    0,
  );
  const wallWins = wallComparable.filter(
    (entry) => entry.lynx!.median_wall_ms! < entry.baseline!.median_wall_ms!,
  ).length;
  const wallTies = wallComparable.filter(
    (entry) => entry.lynx!.median_wall_ms! === entry.baseline!.median_wall_ms!,
  ).length;

  return {
    runs: comparableEntries.size,
    cost_runs: costComparable.length,
    wall_time_runs: wallComparable.length,
    quality_runs: qualityComparable.length,
    evaluated_runs: evaluatedRuns,
    cost_coverage_rate:
      entries.length > 0 ? costComparable.length / entries.length : null,
    wall_time_coverage_rate:
      entries.length > 0 ? wallComparable.length / entries.length : null,
    quality_coverage_rate:
      entries.length > 0 ? qualityComparable.length / entries.length : null,
    projects: byProject.length,
    lynx_cost_usd: lynxCost,
    baseline_cost_usd: baselineCost,
    cost_savings_usd: baselineCost - lynxCost,
    cost_savings_rate:
      baselineCost > 0 ? (baselineCost - lynxCost) / baselineCost : null,
    lynx_wall_ms: lynxWall,
    baseline_wall_ms: baselineWall,
    wall_time_savings_ms: baselineWall - lynxWall,
    wall_time_savings_rate:
      baselineWall > 0 ? (baselineWall - lynxWall) / baselineWall : null,
    macro_cost_savings_rate:
      projectCostRates.length > 0
        ? projectCostRates.reduce((sum, rate) => sum + rate, 0) /
          projectCostRates.length
        : null,
    macro_wall_time_savings_rate:
      projectWallRates.length > 0
        ? projectWallRates.reduce((sum, rate) => sum + rate, 0) /
          projectWallRates.length
        : null,
    project_cost_savings_win_rate: wilsonInterval(
      projectCostWins,
      projectCostRates.length,
    ),
    project_wall_time_savings_win_rate: wilsonInterval(
      projectWallWins,
      projectWallRates.length,
    ),
    cost_win_rate: wilsonInterval(
      costWins,
      costComparable.length,
      1.96,
      costTies,
    ),
    wall_time_win_rate: wilsonInterval(
      wallWins,
      wallComparable.length,
      1.96,
      wallTies,
    ),
    by_project: byProject,
  };
}
