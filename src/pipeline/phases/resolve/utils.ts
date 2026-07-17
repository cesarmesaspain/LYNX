/*
 * resolve/utils.ts — Shared utilities for resolver passes.
 */

import * as path from 'node:path';
import type { LynxDatabase } from '../../../store/database.js';
import { upsertNode } from '../../../store/nodes.js';
import type {
  LynxBranch,
  LynxChannel,
  LynxConfigKey,
  LynxDependency,
  LynxEdge,
  LynxEdgeType,
  LynxExternalSymbol,
  LynxNode,
} from '../../../types.js';
import type { NodeRef, ResolverIndexes } from './indexes.js';
import { callableKinds, symbolKinds, typeKinds } from './constants.js';

// ── Path helpers ──────────────────────────────────────────────────

export function findCommonRoot(absPaths: string[]): string {
  if (absPaths.length === 0) return process.cwd();
  if (absPaths.length === 1) return path.dirname(absPaths[0]);
  const parts = absPaths.map((p) => p.split('/'));
  const commonParts: string[] = [];
  for (let i = 0; i < parts[0].length; i++) {
    if (!parts.every((p) => p[i] === parts[0][i])) break;
    if (parts[0][i]) commonParts.push(parts[0][i]);
  }
  return '/' + commonParts.join('/');
}

// ── Node resolution helpers ───────────────────────────────────────

export function resolveCaller(idx: ResolverIndexes, filePath: string, enclosingQn: string): NodeRef | undefined {
  const exact = idx.qnToId.get(enclosingQn);
  if (exact) return idx.idToRow.get(exact);

  if (enclosingQn.endsWith('._global')) {
    return getFileNode(idx, filePath);
  }

  const local = getFileNodes(idx, filePath).find((node) => node.qualified_name.endsWith(`.${enclosingQn}`));
  if (local) return local;

  const name = enclosingQn.split('.').pop() || enclosingQn;
  return preferSameFile(idx.nameToRows.get(name) || [], filePath);
}

const langGroups: Record<string, string> = {
  ts: 'ts', tsx: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts',
  py: 'py', pyx: 'py', pyi: 'py',
  go: 'go',
  rs: 'rs',
  c: 'c-family', h: 'c-family', cc: 'c-family', cpp: 'c-family', cxx: 'c-family',
  hh: 'c-family', hpp: 'c-family', hxx: 'c-family', m: 'c-family', mm: 'c-family',
  java: 'jvm', kt: 'jvm', kts: 'jvm',
};

export function languageGroup(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return langGroups[ext] || ext;
}

export function sameLanguageGroup(leftFile: string, rightFile: string): boolean {
  return languageGroup(leftFile) === languageGroup(rightFile);
}

