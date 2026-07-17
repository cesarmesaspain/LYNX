<!-- lynx-tools:start -->
## MCP Tools (31)

**Busqueda:** `search_graph`, `semantic_search`, `search_code`

**Navegacion:** `trace_path`, `query_graph`, `get_code_snippet`, `batch_get_code`, `get_edge_evidence`, `investigate_symbol`

**Analisis:** `explain_symbol`, `smart_review`, `analyze_hotspots`, `find_tests`, `find_dead_code`, `assess_impact`

**Contexto:** `pack_context`, `pack_memory`, `get_architecture`, `get_graph_schema`

**Gestion:** `index_repository`, `index_status`, `list_projects`, `delete_project`, `diagnose`

**Cambios:** `detect_changes`, `compare_runs`, `watch_project`

**ADR:** `manage_adr`

**Trazas:** `ingest_traces`

**Utilidades:** `tool_catalog`, `usage_summary`

<!-- lynx-tools:end -->

<!-- lynx:start -->
# LYNX MCP — REGLA DE PRIORIDAD ABSOLUTA

Proyecto `lynx`: **6,708 nodos**, **24,127 aristas**, 368 archivos, ts, yml, gitignore.


**REGLA BLOQUEANTE:** Para cualquier tarea de codigo, la primera herramienta que uses debe ser LYNX. 
No puedes usar Bash, Read, Grep ni Glob antes de haber consultado LYNX. 
El proyecto esta indexado — si no usas LYNX primero, estas perdiendo tokens y tiempo innecesariamente.

**Excepcion unica:** solo despues de que una consulta LYNX no resuelva la duda, puedes caer a herramientas de archivo.
Tambien puedes usar herramientas de archivo directamente para: configuracion, JSON, .env, Dockerfiles o literales que LYNX no indexa.

**Criterio:** usa la herramienta LYNX mas pequena que aporte evidencia suficiente. Reutiliza resultados. No amplies hasta que falte evidencia.

## Arranque
1. Si el proyecto no esta indexado o esta desactualizado, ejecuta `index_repository` sin preguntar.
2. No declares que LYNX no esta disponible. Si las tools no aparecen, cargalas bajo demanda.
3. Para tareas amplias, `pack_context(task, "lynx")` es obligatorio.
<!-- lynx:end -->

# CLAUDE.md — LYNX

Ultima actualizacion: 2026-07-17. **Motor puro + 55 lenguajes + perfil core por defecto.**

LYNX indexa repositorios en SQLite y expone un grafo de conocimiento con 31 herramientas MCP (17 visibles en perfil core). Extrae definiciones, llamadas, imports, herencia, rutas HTTP, canales y dependencias — extractor nativo C para TS/TSX, fallback WASM para otros lenguajes.

## Onboarding

`lynx install` (detecta agentes, escribe MCP config/hooks), `lynx init` (stats → CLAUDE.md), `lynx doctor` (diagnostico), `lynx uninstall`. Flags: `--dry-run`. Idempotente con backup. Detecta Claude Code, Codex, VS Code, Cursor, Zed, Gemini CLI, OpenCode.

## Pipeline

4 fases en `src/pipeline/`: discover → extract → resolve → analyze. Extractor nativo C con sharding (~420ms). 15 passes de resolucion (~565ms): CALLS, IMPORTS, USAGE, READS, WRITES, HERITAGE, ROUTES, CHANNELS, DEPENDENCIES.

## Binario unico

`npm run bundle` / `npm run bundle:all`. ~199MB macOS arm64. Sin worker threads. ~14.8s vs ~1.9s dev. `LYNX_NATIVE_EXTRACTOR_PATH` para cross-compilacion.

## LLM Hibrido

Heuristico siempre activo. DeepSeek V4 Flash opcional (`LYNX_DEEPSEEK_KEY`). Cache LRU por SHA256. Binario-safe.

## Medicion comercial

`lynx benchmark|report|usage|usage export|usage clear`. Rerank semantico medido. `usage.jsonl` rota a 5MB.

## Action Graph 3D

Dashboard 3D local: `GET /api/action-graph?project=<name>&mode=value|risk|entry|hotspot`. Click en nodo → tool recomendada.

## Benchmark Agent A/B

`src/cli/agent-ab/benchmark.ts` — comparativa LYNX vs `read_file`+`grep`. DeepSeek V4 Flash, temp 0, seeds fijas. Flags: `--tasks`, `--chained`, `--suite` (default|realistic), `--rounds`, `--warmup`, `--seed`, `--model`, `--dry-run`, `--json`, `--csv`, `--out`. Auto-save en `benchmarks/results/`. 14 tipos de tareas (ver `src/cli/agent-ab/`).

Hallazgos: LYNX gana 9/10 benchmarks (~59-75% ahorro). ~22% baseline fallan por contexto (victoria estructural). Dead code detection imposible sin grafo.

## Auto-index y watcher

- `~/.lynx/config.json` guarda `auto_index`, `auto_index_limit` y `auto_watch`.
- El MCP hace auto-index al arrancar si `auto_index=true`, limite 50K archivos.
- Si `auto_watch=true`, arranca watcher automatico tras el auto-index.
- Claude recibe hook `PreToolUse` no bloqueante que aumenta grep/glob con resultados del grafo (timeout 5s, deadline interno 300ms).

## Comandos de validacion

```bash
npm run typecheck   # 0 errors
npm run build       # 0 errors
npm test            # todos los tests pasan
node dist/cli.js doctor           # 7/7 checks
node dist/cli.js install --plan   # verifica sin escribir
```

## Nota comercial

No presentar al usuario final que LYNX usa LLM. Si se anaden features con modelos baratos, deben comunicarse como inteligencia interna, scoring, resumen o analisis avanzado. No exponer API keys ni proveedor.

## Pendiente

- Fase 7: Capa Comercial — licencias JWT, Stripe, tiers Free/Pro/Team.
- Fase 5: Web Dashboard (Fastify + D3.js).
- Optimizar velocidad del binario (14.8s → <5s).
- Empaquetar extractor nativo C por plataforma en el binario.
- Mejorar precision del extractor C: imports nombrados, exports, arrow functions, metodos de clase.
- Reducir tiempo CLI hacia 2.0s.
- Tests de integracion y CI.

## Regla para seguir

No revertir cambios ajenos en `NEW_WEBSITE`. Este repo tiene mucho trabajo no relacionado fuera de `LYNX`. Si Claude continua, debe concentrarse en LYNX y no tocar runtime de MENTESIA salvo pedido explicito.
