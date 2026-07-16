/*
 * types.ts — Core type definitions for the LYNX graph model.
 *
 * Typed graph of code entities and their relationships.
 */

// ── Node types ─────────────────────────────────────────────────────

export type LynxNode =
  | LynxProject
  | LynxFunction
  | LynxClass
  | LynxMethod
  | LynxVariable
  | LynxMacro
  | LynxType
  | LynxInterface
  | LynxEnum
  | LynxFile
  | LynxModule
  | LynxFolder
  | LynxBranch
  | LynxDependency
  | LynxChannel
  | LynxExternalSymbol
  | LynxConfigKey
  | LynxRoute;

export interface LynxNodeBase {
  id?: number;
  project: string;
  kind: LynxNodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  isTest: boolean;
  isEntryPoint: boolean;
  /** LLM-generated 1-line summary (set during Phase 2.5 enrichment) */
  llmSummary?: string;
}

export interface LynxFunction extends LynxNodeBase {
  kind: 'Function';
  signature: string | null;
  returnType: string | null;
  paramNames: string[];
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  lineCount: number;
  loopCount: number;
  loopDepth: number;
  transitiveLoopDepth: number;
  linearScanInLoop: number;
  allocInLoop: number;
  recursive: boolean;
}

export interface LynxClass extends LynxNodeBase {
  kind: 'Class';
  baseClasses: string[];
  lineCount: number;
  cyclomaticComplexity: number;
}

export interface LynxMethod extends LynxNodeBase {
  kind: 'Method';
  parentClass: string;
  signature: string | null;
  returnType: string | null;
  paramNames: string[];
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  lineCount: number;
}

export interface LynxVariable extends LynxNodeBase {
  kind: 'Variable';
  typeAnnotation: string | null;
}

export interface LynxMacro extends LynxNodeBase {
  kind: 'Macro';
}

export interface LynxType extends LynxNodeBase {
  kind: 'Type';
}

export interface LynxInterface extends LynxNodeBase {
  kind: 'Interface';
  baseInterfaces: string[];
}

export interface LynxEnum extends LynxNodeBase {
  kind: 'Enum';
  members: string[];
}

export interface LynxFile extends LynxNodeBase {
  kind: 'File';
  extension: string;
  lastModified: number;
  changeCount: number;
}

export interface LynxModule extends LynxNodeBase {
  kind: 'Module';
  lineCount: number;
}

export interface LynxFolder extends LynxNodeBase {
  kind: 'Folder';
}

export interface LynxProject extends LynxNodeBase {
  kind: 'Project';
}

export interface LynxBranch extends LynxNodeBase {
  kind: 'Branch';
  branchName: string;
}

export interface LynxDependency extends LynxNodeBase {
  kind: 'Dependency';
  packageName: string;
  version: string | null;
  ecosystem: string;
  manifestPath: string;
}

export interface LynxChannel extends LynxNodeBase {
  kind: 'Channel';
  channelName: string;
  transport: string;
}

export interface LynxExternalSymbol extends LynxNodeBase {
  kind: 'ExternalSymbol';
  symbolType: string;
}

export interface LynxConfigKey extends LynxNodeBase {
  kind: 'ConfigKey';
  keyName: string;
}

export interface LynxRoute extends LynxNodeBase {
  kind: 'Route';
  httpMethod: string;
  urlPath: string;
  /** True when inferred from an outbound HTTP client call, not declared locally. */
  isExternal: boolean;
}

export type LynxNodeKind = LynxNode['kind'];

// ── Edge types ─────────────────────────────────────────────────────

export interface LynxEdge {
  id?: number;
  project: string;
  sourceId: number;
  targetId: number;
  type: LynxEdgeType;
  properties: Record<string, unknown>;
}