export function resolveCallee(
  idx: ResolverIndexes,
  filePath: string,
  calleeName: string,
  callerQn?: string,
): { node: NodeRef; reason: string; confidence: number } | undefined {
  const methodName = calleeName.split('.').pop() || calleeName;
  const isQualifiedCall = calleeName.includes('.');

  const callerLang = languageGroup(filePath);

  // `this.method()` / `self.method()` carry enough lexical evidence to bind
  // the call to the caller's own class. Match the complete parent QN so two
  // classes with the same method name in one file remain unambiguous.
  if (callerQn && /^(?:this|self)\.[A-Za-z_$][\w$]*$/.test(calleeName)) {
    const parentQn = callerQn.includes('.')
      ? callerQn.slice(0, callerQn.lastIndexOf('.'))
      : '';
    if (parentQn) {
      const lexicalTarget = getFileNodes(idx, filePath).find((node) =>
        callableKinds.has(node.kind) && node.qualified_name === `${parentQn}.${methodName}`,
      );
      if (lexicalTarget) {
        return { node: lexicalTarget, reason: 'lexical-receiver', confidence: 0.98 };
      }
    }
  }

  const local = getFileNodes(idx, filePath)
    .filter((node) => callableKinds.has(node.kind))
    .find((node) => node.qualified_name.endsWith(`.${calleeName}`) || (!isQualifiedCall && node.name === methodName));
  if (local) return { node: local, reason: 'same-file', confidence: 0.95 };

  // If the callee name matches a local variable (const/let/var) in the same
  // file, the call is to the local binding, not to an external function with
  // the same name. Skip resolution to avoid false-positive CALLS edges from
  // local names colliding with distant functions (e.g. `const load = ...` in
  // file A matching `function load()` in file B).
  const localVars = (idx.kindNameToRows.get(`Variable:${methodName}`) || [])
    .filter((v) => v.file_path === filePath);
  if (localVars.length > 0) return undefined;

  const callableByName = [
    ...(idx.kindNameToRows.get(`Function:${methodName}`) || []),
    ...(idx.kindNameToRows.get(`Method:${methodName}`) || []),
  ].filter((node) => languageGroup(node.file_path) === callerLang);
  const sameFileCallable = preferSameFile(callableByName, filePath);
  if (sameFileCallable) return { node: sameFileCallable, reason: 'same-file-name', confidence: 0.9 };

  // Import-aware disambiguation: when the file has recorded imports, prefer
  // candidates that match those imports over global name matches. This
  // eliminates false-positive CALLS edges when two functions share a name
  // across different files — the file can only call what it imports.
  const importedQns = idx.importedQnByFile.get(filePath);
  if (importedQns && importedQns.size > 0) {
    const importedCallables = callableByName.filter((node) => importedQns.has(node.qualified_name));
    if (importedCallables.length === 1) return { node: importedCallables[0], reason: 'imported-name', confidence: 0.92 };
    if (importedCallables.length > 1) {
      const implementations = importedCallables.filter((node) =>
        !/\.(?:h|hh|hpp|hxx)$/i.test(node.file_path),
      );
      if (implementations.length === 1) {
        return { node: implementations[0], reason: 'imported-implementation', confidence: 0.96 };
      }
      const best = importedCallables.find((n) => n.file_path !== filePath) || importedCallables[0];
      return { node: best, reason: 'imported-name', confidence: 0.85 };
    }
    // No imported candidate matched — fall through to global search for
    // built-ins, dynamic imports, and extraction gaps.

    // A class import binds qualified static/member calls through the imported
    // class identity. Require one imported class QN and one child callable;
    // aliases or ambiguous class identities remain unresolved.
    const qualified = calleeName.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
    if (qualified) {
      const receiverName = qualified[1];
      const importedOwners = [...importedQns].filter((qn) =>
        qn === receiverName || qn.endsWith(`.${receiverName}`),
      );
      const ownerCallables = callableByName.filter((node) =>
        importedOwners.some((ownerQn) => node.qualified_name.startsWith(`${ownerQn}.`)),
      );
      if (importedOwners.length === 1 && ownerCallables.length === 1) {
        return { node: ownerCallables[0], reason: 'imported-owner', confidence: 0.96 };
      }
    }
  }

  // A receiver-qualified call such as db.get() or map.set() does not identify
  // the owning type. Resolving it to the only globally indexed method named
  // "get"/"set" creates high-confidence-looking false edges. Without exact
  // local or import evidence, preserve it as unresolved.
  if (isQualifiedCall) return undefined;

  // For global name matches, exclude unexported symbols unless they're in
  // the same file. Module-private functions (no `export` keyword) cannot be
  // called from other files — matching them by name alone produces false
  // CALLS edges (e.g. `params.toString()` → `lib/backups.toString`).
  const exportedCallable = callableByName.filter((n) =>
    n.kind !== 'Method' && (n.is_exported !== 0 || n.file_path === filePath));
  if (exportedCallable.length === 1) return { node: exportedCallable[0], reason: 'unique-name', confidence: 0.8 };

  if (exportedCallable.length > 0) {
    const samePkg = preferSamePackage(exportedCallable, filePath);
    if (samePkg) return { node: samePkg, reason: 'package-name', confidence: 0.55 };
  }

  // Single unique-name match: allow, but not for cross-file unexported symbols.
  // This catches `params.toString()` matching `lib/backups.toString` (unexported).
  if (callableByName.length === 1) {
    const only = callableByName[0];
    if (only.kind === 'Method' && only.file_path !== filePath) return undefined;
    if (idx.hasExportedCallables && only.is_exported === 0 && only.file_path !== filePath) return undefined;
    return { node: only, reason: 'unique-name', confidence: 0.8 };
  }

  const suffixCandidates = (idx.suffixToRows.get(calleeName) || idx.suffixToRows.get(methodName) || [])
    .filter((node) => languageGroup(node.file_path) === callerLang);
  const callableSuffix = suffixCandidates.filter((node) => callableKinds.has(node.kind));
  if (callableSuffix.length === 1 && (callableSuffix[0].kind !== 'Method' || callableSuffix[0].file_path === filePath)) {
    return { node: callableSuffix[0], reason: 'suffix-index', confidence: 0.7 };
  }

  const samePkg = preferSamePackage(callableByName, filePath);
  if (samePkg) return { node: samePkg, reason: 'package-name', confidence: 0.55 };
  return undefined;
}

