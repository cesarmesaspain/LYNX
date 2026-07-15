export {
  runAgentABBenchmark,
  agentResultToJSON,
  agentResultToCSV,
  cmdAgentABBenchmark,
  makeLynxTools,
  makeBaselineTools,
  makeBaselineToolsForModification,
  externalProjectLabel,
  evaluateExternalDeadCodeResponse,
  isEvaluationEligible,
  toolCallSummary,
  classifyAgentABResultValidity,
} from "./benchmark.js";
export {
  PAID_MICROBENCHMARK_MODEL,
  PAID_MICROBENCHMARK_TEMPERATURE,
  assertPaidMicrobenchmarkProtocol,
  buildExperimentProtocol,
  compareOneChange,
} from "./experiment.js";
export type { ProgressEvent, ProgressCallback } from "./benchmark.js";
export {
  chatCompletion,
  getApiKey,
  redactSecrets,
  computeCost,
  computeCostDetailed,
  sha256Hash,
  truncateToolResult,
  MAX_TOOL_RESULT_BYTES,
} from "./api-client.js";
export type {
  ChatCallbacks,
  ChatOptions,
  ChatResult,
  PricingConfig,
} from "./api-client.js";
export {
  TOOL_COVERAGE,
  coverageSummary,
  designedOnlyTools,
  makeLynxToolsRealistic,
  executeLynxToolRealistic,
  TASKS_CORE,
  TASKS_WORKFLOW,
  TASKS_REALISTIC,
  DESIGNED_ONLY_TASK_IDS,
  PARTIAL_EXPECTED_TASK_IDS,
  normalizeArchitectureLanguage,
  taskEvaluationSummary,
  validateRealisticSuitePreflight,
} from "./realistic-suite.js";
export type { ToolCoverageEntry, RealisticTask } from "./realistic-suite.js";
export type {
  AgentABConfig,
  AgentABRun,
  AgentABResult,
  AgentABSummary,
  AgentABConditionSummary,
  AgentABComparisonBlock,
  AgentABMetrics,
  AgentABTask,
  AgentABEvaluation,
  AgentMessage,
  AgentToolCall,
  AgentToolDefinition,
  ApiUsage,
  ApiResponse,
  ToolTraceStep,
  AgentABExperimentProtocol,
  AgentABExperimentComparison,
  EvaluationKind,
  PilotGroundTruth,
} from "./types.js";
export {
  summarizeAgentABIndexLines,
  readAgentABIndex,
  wilsonInterval,
  aggregateAgentABHistory,
} from "./history.js";
export {
  extractPilotGroundTruth,
  makePilotTasks,
  setupB3Worktree,
  evaluatePilotBugFix,
  evaluatePilotScalability,
  HIDDEN_TESTS_DIR,
  PILOT_TASK_TOOL_PROFILES,
  makeLynxToolsForPilotTask,
  executePilotLynxTool,
} from "./pilot-suite.js";
export type {
  AgentABIndexEntry,
  AgentABHistoryExclusionReason,
  AgentABHistoryExclusion,
  AgentABHistorySummary,
  AgentABWilsonInterval,
  AgentABHistoryAggregate,
  AgentABHistoryProjectAggregate,
} from "./history.js";
