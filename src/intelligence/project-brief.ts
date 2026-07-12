import { createHash } from 'node:crypto';
import type { LynxDatabase } from '../store/database.js';
import { isPkg } from '../paths.js';
import { readLynxConfig } from '../config/runtime.js';

const FLASH_INPUT_USD_PER_M = 0.14;
const FLASH_OUTPUT_USD_PER_M = 0.28;

interface BriefMetrics {
  nodes: number;
  edges: number;
  files: number;
  edgeTypes: number;
  entryPoints: number;
  hotspots: number;
  riskyNodes: number;
}

interface DigestRow {
  name: string;
  kind?: string;
  file_path: string;
  qualified_name?: string;
  fan_in?: number;
  fan_out?: number;
  count?: number;
}

interface ProjectDigest {
  project: string;
  rootPath: string;
  metrics: BriefMetrics;
  topDirectories: Array<{ path: string; files: number }>;
  edgeTypes: Array<{ type: string; count: number }>;
  entryPoints: DigestRow[];
  hotspots: DigestRow[];
  topFiles: DigestRow[];
  digestText: string;
  digestHash: string;
  inputTokensEst: number;
}

export interface ProjectBriefRow {
  project: string;
  digest_hash: string;
  brief: string;
  source: string;
  generated_at: string;
  input_tokens_est: number;
  output_tokens_est: number;
  cost_usd_est: number;
  metrics_json: string;
}

export interface ProjectBriefResult {
  row: ProjectBriefRow;
  generated: boolean;
}

export async function ensureProjectBrief(
  db: LynxDatabase,
  project: string,
  opts: { force?: boolean; changeThreshold?: number } = {}
): Promise<ProjectBriefResult | null> {
  const locale = readLynxConfig().locale;
  const digest = buildProjectDigest(db, project, locale);
  if (digest.metrics.nodes === 0) return null;

  const existing = getProjectBrief(db, project);
  const threshold = opts.changeThreshold ?? 0.18;
  if (existing && !opts.force) {
    if (existing.digest_hash === digest.digestHash) {
      return { row: existing, generated: false };
    }
    const previousMetrics = safeParseMetrics(existing.metrics_json);
    if (previousMetrics && changedRatio(previousMetrics, digest.metrics) < threshold) {
      return { row: existing, generated: false };
    }
  }

  const generated = await generateProjectBrief(digest);
  const outputTokensEst = estimateTokens(generated.brief);
  const costUsdEst =
    (digest.inputTokensEst / 1_000_000) * FLASH_INPUT_USD_PER_M +
    (outputTokensEst / 1_000_000) * FLASH_OUTPUT_USD_PER_M;

  db.db.prepare(`
    INSERT INTO project_briefs (
      project, digest_hash, brief, source, generated_at,
      input_tokens_est, output_tokens_est, cost_usd_est, metrics_json
    ) VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)
    ON CONFLICT(project) DO UPDATE SET
      digest_hash = excluded.digest_hash,
      brief = excluded.brief,
      source = excluded.source,
      generated_at = excluded.generated_at,
      input_tokens_est = excluded.input_tokens_est,
      output_tokens_est = excluded.output_tokens_est,
      cost_usd_est = excluded.cost_usd_est,
      metrics_json = excluded.metrics_json
  `).run(
    project,
    digest.digestHash,
    generated.brief,
    generated.source,
    digest.inputTokensEst,
    outputTokensEst,
    costUsdEst,
    JSON.stringify(digest.metrics)
  );

  const row = getProjectBrief(db, project);
  return row ? { row, generated: true } : null;
}

export function getProjectBrief(db: LynxDatabase, project: string): ProjectBriefRow | null {
  const row = db.db.prepare(`
    SELECT project, digest_hash, brief, source, generated_at,
      input_tokens_est, output_tokens_est, cost_usd_est, metrics_json
    FROM project_briefs
    WHERE project = ?
  `).get(project) as ProjectBriefRow | undefined;
  return row || null;
}