export function resolveImportTargets(
  idx: ResolverIndexes,
  currentFile: string,
  moduleKey: string,
  localName: string
): NodeRef[] {
  const moduleExports = idx.exportedByModule.get(moduleKey) || [];
  const exactModuleMatches = moduleExports.filter((node) => node.name === localName);
  if (exactModuleMatches.length > 0) return exactModuleMatches;

  const defaultLike = moduleExports.filter((node) => node.name === 'default' || node.name === 'module.exports');
  if (defaultLike.length > 0) return defaultLike;

  const global = idx.nameToRows.get(localName) || [];
  return global.filter((node) => node.file_path !== currentFile && symbolKinds.has(node.kind));
}

export function usageEdgeType(refName: string, target: NodeRef): LynxEdgeType {
  void refName;
  if (typeKinds.has(target.kind) || /^[A-Z]/.test(refName)) return 'READS';
  return target.kind === 'Variable' ? 'READS' : 'USAGE';
}

export function findParentSymbol(idx: ResolverIndexes, node: NodeRef): NodeRef | undefined {
  const parentQn = node.qualified_name.substring(0, node.qualified_name.lastIndexOf('.'));
  const parentId = idx.qnToId.get(parentQn);
  return parentId ? idx.idToRow.get(parentId) : undefined;
}

export function bestByKindAndName(
  idx: ResolverIndexes,
  origin: NodeRef,
  name: string,
  kinds: string[]
): NodeRef | undefined {
  const candidates = kinds.flatMap((kind) => idx.kindNameToRows.get(`${kind}:${name}`) || []);
  return preferSameFile(candidates, origin.file_path) || (candidates.length === 1 ? candidates[0] : undefined);
}

// ── File node access ──────────────────────────────────────────────

export function getFileNode(idx: ResolverIndexes, filePath: string): NodeRef | undefined {
  return getFileNodes(idx, filePath).find((node) => node.kind === 'File');
}

export function getFileNodes(idx: ResolverIndexes, filePath: string): NodeRef[] {
  return idx.fileToNodes.get(filePath) || [];
}

// ── Heuristic helpers ─────────────────────────────────────────────

export function preferSameFile(candidates: NodeRef[], filePath: string): NodeRef | undefined {
  return candidates.find((node) => node.file_path === filePath);
}

export function preferSamePackage(candidates: NodeRef[], filePath: string): NodeRef | undefined {
  const prefix = filePath.split('/').slice(0, 2).join('/');
  return candidates.find((node) => node.file_path.startsWith(prefix));
}

