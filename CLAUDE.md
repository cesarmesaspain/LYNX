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

## Herramientas esenciales
- `search_graph` + `get_code_snippet` — definiciones y fuente exacta.
- `trace_path` — callers, callees, flujo de datos.
- `query_graph` — metricas, agregaciones, relaciones cruzadas.
- `batch_get_code` — comparar varios simbolos en una sola llamada.
- `find_tests` — cuando la cobertura de tests sea relevante.
<!-- lynx:end -->

# CLAUDE.md — LYNX

## Guia de investigacion con LYNX

Usa las herramientas MCP de LYNX cuando la tarea necesite evidencia estructural, relaciones entre simbolos, flujo de llamadas, impacto o contexto amplio.
Para lecturas exactas, busquedas puntuales o archivos no indexados, usa herramientas directas cuando sean mas precisas y eficientes.
Elige el conjunto minimo de herramientas que resuelva la incertidumbre material, reutiliza la evidencia ya obtenida y detente cuando sea suficiente.
Reserva pack_context para tareas amplias o multisimbolo, trace_path para flujo relevante y find_tests cuando la cobertura sea material.

---

Ultima actualizacion: 2026-07-11 CEST. **Motor puro + onboarding completo + medicion comercial + benchmark agent A/B.**

LYNX es un servidor MCP de inteligencia de codigo que indexa repositorios en SQLite y expone un grafo de conocimiento con 31 herramientas MCP. Extrae definiciones, llamadas, imports, usos, herencia, rutas HTTP, canales, dependencias y mas — con extractor nativo C para TS/TSX y fallback WASM para 159 lenguajes.

## Onboarding (Fase 9 completada — 2026-07-09)

Comandos en `src/install/` (6 archivos):

```bash
lynx install      # detecta agentes, escribe MCP config, hooks, SKILL.md
lynx init          # stats reales del proyecto → CLAUDE.md/AGENTS.md
lynx doctor        # diagnostico: binario, BD, MCP, hooks, licencia
lynx uninstall     # limpia todo lo que install creo
```

Flags: `--dry-run` en install/init/uninstall. Todo es idempotente. Backup automatico antes de escribir archivos.

Agentes detectados: Claude Code (.mcp.json), Codex CLI (config.toml), VS Code (mcp.json), Cursor, Zed, Gemini CLI, OpenCode.

Cobertura de lenguajes: 159 lenguajes activos en `src/extraction/language-registry.ts`. 83 tienen WASM/tree-sitter disponible. 75 usan fallback textual seguro si no hay WASM.

## Decision tecnica clave

El hot path no debe quedar 100% en TypeScript. LYNX usa estrategia hibrida:

- TS/TSX: extractor nativo C opcional (`native/lynx_ts_extractor.c`).
- Otros lenguajes: tree-sitter WASM / JS workers.
- Fallback: si el binario nativo no existe o falla, LYNX sigue funcionando con JS/WASM.

Esto mantiene portabilidad. Para producto se distribuyen binarios precompilados por plataforma (macOS arm64/x64, Linux x64/arm64, Windows x64) con fallback JS/WASM.

## Pipeline

4 fases en `src/pipeline/`: discover → extract → resolve → analyze.

- **discover.ts**: enumera archivos con exclusiones agresivas en modo fast.
- **extract.ts**: worker pool real con `worker_threads` + extractor nativo C con sharding (`LYNX_NATIVE_SHARDS`, default auto hasta 8). Extraccion ~420ms.
- **resolve.ts**: 15 passes especializados sobre batches de extraccion con indices en memoria. Resuelve CALLS, IMPORTS, USAGE, READS, WRITES, HERITAGE, ROUTES, CHANNELS, DEPENDENCIES, etc. ~565ms.
- **analyze.ts**: calcula complejidad, hotspots, clusters.

## Binario unico (Fase 6 completada)

Binario funcional (~199MB, macOS arm64) con:

```bash
npm run bundle       # node20-macos-arm64
npm run bundle:all   # todas las plataformas
```

