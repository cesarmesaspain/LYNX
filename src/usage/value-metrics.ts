/*
 * value-metrics.ts — Honest, layered value attribution for MCP responses.
 *
 * Tokens are an efficiency signal, not proof that an error was prevented.
 * Keep observed savings separate from the wider exploration potential and
 * expose graph evidence as a decision-quality signal.
 */

export interface ProjectValueContext {
  files: number;
  symbols: number;
}

type Confidence = 'low' | 'medium' | 'high';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function resultFileCount(result: Record<string, unknown>): number {
  const entries = [result.results, result.callers, result.callees, result.findings, result.candidates]
    .filter(Array.isArray)
    .flat() as Array<Record<string, unknown>>;
  return new Set(entries
    .map(entry => String(entry.file ?? entry.file_path ?? ''))
    .filter(Boolean)).size;
}

/** Add the v2 layered contract without changing legacy top-level fields. */
export function layerValueMetrics(
  raw: Record<string, unknown>,
  context: ProjectValueContext,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const observedTokens = Math.max(0, Number(raw.estimated_tokens_saved || 0));
  const observedFiles = Math.max(0, Number(raw.estimated_files_avoided || 0));
  const reportedConfidence = (raw.confidence === 'high' || raw.confidence === 'medium' ? raw.confidence : 'low') as Confidence;
  const density = context.files > 0 ? context.symbols / context.files : 0;
  // Discovery grows sub-linearly with the actual search space. It is a range,
  // not a multiplier applied to the observed result.
  const discovery = Math.round(Math.min(1_200,
    90 * Math.log2(Math.max(2, context.files + 1)) + Math.min(480, density * 8)));
  const fullFilePotential = Math.max(observedTokens, Number(raw.full_file_potential_tokens || 0));
  const likely = fullFilePotential > observedTokens
    ? Math.round(observedTokens + (fullFilePotential - observedTokens) * 0.35)
    : observedTokens + discovery;
  const maximum = fullFilePotential > observedTokens
    ? fullFilePotential
    : Math.round(likely * 1.3);

  const callers = arrayCount(result.callers);
  const callees = arrayCount(result.callees);
  const results = arrayCount(result.results) || arrayCount(result.findings) || arrayCount(result.candidates);
  const profile = asRecord(result.relationship_profile);
  const edgeCounts = asRecord(profile.edge_counts);
  const directDependencies = Number(edgeCounts.CALLS || 0) || callers + callees;
  const hasTests = arrayCount(result.tests) > 0 || arrayCount(result.test_files) > 0;
  const empty = observedTokens === 0 && results + callers + callees === 0;
  const indirect = Object.keys(edgeCounts).some((edge) => edge !== 'CALLS');
  const explicitConflict = raw.evidence_conflict === true || result.evidence_conflict === true;
  // Search and context-packing return useful pointers, but do not themselves
  // verify a relationship. Never present that as reinforced graph evidence.
  const decisionStatus = explicitConflict
    ? 'conflicting_evidence'
    : empty
      ? 'evidence_gap'
      : directDependencies > 0 && !indirect && reportedConfidence !== 'low'
        ? 'confirmed'
        : 'partial';
  const confidence: Confidence = decisionStatus === 'confirmed'
    ? reportedConfidence
    : 'low';
  const evidenceFiles = resultFileCount(result);
  const ambiguities = [
    ...(empty ? ['empty_result'] : []),
    ...(explicitConflict ? ['conflicting_evidence'] : []),
    ...(indirect ? ['indirect_relationships'] : []),
    ...(decisionStatus === 'partial' ? ['limited_structural_evidence'] : []),
    ...(confidence === 'low' ? ['limited_evidence'] : []),
  ];
  const measurement = stringValue(raw.measurement) || 'conservative_result_attribution';
  const potentialBasis = stringValue(raw.potential_basis) ||
    (fullFilePotential > observedTokens ? 'full-file upper bound; not observed savings' : 'project search-space estimate');

  return {
    ...raw,
    // Existing consumers retain these fields. They now explicitly mean the
    // conservative observed layer rather than a claimed financial outcome.
    estimated_tokens_saved: observedTokens,
    estimated_files_avoided: observedFiles,
    confidence,
    observed_savings: {
      tokens_saved: observedTokens,
      files_avoided: observedFiles,
      confidence,
      basis: measurement,
    },
    exploration_potential: {
      conservative_tokens: observedTokens,
      likely_tokens: likely,
      maximum_reasonable_tokens: maximum,
      confidence: decisionStatus === 'confirmed' ? reportedConfidence : 'low',
      project_context: { files: context.files, symbols_per_file: Number(density.toFixed(1)) },
      basis: potentialBasis,
    },
    structural_confidence: {
      decision_status: decisionStatus,
      verified_dependencies: directDependencies,
      files_affected: evidenceFiles,
      test_evidence: hasTests ? 'present' : 'not_observed',
      ambiguities_detected: ambiguities,
      confidence,
      note: decisionStatus === 'evidence_gap'
        ? 'No attributable result: verify whether the empty result is expected before relying on it.'
        : decisionStatus === 'conflicting_evidence'
          ? 'The available evidence conflicts; verify the source and graph before relying on this result.'
          : directDependencies > 0
            ? `Graph-backed evidence covers ${directDependencies} verified relationship(s); this reduces uncertainty, not a provable count of prevented errors.`
            : 'The result identifies candidate symbols but does not verify their relationships. Trace or inspect the symbol before making an impact decision.',
    },
  };
}