export function getStringArrayProp(node: NodeRef, key: string): string[] {
  if (!node.properties) return [];
  try {
    const props = JSON.parse(node.properties) as Record<string, unknown>;
    const value = props[key];
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

// ── Synthetic node creation ───────────────────────────────────────

export function upsertDependencyNode(
  db: LynxDatabase,
  idx: ResolverIndexes,
  packageName: string,
  version: string | null,
  ecosystem: string,
  manifestPath: string
): number {
  return upsertSyntheticNode(db, idx, {
    project: idx.project,
    kind: 'Dependency',
    name: packageName,
    qualifiedName: `${idx.project}.dependency.${sanitizeQnPart(ecosystem)}.${sanitizeQnPart(packageName)}`,
    filePath: manifestPath,
    startLine: 0,
    endLine: 0,
    isExported: false,
    isTest: false,
    isEntryPoint: false,
    packageName,
    version,
    ecosystem,
    manifestPath,
  } satisfies LynxDependency);
}

export function upsertChannelNode(
  db: LynxDatabase,
  idx: ResolverIndexes,
  channelName: string,
  transport: string
): number {
  return upsertSyntheticNode(db, idx, {
    project: idx.project,
    kind: 'Channel',
    name: channelName,
    qualifiedName: `${idx.project}.channel.${sanitizeQnPart(transport)}.${sanitizeQnPart(channelName)}`,
    filePath: '',
    startLine: 0,
    endLine: 0,
    isExported: false,
    isTest: false,
    // A channel is an integration surface, not an executable application entry point.
    // Marking it as one inflates architecture and dashboard entry-point metrics with
    // internal events such as `error`, `close`, or `SIGTERM`.
    isEntryPoint: false,
    channelName,
    transport,
  } satisfies LynxChannel);
}

export function upsertSyntheticNode(db: LynxDatabase, idx: ResolverIndexes, node: LynxNode): number {
  const existingId = idx.qnToId.get(node.qualifiedName);
  const id = upsertNode(db, node);
  // Synthetic nodes are cached in resolver indexes. Still persist their current
  // metadata on every pass: otherwise a semantic correction (for example a
  // channel no longer being an entry point) can never repair existing indexes.
  if (existingId) return id;

  const properties = syntheticProperties(node);
  const row: NodeRef = {
    id,
    kind: node.kind,
    name: node.name,
    qualified_name: node.qualifiedName,
    file_path: node.filePath,
    start_line: node.startLine,
    is_exported: node.isExported ? 1 : 0,
    properties: JSON.stringify(properties),
  };

  idx.qnToId.set(node.qualifiedName, id);
  idx.idToRow.set(id, row);
  idx.allRows.push(row);
  pushMap(idx.nameToRows, node.name, row);
  pushMap(idx.kindNameToRows, `${node.kind}:${node.name}`, row);
  pushMap(idx.fileToNodes, node.filePath, row);
  for (const suffix of qnSuffixes(node.qualifiedName)) {
    pushMap(idx.suffixToRows, suffix, row);
  }
  return id;
}

function syntheticProperties(node: LynxNode): Record<string, unknown> {
  switch (node.kind) {
    case 'Branch':
      return { branchName: node.branchName };
    case 'Dependency':
      return {
        packageName: node.packageName,
        version: node.version,
        ecosystem: node.ecosystem,
        manifestPath: node.manifestPath,
      };
    case 'Channel':
      return { channelName: node.channelName, transport: node.transport };
    case 'ExternalSymbol':
      return { symbolType: node.symbolType };
    case 'ConfigKey':
      return { keyName: node.keyName };
    default:
      return {};
  }
}

// ── QN / path utilities ───────────────────────────────────────────

export function sanitizeQnPart(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || hashString(value);
}

// ── Edge helpers ──────────────────────────────────────────────────

export function addEdge(
  edges: LynxEdge[],
  project: string,
  sourceId: number,
  targetId: number,
  type: LynxEdgeType,
  properties: Record<string, unknown> = {}
): void {
  edges.push({ project, sourceId, targetId, type, properties });
}

export function dedupeEdges(edges: LynxEdge[]): LynxEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.sourceId}:${edge.targetId}:${edge.type}:${JSON.stringify(edge.properties)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function countByType(edges: LynxEdge[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const edge of edges) {
    counts[edge.type] = (counts[edge.type] || 0) + 1;
  }
  return counts;
}

// ── Map helper ────────────────────────────────────────────────────

export function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

// ── QN / import resolution ───────────────────────────────────────

export function qnSuffixes(qn: string): string[] {
  const parts = qn.split('.');
  const suffixes: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    suffixes.push(parts.slice(i).join('.'));
  }
  return suffixes;
}

export function resolveImportToModuleKey(importPath: string, currentFile: string): string {
  return filePathToModuleKey(resolveImportToFile(importPath, currentFile));
}

/**
 * Resolve an import/include to an indexed File node.
 *
 * Module-key lookup remains authoritative. C/C++ compilers also search configured
 * include roots, which are not always available to a syntax-only indexer. For a
 * header include we therefore accept a repository path suffix only when it has a
 * single candidate. Ambiguous basenames deliberately remain unresolved rather
 * than creating a plausible-looking but false dependency.
 */
export function resolveImportedFile(
  idx: ResolverIndexes,
  importPath: string,
  currentFile: string,
): NodeRef | undefined {
  const moduleKey = resolveImportToModuleKey(importPath, currentFile);
  const exact = idx.moduleToFileNode.get(moduleKey);
  if (exact) return exact;

  if (languageGroup(currentFile) === 'go') {
    return resolveGoPackageFiles(idx, importPath)[0];
  }

  if (languageGroup(currentFile) !== 'c-family') return undefined;
  const normalized = importPath
    .trim()
    .replace(/^[<"']|[>"']$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
  if (!/\.(?:h|hh|hpp|hxx)$/.test(normalized)) return undefined;

  const basename = normalized.split('/').pop()!;
  const candidates = (idx.headerBasenameToFileNodes.get(basename) || [])
    .filter((node) => {
      const candidate = node.file_path.replace(/\\/g, '/').toLowerCase();
      return candidate === normalized || candidate.endsWith(`/${normalized}`);
    });
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Go imports address packages, not individual source files. A repository-local
 * package may be prefixed by the module declared in go.mod, so match the
 * longest directory suffix and only accept a single package directory.
 */
export function resolveGoPackageFiles(idx: ResolverIndexes, importPath: string): NodeRef[] {
  const importSegments = importPath
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  if (importSegments.length < 2) return [];

  const packageFiles = new Map<string, NodeRef[]>();
  for (const nodes of idx.fileToNodes.values()) {
    const file = nodes.find((node) => node.kind === 'File' && /\.go$/i.test(node.file_path));
    if (!file) continue;
    const normalized = file.file_path.replace(/\\/g, '/');
    const directory = normalized.split('/').slice(0, -1).join('/');
    if (!directory) continue;
    const files = packageFiles.get(directory) || [];
    files.push(file);
    packageFiles.set(directory, files);
  }

  let bestLength = 0;
  let bestDirectories: string[] = [];
  for (const directory of packageFiles.keys()) {
    const directorySegments = directory.split('/').filter(Boolean);
    let suffixLength = 0;
    const max = Math.min(directorySegments.length, importSegments.length);
    while (
      suffixLength < max &&
      directorySegments[directorySegments.length - 1 - suffixLength] ===
        importSegments[importSegments.length - 1 - suffixLength]
    ) {
      suffixLength++;
    }
    if (suffixLength === 0) continue;
    if (suffixLength > bestLength) {
      bestLength = suffixLength;
      bestDirectories = [directory];
    } else if (suffixLength === bestLength) {
      bestDirectories.push(directory);
    }
  }

  if (bestDirectories.length !== 1) return [];
  return (packageFiles.get(bestDirectories[0]) || [])
    .sort((left, right) => left.file_path.localeCompare(right.file_path));
}

export function filePathToModuleKey(filePath: string): string {
  const withoutExt = filePath.replace(/\.[^.]+$/, '');
  const parts = withoutExt.replace(/\\/g, '/').split('/');
  if (parts[parts.length - 1] === 'index') parts.pop();
  if (parts[0] === 'src') parts.shift();
  return parts.join('.');
}

export function resolveImportToFile(importPath: string, currentFile: string): string {
  if (!importPath.startsWith('.')) return importPath;
  const currentDir = currentFile.split('/').slice(0, -1).join('/');
  const parts = (currentDir ? currentDir + '/' : '') + importPath;
  const segments = parts.split('/');
  const result: string[] = [];
  for (const seg of segments) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      result.pop();
      continue;
    }
    result.push(seg);
  }
  return result.join('/');
}

// ── Lightweight hash ──────────────────────────────────────────────

export function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