function buildProjectDigest(db: LynxDatabase, project: string, locale: 'es' | 'en' = 'es'): ProjectDigest {
  const projectRow = db.db
    .prepare('SELECT root_path FROM projects WHERE name = ?')
    .get(project) as { root_path?: string } | undefined;

  const metrics = db.db.prepare(`
    WITH degree AS (
      SELECT n.id,
        COALESCE((SELECT COUNT(*) FROM edges e WHERE e.project = n.project AND e.target_id = n.id), 0) AS fan_in,
        COALESCE((SELECT COUNT(*) FROM edges e WHERE e.project = n.project AND e.source_id = n.id), 0) AS fan_out
      FROM nodes n
      WHERE n.project = ? AND n.kind NOT IN ('Folder')
    )
    SELECT
      (SELECT COUNT(*) FROM nodes WHERE project = ?) AS nodes,
      (SELECT COUNT(*) FROM edges WHERE project = ?) AS edges,
      (SELECT COUNT(DISTINCT file_path) FROM nodes WHERE project = ? AND TRIM(file_path) != '') AS files,
      (SELECT COUNT(DISTINCT type) FROM edges WHERE project = ?) AS edgeTypes,
      (SELECT COUNT(*) FROM nodes WHERE project = ? AND is_entry_point = 1) AS entryPoints,
      SUM(CASE WHEN fan_in + fan_out >= 30 THEN 1 ELSE 0 END) AS hotspots,
      SUM(CASE WHEN fan_in >= 10 THEN 1 ELSE 0 END) AS riskyNodes
    FROM degree
  `).get(project, project, project, project, project, project) as BriefMetrics;

  const edgeTypes = db.db.prepare(`
    SELECT type, COUNT(*) AS count
    FROM edges
    WHERE project = ?
    GROUP BY type
    ORDER BY count DESC
    LIMIT 16
  `).all(project) as Array<{ type: string; count: number }>;

  const entryPoints = db.db.prepare(`
    SELECT name, kind, qualified_name, file_path
    FROM nodes
    WHERE project = ? AND is_entry_point = 1
    ORDER BY kind, file_path
    LIMIT 20
  `).all(project) as DigestRow[];

  const hotspots = db.db.prepare(`
    SELECT n.name, n.kind, n.qualified_name, n.file_path,
      COALESCE((SELECT COUNT(*) FROM edges e WHERE e.project = n.project AND e.target_id = n.id), 0) AS fan_in,
      COALESCE((SELECT COUNT(*) FROM edges e WHERE e.project = n.project AND e.source_id = n.id), 0) AS fan_out
    FROM nodes n
    WHERE n.project = ? AND n.kind NOT IN ('Folder')
    ORDER BY (fan_in + fan_out) DESC
    LIMIT 20
  `).all(project) as DigestRow[];

  const topFiles = db.db.prepare(`
    SELECT file_path, COUNT(*) AS count
    FROM nodes
    WHERE project = ? AND TRIM(file_path) != ''
    GROUP BY file_path
    ORDER BY count DESC
    LIMIT 18
  `).all(project) as DigestRow[];

  // Language counts from File nodes
  const langRows = db.db.prepare(`
    SELECT properties FROM nodes WHERE project = ? AND kind = 'File'
  `).all(project) as { properties: string }[];

  const langMap = new Map<string, number>();
  for (const lr of langRows) {
    const props = JSON.parse(lr.properties || '{}');
    const ext = props.extension || 'unknown';
    langMap.set(ext, (langMap.get(ext) || 0) + 1);
  }
  const languages = Array.from(langMap.entries())
    .map(([language, fileCount]) => `${language}:${fileCount}`)
    .sort((a, b) => {
      const ca = parseInt(a.split(':')[1] || '0', 10);
      const cb = parseInt(b.split(':')[1] || '0', 10);
      return cb - ca;
    })
    .slice(0, 12);

  const topDirectories = topFiles.reduce<Array<{ path: string; files: number }>>((acc, row) => {
    const dir = String(row.file_path).split('/').slice(0, 3).join('/') || '.';
    const found = acc.find((item) => item.path === dir);
    if (found) found.files += 1;
    else acc.push({ path: dir, files: 1 });
    return acc;
  }, []).sort((a, b) => b.files - a.files).slice(0, 12);

  const digestText = [
    `Project: ${project}`,
    `Root: ${projectRow?.root_path || ''}`,
    `Metrics: ${metrics.nodes} nodes, ${metrics.edges} edges, ${metrics.files} files, ${metrics.edgeTypes} edge types, ${metrics.entryPoints} entry points, ${metrics.hotspots || 0} hotspots, ${metrics.riskyNodes || 0} risky nodes.`,
    `Languages: ${languages.join(', ') || 'none'}`,
    `Top directories: ${topDirectories.map((d) => `${d.path} (${d.files})`).join(', ')}`,
    `Edge types: ${edgeTypes.map((e) => `${e.type}:${e.count}`).join(', ')}`,
    `Entry points: ${entryPoints.map((e) => `${e.kind} ${e.qualified_name || e.name} @ ${e.file_path}`).join('; ')}`,
    `Hotspots: ${hotspots.map((h) => `${h.kind} ${h.qualified_name || h.name} @ ${h.file_path} fanIn=${h.fan_in} fanOut=${h.fan_out}`).join('; ')}`,
    `Top files: ${topFiles.map((f) => `${f.file_path}:${f.count}`).join(', ')}`,
  ].join('\n');

  return {
    project,
    rootPath: projectRow?.root_path || '',
    metrics: {
      ...metrics,
      hotspots: metrics.hotspots || 0,
      riskyNodes: metrics.riskyNodes || 0,
    },
    topDirectories,
    edgeTypes,
    entryPoints,
    hotspots,
    topFiles,
    digestText,
    digestHash: createHash('sha256').update(`${locale}\n${digestText}`).digest('hex'),
    inputTokensEst: estimateTokens(digestText),
  };
}

