/*
 * extractor.ts — Unified code extraction for 158+ language configs.
 *
 * All languages (including .ts/.tsx) go through tree-sitter WASM for speed.
 */

import * as path from 'node:path';
import { getLanguageConfigForPath } from './language-registry.js';
import { extractWithTreeSitter } from './tree-sitter-extractor.js';
import type { TSExtractionResult, TSExtractedCall, TSExtractedImport, TSExtractedUsage, TSExtractedChannel, TSExtractedThrow, TSExtractedDecorator } from './tree-sitter-extractor.js';
import type {
  LynxNode,
} from '../types.js';

// ── Call site ────────────────────────────────────────────────────

export interface ExtractedCall {
  calleeName: string;
  enclosingFuncQn: string;
  args: string[];
  startLine: number;
  loopDepth: number;
}

export interface ExtractedImport {
  localName: string;
  modulePath: string;
  startLine?: number;
}

export interface ExtractedUsage {
  refName: string;
  enclosingFuncQn: string;
  startLine?: number;
  isWrite?: boolean;
}

export interface ExtractedChannel {
  channelName: string;
  transport: string;
  enclosingFuncQn: string;
  direction: 'emit' | 'listen';
  startLine?: number;
}

export interface ExtractedThrow {
  exceptionName: string;
  enclosingFuncQn: string;
  startLine: number;
}

export interface ExtractedDecorator {
  name: string;
  targetQn: string;
  startLine: number;
}

export interface ExtractionResult {
  nodes: LynxNode[];
  calls: ExtractedCall[];
  imports: ExtractedImport[];
  usages: ExtractedUsage[];
  channels: ExtractedChannel[];
  throws: ExtractedThrow[];
  decorators: ExtractedDecorator[];
  hasError: boolean;
  errorMsg: string | null;
  isTestFile: boolean;
  language: string;
  /** Non-fatal coverage limits applied while extracting a dense source file. */
  partialReasons?: string[];
  /** LLM-enriched metadata (summary, entry point detection, test detection) */
  llmMetadata?: import('../llm/types.js').LlmFileMetadata;
}

// ── Main extraction function (unified, async) ─────────────────────

/**
 * Extract code from a single file. Dispatches to:
 * - TS compiler API for .ts/.tsx (rich type info)
 * - tree-sitter/native extraction when available
 * - textual fallback for supported languages without bundled WASM
 */
export async function extractFile(
  source: string,
  project: string,
  relPath: string,
  moduleQn: string
): Promise<ExtractionResult> {
  const ext = path.extname(relPath).toLowerCase();
  const config = getLanguageConfigForPath(relPath);

  // Files use tree-sitter/native extraction where available and a conservative
  // textual fallback for languages whose grammar is not bundled locally.
  if (config) {
    const result = await extractWithTreeSitter(source, relPath, project, config);
    return {
      nodes: result.nodes,
      calls: result.calls.map((c) => ({ ...c, loopDepth: 0 })),
      imports: result.imports,
      usages: result.usages,
      channels: result.channels.map((ch) => ({
        channelName: ch.channelName,
        transport: ch.kind,
        enclosingFuncQn: '',
        direction: (ch.kind === 'publish' || ch.kind === 'emit') ? 'emit' as const : 'listen' as const,
        startLine: ch.startLine,
      })),
      throws: (result.throws || []).map((t) => ({
        exceptionName: t.exceptionName,
        enclosingFuncQn: t.enclosingFuncQn,
        startLine: t.startLine,
      })),
      decorators: (result.decorators || []).map((d) => ({
        name: d.name,
        targetQn: d.targetQn,
        startLine: d.startLine,
      })),
      hasError: result.hasError,
      errorMsg: result.errorMsg,
      isTestFile: result.isTestFile,
      language: result.language,
      partialReasons: result.partialReasons,
    };
  }

  // Unsupported language — return empty result
  return {
    nodes: [],
    calls: [],
    imports: [],
    usages: [],
    channels: [],
    throws: [],
    decorators: [],
    hasError: false,
    errorMsg: `Unsupported language: ${ext}`,
    isTestFile: false,
    language: ext || 'unknown',
  };
}

// ── TypeScript-specific extraction (existing code) ─────────────────