export type LynxEdgeType =
  | 'CALLS'
  | 'IMPORTS'
  | 'DEFINES'
  | 'DEFINES_METHOD'
  | 'USAGE'
  | 'WRITES'
  | 'READS'
  | 'THROWS'
  | 'RAISES'
  | 'HTTP_CALLS'
  | 'ASYNC_CALLS'
  | 'GRPC_CALLS'
  | 'GRAPHQL_CALLS'
  | 'TRPC_CALLS'
  /** Probable call through a statically declared handler registry/map. */
  | 'REGISTRY_DISPATCH'
  | 'INHERITS'
  | 'IMPLEMENTS'
  | 'DECORATES'
  | 'OVERRIDE'
  | 'CONFIGURES'
  | 'CONTAINS_FILE'
  | 'CONTAINS_FOLDER'
  | 'HAS_BRANCH'
  | 'HANDLES'
  | 'TESTS'
  | 'TESTS_FILE'
  | 'SIMILAR_TO'
  | 'FILE_CHANGES_WITH'
  | 'LISTENS_ON'
  | 'EMITS'
  | 'INFRA_MAPS'
  | 'DEPENDS_ON'
  | 'DATA_FLOWS';

// ── Search types ───────────────────────────────────────────────────

export interface LynxSearchParams {
  project: string;
  label?: LynxNodeKind;
  namePattern?: string;
  qnPattern?: string;
  nameLike?: string;
  qnLike?: string;
  filePattern?: string;
  relationship?: LynxEdgeType;
  minDegree?: number;
  maxDegree?: number;
  limit: number;
  offset: number;
  excludeEntryPoints: boolean;
  sortBy: 'relevance' | 'name' | 'degree';
  textSearchTokens?: string[];
}

export interface LynxSearchResult {
  node: LynxNodeBase & { id: number };
  inDegree: number;
  outDegree: number;
  score: number;
  /** Actual text-match score from FTS5 token matching (0 = no text overlap). */
  tokenScore: number;
}

// ── Architecture types ────────────────────────────────────────────

export interface LynxLanguageCount {
  language: string;
  fileCount: number;
}

export interface LynxEntryPoint {
  name: string;
  qualifiedName: string;
  filePath: string;
}

export interface LynxHotspot {
  name: string;
  qualifiedName: string;
  fanIn: number;
  filePath: string;
  complexity: number;
}

export interface LynxCluster {
  id: number;
  label: string;
  members: number;
  cohesion: number;
  topNodes: string[];
  edgeTypes: string[];
}

export interface LynxFileTreeEntry {
  path: string;
  type: 'dir' | 'file';
  children: number;
}

export interface LynxArchitecture {
  languages: LynxLanguageCount[];
  entryPoints: LynxEntryPoint[];
  hotspots: LynxHotspot[];
  clusters: LynxCluster[];
  fileTree: LynxFileTreeEntry[];
  totalNodes: number;
  totalEdges: number;
  nodeLabels: { label: string; count: number }[];
  edgeTypes: { type: string; count: number }[];
}

// ── Traversal types ────────────────────────────────────────────────

export interface LynxNodeHop {
  node: LynxNodeBase & { id: number };
  hop: number;
}

export interface LynxEdgeInfo {
  fromName: string;
  toName: string;
  type: string;
  sourceId: number;
  targetId: number;
}

export interface LynxTraversal {
  root: LynxNodeBase & { id: number };
  visited: LynxNodeHop[];
  edges: LynxEdgeInfo[];
}

// ── Memory types (LYNX differentiator) ───────────────────────────

export interface LynxFinding {
  id?: number;
  project: string;
  targetQn: string;
  targetFile: string;
  category: 'hotspot' | 'complexity' | 'cluster' | 'review' | 'custom';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  metrics: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ── Index types ────────────────────────────────────────────────────

export type LynxIndexMode = 'full' | 'moderate' | 'fast';

export interface LynxIndexStatus {
  project: string;
  totalNodes: number;
  totalEdges: number;
  status: 'ready' | 'indexing' | 'empty' | 'error';
  rootPath: string;
  git: {
    branch: string;
    headSha: string;
    isGit: boolean;
  } | null;
}