async function generateProjectBrief(digest: ProjectDigest): Promise<{ brief: string; source: string }> {
  const locale = readLynxConfig().locale;
  const prompt = projectBriefPrompt(digest.digestText, locale);
  const apiBrief = await callManagedIntelligence(prompt);
  if (apiBrief) return { brief: sanitizeBrief(apiBrief), source: 'api' };

  const directBrief = await callDeepSeek(prompt);
  if (directBrief) return { brief: sanitizeBrief(directBrief), source: 'deepseek' };

  return { brief: heuristicProjectBrief(digest), source: 'local' };
}

function projectBriefPrompt(digestText: string, locale: 'es' | 'en'): string {
  const language = locale === 'es' ? 'espanol' : 'English';
  const titles = locale === 'es'
    ? ['Que es <project>', 'Arquitectura', 'Puntos de entrada', 'Zonas criticas', 'Como trabajar con seguridad']
    : ['What is <project>', 'Architecture', 'Entry points', 'Critical areas', 'How to work safely'];
  return `Eres LYNX, un motor de inteligencia de codigo. A partir de este digest del grafo, escribe un Architecture Brief util para onboarding tecnico.

Responde SOLO con un objeto JSON valido con esta estructura exacta (sin markdown, sin backticks, solo el JSON puro):
{
  "sections": [
    {"title": "${titles[0]}", "content": "Brief descriptive paragraph."},
    {"title": "${titles[1]}", "content": "Architecture paragraph."},
    {"title": "${titles[2]}", "content": "Entry points paragraph."},
    {"title": "${titles[3]}", "content": "Critical areas paragraph."},
    {"title": "${titles[4]}", "content": "Practical recommendations paragraph."}
  ]
}

Reglas:
- Responde en ${language}.
- Cada "content" entre 50 y 150 palabras.
- Los titulos deben ser exactamente los 5 indicados arriba (sustituye <project> por el nombre real).
- En la seccion "Que es <project>", incluye una frase sobre el stack tecnologico traduciendo las extensiones de la linea "Languages" del digest a nombres humanos (.ts → TypeScript, .kt → Kotlin, .py → Python, .tsx → React TSX, .css → CSS, .json → JSON, etc.). No incluyas el conteo de archivos por lenguaje.
- NO incluyas cifras concretas (nodos, edges, archivos, hotspots, entry points) en ningun content. Esos numeros van en las tarjetas del dashboard y cambian con cada re-index. Describe todo cualitativamente.
- No menciones LLM, IA, prompts ni proveedores.
- No inventes frameworks no visibles en el digest.
- Usa tono claro, preciso y orientado a accion.
- Recomienda trace_path para zonas de alto impacto.
- NO incluyas markdown ni backticks de codigo en la respuesta. Solo el JSON puro.

DIGEST:
${digestText}`;
}