Limitaciones del binario: el extractor nativo C se empaqueta y funciona si la plataforma coincide (se copia de VFS a tmp en runtime). `tree-sitter` npm nativo (node-gyp-build) esta deshabilitado en pkg — solo se usa el extractor C via `spawn`. Sin worker threads. ~14.8s vs ~1.9s dev. Aceptable para v0.1.
Para cross-compilacion usa `--all` en build-native-extractor.js (requiere cross-compilers) o setea `LYNX_NATIVE_EXTRACTOR_PATH` en runtime.

## LLM Hibrido (Fase 2 completada)

Modulo `src/llm/` con 7 archivos. LLM heuristico siempre activo (reglas deterministicas). DeepSeek V4 Flash opcional si `LYNX_DEEPSEEK_KEY` esta seteada. Cache LRU por SHA256. El heuristico mejora TESTS_FILE de 12 a 1033 edges. Binario-safe.

## Medicion comercial (Fase 10 completada)

LYNX mide valor localmente en `~/.lynx/usage.jsonl`:

- `lynx benchmark <path> --name <project> --query "a,b,c"` — reporte vendible.
- `lynx report [project]` — HTML local para demo/venta.
- `lynx usage [project]` — resumen de ahorro acumulado.
- `lynx usage export [project] --out <file>` — export JSON.
- `lynx usage clear [project]` — limpia eventos locales.
- Rerank semantico medido por separado: proveedor, latencia, coste estimado.
- `usage.jsonl` rota automaticamente si supera 5MB.

## Action Graph 3D

Dashboard local con canvas 3D en `GET /api/action-graph?project=<name>&mode=value|risk|entry|hotspot`. Sin dependencias extra. Colores por rol (verde=valor, rojo=riesgo, azul=entry, naranja=hotspot). Click en nodo muestra detalles y recomendacion de tool.

## Benchmark Agent A/B (Fase 11)

`src/cli/agent-ab/benchmark.ts` — comparativa controlada entre un agente LLM con herramientas LYNX vs solo `read_file` + `grep`. Usa DeepSeek V4 Flash con temperatura 0 y seeds fijas. Resultados en `benchmarks/results/`.

```bash
# Basico: 1 tarea, 1 ronda
node dist/cli.js agent-ab --project-dir /path/to/project --tasks external_project_overview --seed 42

# Multi-turn encadenado: 2 preguntas en la MISMA conversacion
node dist/cli.js agent-ab --project-dir /path/to/project --tasks external_project_overview,external_simple_techstack --chained --seed 42

# Suite completa con warmup
node dist/cli.js agent-ab --project-dir /path/to/project --suite realistic --warmup 1 --rounds 3 --seed 42
```

Flags: `--tasks` (ids separados por coma), `--chained` (tareas en pares con contexto compartido), `--seed`, `--rounds`, `--warmup`, `--model`, `--dry-run`, `--json`, `--csv`, `--out`, `--include-trace`, `--suite` (default|realistic).

14 tipos de tareas externas: `external_project_overview`, `external_simple_techstack`, `external_config_lookup`, `external_tiny_config`, `external_impact_analysis`, `external_dead_code`, `external_multi_turn`, `external_generic_architecture`, `external_trade_flow`, `external_safety_change_impact`, `external_trade_incident_triage`, `external_missing_tests`, `external_semantic_discovery`, `external_scalability_snapshot`.

Auto-save: cada run persiste 3 archivos en `benchmarks/results/` + entrada en `_index.jsonl`. Dry-run no guarda.

Hallazgos clave (10 runs historicas):
- LYNX gana 9/10 benchmarks (~59-75% ahorro en coste)
- ~22% de runs baseline fallan por limite de contexto (1M tokens DeepSeek) — victoria estructural de LYNX
- LYNX solo pierde en lecturas triviales de 1 archivo (ambos <$0.001)
- Dead code detection es matematicamente imposible sin grafo
- La metodologia (conversacion fresca por tarea) subestima la ventaja de LYNX: en sesiones reales multi-turn, las tool definitions se amortizan

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