async function callManagedIntelligence(prompt: string): Promise<string | null> {
  if (isPkg()) return null;
  const url = process.env.LYNX_API_URL || '';
  const key = process.env.LYNX_API_KEY || '';
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}/v1/intelligence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ task: 'project_brief', payload: { prompt } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { result?: string };
    return data.result || null;
  } catch {
    return null;
  }
}

async function callDeepSeek(prompt: string): Promise<string | null> {
  if (isPkg()) return null;
  const key = process.env.LYNX_DEEPSEEK_KEY || '';
  if (!key) return null;
  const locale = readLynxConfig().locale;
  const sysContent = locale === 'es'
    ? 'Eres un arquitecto de software. Respondes en espanol, con precision y sin relleno.'
    : 'You are a software architect. Respond in English, with precision and no filler.';
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1100,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

function heuristicExtToName(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'React TSX', '.js': 'JavaScript', '.jsx': 'React JSX',
    '.py': 'Python', '.kt': 'Kotlin', '.java': 'Java', '.swift': 'Swift',
    '.go': 'Go', '.rs': 'Rust', '.c': 'C', '.h': 'C Header', '.cpp': 'C++',
    '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.dart': 'Dart', '.lua': 'Lua',
    '.sql': 'SQL', '.graphql': 'GraphQL', '.json': 'JSON', '.yaml': 'YAML',
    '.yml': 'YAML', '.xml': 'XML', '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
    '.md': 'Markdown', '.mdx': 'MDX', '.toml': 'TOML', '.vue': 'Vue', '.svelte': 'Svelte',
  };
  const lower = ext.toLowerCase();
  if (map[lower]) return map[lower];
  if (lower.startsWith('.')) return lower.slice(1).toUpperCase();
  return lower;
}

function heuristicProjectBrief(digest: ProjectDigest): string {
  const locale = readLynxConfig().locale;
  const isEn = locale === 'en';

  const topDirs = digest.topDirectories.map((d) => d.path).slice(0, 6).join(', ')
    || (isEn ? 'no notable directories' : 'sin directorios destacados');
  const entries = digest.entryPoints.slice(0, 6).map((e) => `${e.name} (${e.file_path})`).join(', ')
    || (isEn ? 'none detected' : 'no detectados');
  const hotspots = digest.hotspots.slice(0, 6).map((h) => `${h.name} (${h.file_path})`).join(', ')
    || (isEn ? 'no notable hotspots' : 'sin hotspots destacados');
  const edgeTypes = digest.edgeTypes.slice(0, 8).map((e) => e.type).join(', ')
    || (isEn ? 'no notable relationships' : 'sin relaciones destacadas');

  // Extract tech stack from digest text (language names only, no file counts)
  const langMatch = digest.digestText.match(/^Languages: (.+)$/m);
  const langStr = langMatch ? langMatch[1] : '';
  const langNames = langStr ? langStr.split(', ').slice(0, 6).map((pair) => {
    const ext = (pair.split(':')[0] || '').trim();
    const name = heuristicExtToName(ext);
    return name === 'UNKNOWN' || name === 'unknown' ? null : name;
  }).filter(Boolean) : [];

  const stackSentence = langNames.length > 0
    ? (isEn ? ` Tech stack: ${langNames.join(', ')}.` : ` Stack tecnologico: ${langNames.join(', ')}.`)
    : '';

  if (isEn) {
    return JSON.stringify({
      sections: [
        {
          title: `What is ${digest.project}`,
          content: `${digest.project} is a project indexed by LYNX.${stackSentence} The code graph shows a clear foundation with identifiable entry points, high-connectivity zones, and traceable inter-module dependencies. Check the dashboard cards for up-to-date metrics.`,
        },
        {
          title: 'Architecture',
          content: `The most visible areas of the project are ${topDirs}. The dominant graph relationships are ${edgeTypes}, indicating LYNX can track both structural dependencies and call flow. Files with the most symbols and the highest edge density should be treated as an initial map for understanding responsibilities.`,
        },
        {
          title: 'Entry points',
          content: `Notable entry points are ${entries}. To start a task, it's best to begin from these nodes and use trace_path to see what calls, imports, and usages lie downstream.`,
        },
        {
          title: 'Critical areas',
          content: `The highest-impact areas are ${hotspots}. This doesn't mean they're poorly written — it means they concentrate dependencies. Any change there can affect more surface area than an isolated file.`,
        },
        {
          title: 'How to work safely',
          content: `Before modifying hotspots or symbols with high fan-in, use trace_path to measure impact and get_code_snippet to read the exact source. For intent-based searches, start with semantic_search or search_graph and limit context to the recommended nodes.`,
        },
      ],
    });
  }

  return JSON.stringify({
    sections: [
      {
        title: `Que es ${digest.project}`,
        content: `${digest.project} es un proyecto indexado por LYNX.${stackSentence} El grafo de codigo muestra una base con entradas claras, zonas de alta conectividad y dependencias trazables entre modulos. Consulta las tarjetas del dashboard para las metricas actualizadas.`,
      },
      {
        title: 'Arquitectura',
        content: `Las areas mas visibles del proyecto aparecen en ${topDirs}. Las relaciones dominantes del grafo son ${edgeTypes}, lo que indica que LYNX puede seguir tanto dependencias estructurales como flujo de llamadas. Los archivos con mas simbolos y las zonas con mas aristas deben tratarse como mapa inicial para entender responsabilidades.`,
      },
      {
        title: 'Puntos de entrada',
        content: `Los puntos de entrada destacados son ${entries}. Para empezar una tarea, conviene partir de estos nodos y usar trace_path para ver que llamadas, imports y usos quedan aguas abajo.`,
      },
      {
        title: 'Zonas criticas',
        content: `Las zonas de mayor impacto son ${hotspots}. No significa que esten mal, sino que concentran dependencias. Cualquier cambio ahi puede afectar mas superficie que un archivo aislado.`,
      },
      {
        title: 'Como trabajar con seguridad',
        content: `Antes de modificar hotspots o simbolos con mucho fan-in, usa trace_path para medir impacto y get_code_snippet para leer la fuente exacta. Para busquedas de intencion, empieza con semantic_search o search_graph y limita el contexto a los nodos recomendados.`,
      },
    ],
  });
}

function sanitizeBrief(text: string): string {
  const trimmed = text.replace(/\r/g, '').trim().slice(0, 6000);
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.sections && Array.isArray(parsed.sections) && parsed.sections.length > 0) {
      return JSON.stringify(parsed);
    }
  } catch {}
  return JSON.stringify(markdownToSections(trimmed));
}

function markdownToSections(md: string): { sections: Array<{ title: string; content: string }> } {
  const sections: Array<{ title: string; content: string }> = [];
  const parts = md.split(/\n## /);
  for (const part of parts) {
    const lines = part.trim().split('\n');
    const title = lines[0].replace(/^#+ /, '').trim();
    const content = lines.slice(1).join('\n').trim();
    if (title && content) {
      sections.push({ title, content });
    }
  }
  if (sections.length >= 3) {
    return { sections };
  }
  return {
    sections: [
      { title: 'Resumen', content: md.slice(0, 800) || 'Sin contenido disponible.' },
    ],
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function safeParseMetrics(raw: string): BriefMetrics | null {
  try {
    return JSON.parse(raw) as BriefMetrics;
  } catch {
    return null;
  }
}

function changedRatio(prev: BriefMetrics, next: BriefMetrics): number {
  const keys: Array<keyof BriefMetrics> = ['nodes', 'edges', 'files', 'edgeTypes', 'entryPoints', 'hotspots', 'riskyNodes'];
  const ratios = keys.map((key) => {
    const a = Number(prev[key] || 0);
    const b = Number(next[key] || 0);
    return Math.abs(b - a) / Math.max(a, b, 1);
  });
  return Math.max(...ratios);
}
