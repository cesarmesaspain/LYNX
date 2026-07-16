# LYNX Semantic-Aware Code Graph (SACG)
## Plano maestro de ingeniería

Versión: 0.1
Estado: fuente técnica canónica propuesta
Rama de ejecución: `codex/harden-and-operationalize`
Repositorio: `/Users/admin/Desktop/LYNX`

## 1. Misión

Transformar LYNX desde un grafo de símbolos y relaciones principalmente sintácticas en un sistema local-first capaz de representar, justificar y consultar el significado operativo de un sistema de software.

El SACG no será “un grafo con embeddings”. Será una memoria técnica verificable donde cada afirmación semántica pueda responder:

1. Qué significa.
2. Qué entidad o relación describe.
3. Qué evidencia la respalda.
4. Qué extractor, regla, traza o modelo la produjo.
5. Con qué confianza.
6. En qué versión del código era válida.
7. Qué contradicciones o incertidumbres existen.
8. Qué impacto tendría cambiarla.

La ventaja pionera de LYNX será combinar en un mismo núcleo:

- working tree local y watcher incremental;
- grafo estructural multilenguaje;
- semántica tipada y explicable;
- evidencia determinista y dinámica;
- inferencia LLM opcional, nunca autoritativa por sí sola;
- temporalidad y seguimiento de evolución;
- consultas compactas para agentes;
- federación local/shared con procedencia obligatoria;
- métricas auditables de calidad y utilidad.

## 1.1 Prioridad operativa inmediata

La evolución del SACG debe mejorar directamente la eficiencia del agente, no solo enriquecer el modelo de datos. Cada nueva capacidad semántica deberá evaluarse por su capacidad para:

- resolver preguntas completas con menos llamadas a herramientas;
- reducir tokens de entrada y contexto repetido;
- reducir latencia y coste;
- evitar sobreinvestigación una vez que la evidencia sea suficiente;
- producir respuestas compactas con evidencia y procedencia integradas;
- sustituir cadenas de consultas de bajo nivel por operaciones compuestas y verificables.

El benchmark se utilizará como instrumento de medición de estas mejoras, no como objetivo independiente del producto.

## 2. Diagnóstico del sistema actual

La base actual es valiosa y debe evolucionar, no reemplazarse:

- `resolveAll` ya ejecuta un pipeline modular de pasadas estructurales.
- `LynxNode` modela proyecto, símbolos, archivos, módulos, carpetas, ramas, dependencias, canales, símbolos externos, configuración y rutas.
- `LynxEdgeType` modela llamadas, imports, definiciones, herencia, tests, configuración, canales, dependencias y flujos.
- `LynxEdge.properties` almacena metadatos abiertos.
- `passSemanticLight` solo añade configuración y canales con confianza fija.
- `dedupeEdges` usa el JSON completo como parte de la identidad y no fusiona evidencias.
- SQLite persiste `nodes` y `edges`, pero no dispone de ledger de evidencia, claims, contradicciones ni vigencia temporal.
- `enrichFile` genera resumen, entry point y test file mediante caché, API, DeepSeek o heurística, pero su salida no es semántica tipada.
- La federación, procedencia de resultados, métricas y trabajo local ya ofrecen una base diferencial.

Limitaciones que el SACG debe resolver:

- identidad frágil ante renombrados y movimientos;
- semántica mezclada en JSON opaco;
- confianza no calibrada;
- ausencia de separación entre hecho, inferencia e hipótesis;
- ausencia de múltiples evidencias por relación;
- ausencia de contradicciones explícitas;
- ausencia de historia y vigencia;
- falta de conceptos de dominio, contratos, invariantes, efectos y ownership;
- LLM como texto auxiliar y no como productor controlado de claims;
- queries centradas en símbolos, no en intención, comportamiento y riesgo.

## 3. Invariantes permanentes del SACG

1. El código y las trazas observadas tienen prioridad sobre inferencias.
2. Ningún claim LLM es hecho autoritativo sin evidencia vinculada.
3. Toda relación semántica tiene procedencia, confianza y vigencia.
4. La ausencia de evidencia no se representa como certeza negativa.
5. Las contradicciones se conservan; no se ocultan mediante last-write-wins.
6. Reindexar el mismo contenido produce el mismo grafo lógico.
7. El hot path local funciona offline.
8. El working tree local prevalece sobre el índice compartido.
9. La degradación es explícita: deterministic, heuristic, inferred o unavailable.
10. Toda métrica de calidad puede trazarse hasta observaciones concretas.
11. Las migraciones son idempotentes, transaccionales y reversibles mediante backup.
12. La compatibilidad con `nodes`, `edges` y tools actuales se mantiene durante la transición.
13. Ninguna fase semántica bloquea la indexación estructural base.
14. Los secretos y fragmentos sensibles no salen del dispositivo sin permiso explícito.
15. La precisión tiene prioridad sobre el volumen de relaciones.

## 4. Arquitectura objetivo

### 4.1 Capas

A. Source State Layer
- Canonicaliza proyecto, repositorio, commit, branch y working tree.
- Calcula hashes de archivo, contenido y unidades semánticas.
- Detecta alta, modificación, borrado, movimiento y renombrado.
- Produce un `GraphSnapshot` lógico por ejecución.

B. Structural Graph Layer
- Conserva el pipeline actual: estructura, definiciones, herencia, imports, calls, routes, usages, throws, tests, channels, dependencies y decorators.
- Cada extractor produce observaciones, no aristas finales sin procedencia.

C. Semantic Claim Layer
- Representa afirmaciones tipadas sobre responsabilidades, conceptos de dominio, contratos, invariantes, efectos, datos, ownership, límites arquitectónicos, protocolos y riesgos.
- Un claim puede ser confirmado, probable, disputado, obsoleto o rechazado.

D. Evidence Ledger
- Almacena la evidencia que respalda o contradice claims y relaciones.
- Tipos: AST, type-system, literal, config, naming, import, call graph, test, runtime trace, coverage, git history, documentation, heuristic y LLM.
- Conserva ubicación, hash, extractor, versión, timestamp y polaridad.

E. Confidence and Reconciliation Engine
- Fusiona evidencias independientes.
- Penaliza dependencias correlacionadas, contradicciones y antigüedad.
- Nunca convierte una inferencia única en certeza.
- Explica el cálculo de confianza.

F. Temporal Graph Layer
- Mantiene identidad estable y versiones de nodos, relaciones y claims.
- Permite consultar `as_of`, detectar drift y explicar cuándo cambió una responsabilidad.
- Distingue `first_seen`, `last_seen`, `valid_from`, `valid_to` y `observed_at`.

G. Semantic Query and Ranking Layer
- Traduce intención a un plan híbrido de consulta.
- Combina filtros estructurales, travesía, texto, embeddings opcionales, claims y evidencia.
- Devuelve respuesta, evidencia compacta, incertidumbre y siguientes comprobaciones.

H. Federation Layer
- Une local y shared mediante identidad semántica estable.
- Prioriza working tree.
- Conserva procedencia local/shared/mixed/local_fallback.
- Evita fusionar claims incompatibles sin mostrar conflicto.

I. Observability and Quality Layer
- Mide precisión, recall, calibración, frescura, contradicción, latencia, tamaño y utilidad para agentes.
- Separa métricas medidas, estimadas y escenarios.

### 4.2 Flujo de indexación objetivo

discover
→ extract syntax
→ normalize observations
→ resolve structural identities
→ build structural relations
→ infer deterministic semantics
→ ingest tests/config/docs/history/traces
→ optional LLM claim proposal
→ validate claims
→ reconcile evidence
→ persist snapshot atomically
→ compute deltas and quality metrics
→ publish watcher event

## 5. Ontología SACG

### 5.1 Clases de entidad

Structural:
- Project, Repository, Folder, File, Module
- Function, Method, Class, Interface, Type, Enum, Variable
- Route, ConfigKey, Dependency, Channel, ExternalSymbol

Semantic:
- DomainConcept
- Capability
- Responsibility
- UseCase
- Actor
- DataEntity
- DataContract
- Invariant
- Precondition
- Postcondition
- SideEffect
- ErrorCondition
- Policy
- ArchitecturalBoundary
- Component
- Service
- Protocol
- Event
- Command
- Query
- OwnershipUnit
- Risk
- Assumption
- Decision

Operational:
- TestCase
- RuntimeTrace
- DeploymentUnit
- FeatureFlag
- DatabaseTable
- ApiEndpoint
- QueueTopic
- ScheduledJob
- SecretReference

Meta:
- Claim
- Evidence
- Observation
- Contradiction
- Snapshot
- ChangeSet

### 5.2 Familias de relación

Structural:
`DEFINES`, `CALLS`, `IMPORTS`, `INHERITS`, `IMPLEMENTS`, `OVERRIDES`, `CONTAINS`, `TESTS`.

Behavioral:
`READS`, `WRITES`, `EMITS`, `LISTENS_ON`, `THROWS`, `HANDLES`, `VALIDATES`, `TRANSFORMS`, `PERSISTS`, `AUTHORIZES`, `RETRIES`, `CACHES`.

Semantic:
`IMPLEMENTS_CAPABILITY`, `HAS_RESPONSIBILITY`, `REPRESENTS_CONCEPT`, `ENFORCES_INVARIANT`, `SATISFIES_CONTRACT`, `VIOLATES_CONTRACT`, `HAS_PRECONDITION`, `HAS_POSTCONDITION`, `CAUSES_EFFECT`, `DEPENDS_SEMANTICALLY_ON`.

Architecture:
`BELONGS_TO_COMPONENT`, `CROSSES_BOUNDARY`, `EXPOSES_PROTOCOL`, `OWNS_DATA`, `ALLOWED_TO_DEPEND_ON`, `FORBIDDEN_TO_DEPEND_ON`.

Evidence:
`SUPPORTED_BY`, `CONTRADICTED_BY`, `DERIVED_FROM`, `OBSERVED_IN`, `PROPOSED_BY`, `VALIDATED_BY`.

Temporal:
`SUPERSEDES`, `RENAMED_FROM`, `MOVED_FROM`, `SPLIT_FROM`, `MERGED_FROM`, `INTRODUCED_BY`, `REMOVED_BY`.

## 6. Identidad estable

Los IDs SQLite actuales seguirán siendo claves físicas, no identidad lógica.

Introducir `semantic_id` estable:

`sha256(project_namespace + entity_class + normalized_signature + structural_context)`

Reglas:

- funciones: firma normalizada, contenedor y huella estructural;
- archivos: identidad por contenido y lineage, no solo path;
- conceptos de dominio: namespace y nombre canónico;
- relaciones: source semantic_id + predicate + target semantic_id + scope;
- claims: subject + predicate + object/value + scope;
- evidencias: tipo + source hash + ubicación + extractor version.

El reconciliador debe asignar lineage ante movimientos y renombrados mediante señales ordenadas:

1. hash idéntico;
2. firma y cuerpo normalizados;
3. vecinos estructurales;
4. similitud AST;
5. git rename;
6. similitud semántica como último recurso, marcada como inferida.

## 7. Modelo de claims y evidencia

### 7.1 Claim

Campos mínimos:

- `claim_id`
- `project`
- `subject_semantic_id`
- `predicate`
- `object_semantic_id` o `value_json`
- `scope_json`
- `status`: proposed, active, disputed, rejected, superseded
- `confidence`
- `confidence_level`
- `first_seen_snapshot`
- `last_seen_snapshot`
- `valid_from`
- `valid_to`
- `created_by`
- `created_at`
- `updated_at`

### 7.2 Evidence

Campos mínimos:

- `evidence_id`
- `project`
- `evidence_type`
- `polarity`: supports, contradicts, neutral
- `source_kind`
- `source_path`
- `source_hash`
- `start_line`
- `end_line`
- `symbol_semantic_id`
- `extractor`
- `extractor_version`
- `payload_json`
- `strength`
- `independence_group`
- `observed_at`
- `snapshot_id`

### 7.3 Enlace claim-evidence

- peso aportado;
- motivo;
- validación aplicada;
- estado;
- timestamp.

## 8. Confianza explicable

La confianza no será un número arbitrario guardado por cada pass.

Cada evidencia produce una fuerza base configurable:

- type-system/AST exacto: 0.95
- traza runtime repetida: 0.95
- test ejecutado: 0.90
- referencia literal/config exacta: 0.85
- call/import resolution: 0.80
- documentación cercana y vigente: 0.65
- git co-change: 0.55
- naming heuristic: 0.35
- LLM con evidencia citada: 0.45
- LLM sin evidencia: máximo 0.20 y no publicable como hecho

La combinación debe:

- agrupar evidencia correlacionada;
- aumentar por fuentes independientes;
- reducir por contradicción;
- decaer por antigüedad cuando corresponda;
- aplicar ceilings por tipo;
- emitir explicación legible.

Niveles:

- verified: >= 0.90 y evidencia determinista suficiente
- high: >= 0.75
- medium: >= 0.50
- low: >= 0.25
- hypothesis: < 0.25

## 9. Evolución del esquema SQLite

Mantener `nodes` y `edges` como proyección compatible.

Añadir:

- `schema_migrations`
- `graph_snapshots`
- `semantic_entities`
- `semantic_entity_versions`
- `semantic_relations`
- `semantic_relation_versions`
- `semantic_claims`
- `evidence`
- `claim_evidence`
- `contradictions`
- `entity_lineage`
- `runtime_observations`
- `semantic_metrics`

Índices críticos:

- project + semantic_id
- project + entity_class
- subject + predicate
- source + relation_type
- target + relation_type
- claim status + confidence
- evidence source_hash
- snapshot validity
- lineage predecessor/successor

La primera migración SACG debe ser aditiva. La proyección legacy continuará alimentando handlers actuales. Solo tras paridad completa se permitirá que nuevas tools lean directamente del núcleo SACG.

## 10. Pipeline de inferencia

### Tier 0: deterministic
- AST, type system, imports, calls, inheritance, routes, config, schemas, tests.
- Publicable como hecho cuando la resolución es exacta.

### Tier 1: rule-based semantic
- patrones de framework;
- convenciones configurables;
- detección de handlers, repositorios, adaptadores, entidades, contratos y boundaries;
- siempre conserva regla y evidencia.

### Tier 2: repository context
- documentación;
- historial Git;
- co-change;
- ownership;
- test mapping;
- configuración de arquitectura.

### Tier 3: runtime
- traces;
- coverage;
- logs estructurados;
- eventos;
- perfiles de ejecución.

### Tier 4: LLM proposal
- propone claims en JSON Schema;
- debe citar semantic IDs y evidencias existentes;
- no crea símbolos físicos;
- pasa validadores deterministas;
- se rechaza si inventa rutas, líneas o entidades;
- queda marcado con modelo, prompt version y coste;
- puede operar localmente o por proveedor autorizado.

## 11. APIs y tools SACG

Nuevas tools previstas:

- `semantic_explain <entity>`
- `semantic_query <intent>`
- `why_related <a> <b>`
- `show_evidence <claim-or-relation>`
- `find_responsibility <concept>`
- `find_invariant <scope>`
- `trace_data_flow <entity>`
- `architecture_boundary_check`
- `semantic_diff <base> <head>`
- `semantic_impact <change-set>`
- `graph_at <snapshot>`
- `find_contradictions`
- `calibration_report`

Todas deben devolver:

- resultado principal;
- semantic IDs;
- evidencia compacta;
- confianza y explicación;
- snapshot/frescura;
- procedencia;
- limitaciones;
- suggested verification cuando la confianza no sea alta.

## 12. Query planner híbrido

El planner debe clasificar la intención:

- localización;
- comportamiento;
- responsabilidad;
- causalidad;
- flujo de datos;
- contrato/invariante;
- arquitectura;
- impacto;
- evolución;
- contradicción.

Después ejecuta un plan con presupuesto:

1. filtros exactos;
2. recorrido de grafo;
3. claims semánticos;
4. evidencia;
5. texto/embedding;
6. rerank opcional;
7. síntesis compacta.

El ranking combinará relevancia, confianza, frescura, diversidad de evidencia, distancia de grafo y prioridad local.

### 12.1 Reciprocal Rank Fusion (RRF) — pendiente de implementación

Las piezas existen por separado: BM25 (`search_graph`), vectores (`semantic_search`), rerank LLM (`applyLlmRerank`). Pero el agente hoy hace 2-3 llamadas secuenciales cuando una búsqueda no da en el clavo.

RRF unifica las tres fuentes en una sola llamada:

```
score(doc) = Σ 1/(k + rank_i(doc))  para cada ranker i
```

Donde `k=60` (constante de suavizado estándar). Los rankers son:
1. BM25 sobre nombres, qualified names y snippets.
2. Cosine similarity sobre embeddings locales (si están disponibles).
3. Rerank LLM (DeepSeek V4 Flash, opcional, con cache LRU por SHA256).

Beneficio esperado: misma latencia, resultados más certeros, un round-trip MCP menos por búsqueda ambigua. Medible directamente en el benchmark agent A/B.

### 12.2 Context-Flow — Grafo de Contexto Activo para `pack_context` — pendiente de implementación

El agente hoy gasta el 80% de su tiempo explorando a ciegas: `pack_context` → `search_graph` → `get_code_snippet` → `trace_path` → más búsquedas. Son 4-8 round-trips MCP por tarea.

Context-Flow invierte el modelo: `pack_context` deja de ser un índice pasivo que sugiere "qué buscar después" y se convierte en un **estratega que pre-computa y sirve el camino de menor resistencia** en la primera llamada.

**Principio rector:** El servidor MCP predice el contexto necesario; el agente ejecuta, no explora.

#### Fase 1 — Pre-computo de trazas críticas

`pack_context` ejecuta `trace_path(depth=2)` automáticamente sobre sus top 2-3 candidatos y devuelve el critical path resuelto:

```json
{
  "recommended_focus_zone": {
    "entry_point": { "file": "src/db/pool.ts", "symbol": "ConnectionPool.acquire" },
    "critical_path": [
      "pool.ts:ConnectionPool.acquire() → connection.ts:ConnectionManager.connect()",
      "connection.ts:ConnectionManager.connect() → socket.ts:SocketFactory.create()"
    ]
  },
  "precomputed_traces": { /* resultado de trace_path(depth=2) ya ejecutado */ },
  "related_tests": ["tests/unit/db/pool.test.ts"]
}
```

Depende de: `only_diff_intersect` (priorizar zona caliente del diff), Graph Drift Detector (alertar índice stale), y Skeleton mode (los snippets referenciados usan plegado AST, no código completo). (~150 líneas.)

**Beneficio:** De 6-8 llamadas MCP a 2-3. El agente recibe el trace ya resuelto y los snippets ya plegados en una sola respuesta.

#### Fase 2 — Cruce con diff activo

`pack_context` consulta `detect_changes` internamente en cada invocación. Si el diff actual toca `pool.ts` y `connection.ts`, los candidatos en esos archivos reciben boost automático de ranking sin que el agente tenga que pedir el diff por separado. (~60 líneas.)

**Beneficio:** El agente ya no necesita correlacionar diff + grafo manualmente. `pack_context` sabe qué se está tocando ahora mismo y prioriza en consecuencia.

#### Fase 3 — Co-change mining histórico

`pack_context` analiza `git log --follow --numstat` para detectar pares de archivos que históricamente se modifican juntos (>80% co-occurrencia). Opcional bajo flag `include_cochange=true` porque añade ~500ms-2s de latencia. (~200 líneas.)

**Riesgo:** False positives por refactors masivos (linting, renames). Pendiente de validación de señal/ruido antes de activar por defecto.

#### Comparación: antes vs después

| Métrica | Hoy (`pack_context` pasivo) | Context-Flow Fase 1+2 |
|---------|---------------------------|----------------------|
| Llamadas MCP por tarea | 6-8 | 2-3 |
| Trazas pre-computadas | 0 (el agente las pide después) | 2-3 (servidas en la respuesta) |
| Snippets | 0 (el agente los pide después) | Top 2-3 en modo skeleton ya incluidos |
| Conciencia de diff | No (el agente correlaciona manualmente) | Sí (boost automático + zone prioritization) |
| Latencia añadida | ~220ms | ~160ms extra (trace + skeleton), compensada por -4 round-trips MCP |
| Dependencias nuevas | Ninguna | `only_diff_intersect`, Drift Detector, Skeleton mode |

#### Lo que NO se incluye

- Co-change mining no va en el hot path (solo bajo flag explícito).
- No se pre-fetchean snippets completos — se usan referencias skeleton.
- No se reemplaza la capacidad del agente de hacer búsquedas ad-hoc si el critical path falla.
- `pack_context` sigue funcionando 100% offline sin LLM (el pre-cómputo de trazas es determinista).

### 12.3 Sibling Call Invariant Checker (`check_invariants`) — pendiente de implementación

Las bases de código acumulan "reglas invisibles": patrones de uso acoplados que ningún linter, compilador ni analizador estático captura. Por ejemplo: *"cada vez que llamas a `paymentGateway.charge()`, debes llamar a `auditLog.recordTransaction()` en el mismo bloque"*. El compilador no se queja, pero el código en producción tiene un agujero de auditoría.

LYNX ya tiene todas las aristas `CALLS` indexadas en `edges`. El Sibling Call Invariant Checker las convierte en un **linter de arquitectura semántica** sin reglas manuales.

#### Algoritmo (3 pasos SQL puro, <30ms)

```
Paso 1 — Padres de A:
  SELECT source_node_id FROM edges
  WHERE target_node_id = <symbol_A> AND type = 'CALLS'

Paso 2 — Hermanos recurrentes (mismo scope de función):
  SELECT e2.target_node_id, COUNT(*) AS freq
  FROM edges e2
  WHERE e2.source_node_id IN (<padres_de_A>)
    AND e2.target_node_id != <symbol_A>
    AND e2.type = 'CALLS'
    AND e2.scope_parent = <mismo_nodo_padre>
  GROUP BY e2.target_node_id

Paso 3 — Confianza del invariante:
  confidence = freq / total_padres
  Si confidence >= 0.85 → invariante arquitectónico descubierto
```

#### Filtros anti-ruido (obligatorios)

1. **Exclusión de utilidades transversales**: nodos con `fan_out > 5%` de todos los nodos del proyecto (`logger.info`, `console.log`, `metrics.increment`, funciones `t()` de i18n) se excluyen automáticamente.
2. **Scope de co-ocurrencia estricto**: solo se consideran hermanas dos llamadas que comparten el mismo nodo padre (misma función contenedora). Esto evita falsos positivos de inicialización global (`setupDB` + `startServer` en `main.ts`).
3. **Threshold configurable**: `min_confidence` (default 0.85) y `min_occurrences` (default 5, para filtrar patrones espurios en proyectos pequeños).

#### Tool: `check_invariants(project, file?)`

Herramienta independiente — no sobrecarga `assess_impact`. Si se pasa `file`, verifica solo los símbolos modificados en ese archivo. Sin `file`, escanea todo el repositorio.

Output:
```json
{
  "invariants": [{
    "symbol": "paymentGateway.charge",
    "missing_sibling": "auditLog.recordTransaction",
    "confidence": 0.94,
    "observed": "17/18 co-occurrences",
    "examples": ["src/services/invoice.ts:45", "src/jobs/renewals.ts:102"],
    "severity": "high"
  }],
  "stats": {
    "invariants_checked": 342,
    "violations_found": 1,
    "false_positive_risk": "low",
    "latency_ms": 18
  }
}
```

#### Ciclo de uso con el agente

```
agente edita billing.ts añadiendo charge()
  → watcher reindexa (~300ms)
  → agente: check_invariants(project, file="billing.ts")
  → "Has añadido charge() pero te falta recordTransaction() (94%)"
  → agente corrige antes del commit
```

#### Integración con Context-Flow

`pack_context` incluye invariantes en su pre-cómputo: para cada símbolo en la zona de enfoque, verifica si tiene siblings obligatorios y los incluye como advertencias en `recommended_focus_zone.invariants`. El agente recibe las reglas invisibles antes de escribir la primera línea.

### 12.4 Event-Bridge Edge Resolver — Trazador de Flujos Asíncronos (`TRIGGERS`) — pendiente de implementación

**Problema detectado:** `passSemanticLight` ya extrae canales (`emits`, `listens_on`) con precisión, pero los asocia al nodo `File` en lugar de a la función contenedora. `edgeTypesForMode` en `trace-core.ts` ya soporta `CROSS_CHANNEL` en modo `cross_service`, pero `trace_path` no puede seguir `EMITS` → `LISTENS_ON` porque esos edges no conectan funciones entre sí. Un `trace_path` sobre `registerUser()` no descubre `sendWelcomeEmail()` aunque exista un canal `user.registered` entre ambos.

**Solución:** tres cambios quirúrgicos sobre infraestructura ya existente (~100 líneas total):

#### (1) Upgrade de `passSemanticLight` — asociación función→canal

Cambio en `src/pipeline/phases/resolve/pass-semantic.ts` (~40 líneas):

```ts
// ANTES: edge file→channel
addEdge(edges, idx.project, fileNode.id, channelId, 'EMITS', {...});

// DESPUÉS: edge función→channel (cuando el canal se emite dentro de una función)
const enclosingFn = findEnclosingFunction(db, idx, batch.file, channel.line);
if (enclosingFn) {
  addEdge(edges, idx.project, enclosingFn.id, channelId, 'EMITS', {
    file_path: batch.file,
    line: channel.line,
    confidence: 0.9
  });
}
```

Misma lógica para `LISTENS_ON` (subscriptores).

#### (2) Virtual Edge Resolver — JOIN publishers↔subscribers

Nuevo pass post-resolución (~50 líneas):

```sql
INSERT OR IGNORE INTO edges (project, source_id, target_id, type, properties)
SELECT 
  e1.project,
  e1.source_id AS publisher_fn_id,
  e2.source_id AS subscriber_fn_id,
  'TRIGGERS' AS type,
  json_object(
    'channel', c.name,
    'transport', c.transport,
    'confidence', 0.7,
    'resolver', 'event_bridge'
  ) AS properties
FROM edges e1
JOIN edges e2 ON e1.target_id = e2.target_id AND e1.project = e2.project
JOIN nodes c ON c.id = e1.target_id AND c.kind = 'Channel'
WHERE e1.type = 'EMITS'
  AND e2.type = 'LISTENS_ON'
  AND e1.source_id != e2.source_id;
```

El JOIN es determinista: mismo `target_id` (el nodo Channel) + tipos de edge complementarios. Confianza 0.7 porque hay falsos positivos (canales con nombre genérico como `"error"` o `"data"`). El campo `resolver: 'event_bridge'` permite al agente distinguir edges directos de inferidos.

#### (3) Activar tipos de edge en `trace_path`

Cambio en `src/federation/trace-core.ts` (~5 líneas):

```ts
// Añadir a data_flow y cross_service:
'EMITS',
'LISTENS_ON', 
'TRIGGERS',
```

#### Tool `resolve_async_flows`

Herramienta ligera que ejecuta el JOIN on-the-fly sin esperar a la siguiente indexación completa:

```
resolve_async_flows(project, channel_name?)
  → lista de pares (publisher, subscriber, channel, confidence)
```

Útil para el agente cuando quiere verificar flujos asíncronos sobre un canal específico sin reindexar.

#### Resultado

```
registerUser() ──EMITS──▶ user.registered ◀──LISTENS_ON── sendWelcomeEmail()
                                    │
                                    └── TRIGGERS ──▶ sendWelcomeEmail()
```

`trace_path` ya no se detiene en `.emit()` o `.add()` — sigue el flujo completo a través de eventos, colas y dispatchers. Determinista, offline, <15ms en consulta.

#### Sinergia con el resto de la Fase 11

- **SACG-028 (Sibling Call Invariants):** `check_invariants` detecta que `sendWelcomeEmail()` es un sibling obligatorio de `registerUser()`. SACG-029 añade el *por qué*: están conectados por un canal de eventos. La evidencia se complementa.
- **Context-Flow (SACG-022):** `pack_context` incluye los suscriptores downstream en su pre-cómputo de trazas, enriqueciendo `recommended_focus_zone` con los consumidores de eventos.
- **SACG-027 (Blast Radius):** `assess_impact` incluye suscriptores de eventos en `direct_dependent_files` — si cambias el payload de `user.registered`, todos los suscriptores están en el radio de impacto.

#### No incluido

- Inferencia de schemas de payload (JSON Schema del evento) — requiere Tier 2 (runtime traces).
- Validación de compatibilidad de payloads entre publisher y subscriber — requiere Tier 4 (LLM).
- Dead letter queues, retry patterns, circuit breakers — son patrones de infraestructura, no de código.

### 12.5 Architecture Drift Prevention — Validador de Fronteras Arquitectónicas (`lynx-rules.json`) — pendiente de implementación

**Problema detectado:** los agentes de IA escriben código que compila pero viola la arquitectura del proyecto. Importan servicios directamente desde capas de presentación, saltan capas de abstracción, y acoplan módulos que deberían permanecer independientes. LYNX hoy no se queja porque el código es sintácticamente válido. Pero el desarrollador senior que revisa el PR sí se queja — y el daño ya está hecho.

**Solución:** un validador de fronteras estático integrado en `assess_impact` (~250-350 líneas total).

#### Configuración: `lynx-rules.json`

```json
{
  "version": 1,
  "layers": {
    "view": ["controller"],
    "controller": ["service", "model"],
    "service": ["db", "model"],
    "db": ["model"]
  },
  "layerMap": {
    "view": "src/ui/**",
    "controller": "src/controllers/**",
    "service": "src/services/**",
    "db": "src/data/**",
    "model": "src/models/**"
  }
}
```

Las reglas son direccionales: `"view": ["controller"]` significa "view PUEDE llamar a controller". Cualquier edge que conecte view → service directamente es una violación. Las capas no listadas en el array de una capa están implícitamente prohibidas.

#### Mecanismo de detección

Séptima consulta en el pipeline de `assess_impact` (~70 líneas):

```sql
SELECT DISTINCT
  e.type AS edge_type,
  src.name AS from_symbol,
  src.file_path AS from_file,
  src_layer.layer AS from_layer,
  tgt.name AS to_symbol,
  tgt.file_path AS to_file,
  tgt_layer.layer AS to_layer,
  r.allowed_layers AS rule_allows
FROM edges e
JOIN nodes src ON e.source_id = src.id
JOIN nodes tgt ON e.target_id = tgt.id
JOIN layer_assignments src_layer ON src.file_path GLOB src_layer.glob
JOIN layer_assignments tgt_layer ON tgt.file_path GLOB tgt_layer.glob
JOIN layer_rules r ON src_layer.layer = r.from_layer
WHERE e.type IN ('CALLS', 'IMPORTS', 'USAGE')
  AND src.file_path IN (modified_files)
  AND tgt_layer.layer NOT IN (SELECT value FROM json_each(r.allowed_layers))
```

La consulta es puro SQL — no necesita LLM, no necesita runtime, no necesita red. <15ms incluso en proyectos grandes.

#### Output en `assess_impact`

```json
{
  "architecture_violations": [
    {
      "from": "src/ui/login.ts:24",
      "to": "src/services/auth.ts:87",
      "rule": "view → service",
      "severity": "error",
      "message": "La capa 'view' no puede llamar directamente a la capa 'service'. Debe pasar por 'controller'."
    },
    {
      "from": "src/services/payment.ts:142",
      "to": "src/ui/toast.ts:15",
      "rule": "service → view",
      "severity": "error",
      "message": "La capa 'service' no puede importar de 'view' (violación de dependencia unidireccional)."
    }
  ],
  "violation_count": 2,
  "layers_checked": ["view", "controller", "service", "db", "model"]
}
```

#### Integración con el ciclo del agente

```
agente edita src/ui/login.ts añadiendo import de AuthService
  → watcher reindexa (~300ms)
  → agente: assess_impact(project)
  → "2 violaciones arquitectónicas detectadas:
     view/login.ts → services/auth.ts VIOLA 'view → controller → service'"
  → agente corrige: importa el controller en vez del servicio directo
```

El agente recibe la "bofetada arquitectónica" de forma pasiva — no necesita aprender una herramienta nueva. `assess_impact` ya es la herramienta que usa para verificar cambios.

#### Tool independiente: `check_rules`

Herramienta ligera para validación rápida sin ejecutar `assess_impact` completo:

```
check_rules(project, file?, layer?)
  → lista de violaciones activas en el estado actual del grafo
```

Útil para CI/CD o para el desarrollador que quiere verificar el estado global de la arquitectura sin esperar un diff.

#### Sinergia con la Trinidad de Validación

- **SACG-027 (Blast Radius):** `assess_impact` responde "¿qué rompo?" (dependientes downstream) + "¿qué reglas violo?" (fronteras cruzadas). Dos dimensiones de impacto en una sola llamada.
- **SACG-028 (Sibling Call Invariants):** `check_invariants` responde "¿qué me falta?" (reglas implícitas del código). SACG-030 responde "¿qué no debería haber hecho?" (reglas explícitas del diseño). Complementarios.
- **SACG-029 (Event-Bridge):** los triggers de eventos también se validan contra las reglas de capas — si `view` emite un evento que solo `controller` debería emitir, se detecta.

#### No incluido

- Dependencias circulares entre capas — requiere análisis de grafo completo (posible extensión SACG-031).
- Reglas de acoplamiento por afinidad semántica ("este módulo solo debería importar de estos 3 módulos") — requiere DSL más expresivo.
- Autocompletado de `lynx-rules.json` a partir de la estructura de directorios — posible asistente en `lynx init`.

## 13. Rendimiento y SLO

Objetivos locales para proyecto indexado:

- búsqueda exacta p95 < 50 ms;
- traversal de 2 hops p95 < 100 ms;
- semantic query determinista p95 < 250 ms;
- respuesta MCP compacta inicial < 1.500 tokens;
- reindex incremental de un archivo p95 < 500 ms sin LLM;
- watcher visible en grafo < 1 s;
- cero red obligatoria en hot path;
- snapshot atómico: nunca exponer mitad de una actualización;
- incremento de almacenamiento SACG objetivo < 3x del índice estructural.

Los límites deben medirse por tamaño de proyecto y lenguaje, no declararse sin benchmarks.

## 14. Seguridad y privacidad

- redacción de secretos antes de cualquier llamada externa;
- allowlist de proveedores y tipos de contenido;
- modo `offline_strict`;
- hashes y referencias en lugar de código cuando sea suficiente;
- auditoría de cada inferencia externa;
- TTL y borrado configurable de prompts/respuestas;
- RBAC aplicado antes de consultar shared;
- evidencia sensible no se mezcla entre proyectos;
- export SACG con filtrado de paths, secrets y payloads.

## 15. Calidad y benchmark mundial

Datasets:

- fixtures sintéticos con verdad conocida;
- repositorios reales multilenguaje;
- tareas de agentes;
- cambios y renombrados;
- traces controladas;
- proyectos con arquitecturas conocidas.

Métricas:

- precision/recall por relación;
- exactitud de lineage;
- calibración confidence vs accuracy;
- contradiction detection;
- temporal freshness;
- semantic impact precision;
- archivos y tokens evitados medidos;
- task success del agente;
- latency y almacenamiento;
- degradación offline;
- false certainty rate.

Gates:

- ninguna relación nueva con precision < 0.90 entra por defecto;
- claims `verified` con error observado > 2% bloquean release;
- lineage de rename/move >= 0.95 en benchmark;
- regresión de tools legacy = 0;
- resultados sin evidencia visible = 0 para nuevas tools;
- tests de aislamiento entre proyectos obligatorios.

## 16. Plan de ejecución

### Fase SACG-0: especificación y baseline
Entregables:
- este blueprint;
- ADR de identidad, claims, evidencia y temporalidad;
- catálogo actual de nodos/aristas;
- benchmark baseline;
- threat model.
Gate: contratos aprobados y tests baseline reproducibles.

### Fase SACG-1: evidence-native structural graph
- introducir migraciones formales;
- snapshots;
- semantic IDs;
- evidence ledger;
- adaptar passes para emitir observaciones;
- fusionar evidencias sin cambiar outputs legacy.
Gate: paridad exacta de tools actuales y toda arista con evidencia.

### Fase SACG-2: identidad y temporalidad
- lineage de archivos y símbolos;
- rename/move;
- versionado de entidad y relación;
- `graph_at` y `semantic_diff`.
Gate: benchmark lineage y snapshots atómicos.

### Fase SACG-3: semántica determinista
- DomainConcept, Capability, Responsibility, DataContract, Invariant y SideEffect;
- reglas por lenguaje/framework;
- contracts de API, datos y configuración.
Gate: precision >= 0.90 por regla activada.

### Fase SACG-4: tests, datos y runtime
- conectar tests con invariantes y capacidades;
- data flow interprocedural acotado;
- ingestión de traces;
- reconcile static/runtime.
Gate: evidencia dinámica visible y contradicciones conservadas.

### Fase SACG-5: LLM constrained inference
- sustituir `LlmFileMetadata` por propuestas tipadas;
- JSON Schema;
- citations obligatorias;
- validators;
- cache por source hash + prompt version + model.
Gate: cero entidades inventadas en suite adversarial.

### Fase SACG-6: semantic query engine
- planner híbrido;
- tools de explicación, evidencia, responsabilidad, invariantes e impacto;
- context packs semánticos.
Gate: mejora medible del éxito de agentes frente al grafo legacy.

### Fase SACG-7: federación semántica
- semantic IDs cross-repo;
- claims shared/local;
- conflictos;
- autorización por evidencia y entidad.
Gate: working tree prevalece y no hay fugas cross-project.

### Fase SACG-8: producto y visualización
- dashboard de claims/evidence/confidence;
- timeline;
- contradictions;
- architecture map;
- export.
Gate: cada vista consume APIs canónicas, sin lógica paralela.

### Fase SACG-9: hardening y publicación
- fuzzing de extractores;
- benchmarks públicos reproducibles;
- documentación;
- plugin SDK;
- versionado de ontología.
Gate: typecheck, lint, tests, doctor, benchmark y diff limpios.

## 17. Primer vertical slice ejecutable

Objetivo: demostrar el modelo evidence-native sin ampliar todavía toda la ontología.

Implementar:

1. `schema_migrations`, `graph_snapshots`, `semantic_entities`, `semantic_relations`, `evidence`.
2. `semantic_id` para File, Function, Method y Class.
3. Adaptador que convierta `CALLS`, `IMPORTS`, `TESTS`, `CONFIGURES`, `EMITS` y `LISTENS_ON` en relaciones con evidencia.
4. Dedupe por identidad lógica y fusión de evidencia.
5. Proyección hacia `edges` legacy.
6. Tool interna `show_evidence`.
7. Tests de idempotencia, duplicados, contradicción, rename y aislamiento.
8. Métricas: relaciones con evidencia, distribución de confianza, orphan evidence y stale claims.

No incluir aún:

- embeddings;
- inferencia LLM nueva;
- UI compleja;
- backend central;
- data flow global;
- ontología completa.

## 18. Backlog inmediato

SACG-001 ADR de identidad semántica.
SACG-002 ADR de claims y evidencia.
SACG-003 tabla `schema_migrations` y runner transaccional.
SACG-004 tablas del vertical slice.
SACG-005 tipos TypeScript `SemanticEntity`, `SemanticRelation`, `Evidence`.
SACG-006 generador determinista de semantic IDs.
SACG-007 normalizador de evidence payload.
SACG-008 reconciliador y confidence calculator.
SACG-009 adaptador de passes existentes a observations.
SACG-010 proyección legacy.
SACG-011 `show_evidence`.
SACG-012 tests contractuales.
SACG-013 benchmark baseline.
SACG-014 métricas y doctor checks.
SACG-015 documentación de migración y rollback.
SACG-016 **Graph Drift Detector** — comparar `git rev-parse HEAD` + timestamps de `file_hashes` contra `stat()` del disco. Alerta si el índice está desactualizado antes de trazar rutas o devolver resultados (~50–100ms, sin reindexar). Red de seguridad contra watcher caído o índice stale. Relacionado con capa 4.1.F (Temporal Graph Layer).
SACG-017 **RRF Búsqueda Híbrida Unificada** — fusionar BM25 + vectores + rerank LLM en una sola llamada con Reciprocal Rank Fusion (ver §12.1). Elimina 1-2 round-trips MCP por búsqueda ambigua.
SACG-018 **Recorte Inteligente de Contexto en `investigate_symbol`** — colapsar cuerpos de funciones que superen un presupuesto de tokens (solo firmas y tipos), con flag `max_tokens` y modo `signatures_only`. Evita que God Objects saturen el contexto del agente. Relacionado con §1.1 (reducir tokens de entrada).
SACG-019 **Filtro de Impacto Activo (`only_diff_intersect`)** — parámetro booleano opcional en `trace_path`, `search_graph` y `query_graph` que filtra resultados a nodos/caminos que intersectan archivos modificados en `git diff`. Intersección entre grafo y diff real (~50 líneas). Conecta `detect_changes` con las herramientas de grafo. Ahorro estimado del 80-90% de tokens en trazados sobre cambios activos. Relacionado con capa 4.1.A (Source State Layer).
SACG-020 **Esqueleto AST (`skeleton` mode en `get_code_snippet`)** — modo de lectura que devuelve la función solicitada completa pero colapsa cuerpos de funciones hermanas a `{ ... }`. Usa start_line/end_line ya indexados en `nodes`. Conserva contexto estructural del archivo (herencia, firmas vecinas) a ~10% del coste en tokens. Relacionado con §1.1 y complementario a SACG-018.
SACG-021 **Mapa de Fronteras (`lynx-services.json`)** — archivo de configuración opcional que resuelve endpoints HTTP/gRPC/GraphQL a repositorios externos. `trace_path` en modo `cross_service` ya extrae `CROSS_HTTP_CALLS`, `CROSS_GRPC_CALLS`, etc.; este item añade hints cross-repo sin analizar red (~100 líneas). Relacionado con capa 4.1.H (Federation Layer).
SACG-022 **Context-Flow Fase 1 — pre-computo de trazas en `pack_context`**: ejecutar `trace_path(depth=2)` automáticamente sobre top 2-3 candidatos y devolver critical path resuelto en vez de solo sugerirlo (~150 líneas). Ver §12.2. Depende de SACG-019 y SACG-020.
SACG-023 **Context-Flow Fase 2 — cruce con diff activo en `pack_context`**: consultar `detect_changes` internamente en cada invocación de `pack_context` para boost automático de candidatos en archivos modificados (~60 líneas). Ver §12.2. Depende de SACG-019 y SACG-022.
SACG-024 **Context-Flow Fase 3 — co-change mining**: `git log --follow --numstat` para detectar archivos co-modificados históricamente. Flag `include_cochange=true`, fuera del hot path por defecto (~200 líneas). Ver §12.2. Pendiente de validación de señal/ruido.
SACG-025 **Entrypoint Mapping — Extracción multienfoque**: ampliar el extractor de entrypoints más allá de Next.js App Router. Añadir patrones AST para Express (`app.get('/path')`), Fastify (`fastify.get('/path')`), NestJS (`@Get('/path')`), Koa, Hono. La columna `is_entry_point` y `passRoutes` ya existen; esto generaliza el concepto. (~200 líneas). Relacionado con capa 4.1.B (Structural Graph Layer).
SACG-026 **Entrypoint Mapping — Tool + enriquecimiento**: nueva tool `list_entrypoints(project, method?, path_pattern?)`. Enriquecer `trace_path` con `entrypoint_path` cuando un nodo es alcanzable transitivamente desde un entrypoint. Enriquecer `search_graph` con filtro `is_entry_point`. (~100 líneas). Relacionado con capa 4.1.G (Semantic Query Layer).
SACG-027 **Blast Radius — `queryDownstreamDependents` en `assess_impact`**: sexta consulta en el pipeline de `assess_impact`. SQL directa `SELECT target_file FROM edges WHERE source_file IN (modified_files) AND type IN ('CALLS','IMPORTS','USAGE')` → campo `direct_dependent_files` con radio de impacto en <20ms. Responde "¿qué rompo si cambio esto?" antes del commit. (~50 líneas). Relacionado con capa 4.1.B (Structural Graph Layer).
SACG-028 **Sibling Call Invariant Checker (`check_invariants`)**: herramienta independiente que detecta reglas arquitectónicas invisibles mediante co-ocurrencia de llamadas en el mismo ámbito. Algoritmo SQL en 3 pasos: (1) padres que llaman al símbolo A, (2) otros símbolos B llamados por los mismos padres, (3) confianza = frecuencia / total. Filtros: exclusión de nodos con fan_out > 5% (utilidades transversales) y scope estricto de función. Tool `check_invariants(project, file?)`. (~150-200 líneas). Ver §12.3. Relacionado con capa 4.1.C (Semantic Claim Layer) y capa 4.1.E (Confidence Engine).
SACG-029 **Event-Bridge Edge Resolver — Trazador de Flujos Asíncronos (`TRIGGERS`)**: tres cambios quirúrgicos sobre infraestructura ya existente. (1) Upgrade de `passSemanticLight` para asociar `EMITS`/`LISTENS_ON` a la función contenedora. (2) Virtual Edge Resolver con SQL JOIN publishers↔subscribers → `TRIGGERS`. (3) Activar `EMITS`/`LISTENS_ON`/`TRIGGERS` en `trace_path` modos `data_flow` y `cross_service`. Nueva tool `resolve_async_flows(project, channel_name?)`. (~100 líneas). Ver §12.4. Relacionado con capa 4.1.B (Structural Graph Layer) y capa 4.1.D (Query & Reasoning Layer).
SACG-030 **Architecture Drift Prevention — Validador de Fronteras Arquitectónicas (`lynx-rules.json`)**: séptima consulta en `assess_impact` que cruza edges del diff contra reglas de capas definidas en archivo de configuración. `lynx-rules.json` con mapeo simple de capas + reglas de dependencia permitidas + asignación de archivos a capas por glob. Nueva tool `check_rules(project, file?, layer?)`. Cierra la Trinidad Definitiva de Validación de Contexto: Blast Radius (qué rompo) + Sibling Invariants (qué me falta) + Architecture Rules (qué violo). (~250-350 líneas). Ver §12.5. Relacionado con capa 4.1.B (Structural Graph Layer) y capa 4.1.D (Query & Reasoning Layer).

Orden obligatorio:
001 → 002 → 003 → 004 → 005 → 006 → 007 → 008 → 009 → 010 → 011 → 012 → 013 → 014 → 015.

016–030 son independientes entre sí y del pipeline SACG principal; pueden ejecutarse en paralelo o intercalarse en cualquier momento.

Orden recomendado por ROI:
1. **SACG-019** (diff intersect) — prerequisite para Context-Flow
2. **SACG-016** (drift detector) — red de seguridad transversal
3. **SACG-027** (Blast Radius) — menor esfuerzo (~50 líneas), mayor valor inmediato para el ciclo de edición
4. **SACG-028** (Sibling Call Invariants) — categoría nueva de análisis; ningún competidor lo ofrece
5. **SACG-029** (Event-Bridge Edge Resolver) — ~100 líneas, cierra el triángulo de flujos con SACG-027 y SACG-028
6. **SACG-030** (Architecture Drift Prevention) — ~300 líneas, la joya de la corona: Trinity Definitiva completa (027+028+030)
7. **SACG-020** (AST skeleton) — prerequisite para SACG-022 y entrypoints
8. **SACG-025** (Entrypoint Mapping — extracción) — amplía `passRoutes` a 6+ frameworks
9. **SACG-026** (Entrypoint Mapping — tool + enriquecimiento) — `list_entrypoints` + `entrypoint_path` en `trace_path`
10. **SACG-022** (Context-Flow F1: pre-computo trazas) — depende de 019 + 020 + 026 + 028 + 029 + 030
11. **SACG-023** (Context-Flow F2: cruce diff) — depende de 019 + 022
12. **SACG-018** (context collapse)
13. **SACG-017** (RRF)
14. **SACG-021** (service map)
15. **SACG-024** (co-change mining) — último; requiere validación previa de señal/ruido

Las piezas de entrada de la Fase 11 (019, 016, 027, 028, 029, 030, 020, 025, 026) construyen una base de inteligencia de código tan rica que Context-Flow (022/023) se implementa sobre rieles: `pack_context` pre-computa trazas síncronas y asíncronas (TRIGGERS), `trace_path` enriquece con entrypoints, `assess_impact` muestra el blast radius de cada cambio incluyendo suscriptores de eventos y validando reglas arquitectónicas (`lynx-rules.json`), `check_invariants` alerta sobre reglas arquitectónicas invisibles con evidencia cross-canal, y el agente recibe en la primera respuesta el critical path completo con puertas de entrada HTTP, flujos de eventos, validación de fronteras de capas, snippets plegados, y conciencia del diff activo — todo en <300ms.

## 19. Definition of Done global

El SACG estará completo cuando LYNX pueda responder una pregunta como:

“¿Qué componente es responsable de aprobar una propuesta, qué invariantes protege, qué datos modifica, qué tests lo verifican, qué cambió desde la versión anterior y por qué debo confiar en la respuesta?”

La respuesta deberá contener:

- entidades y relaciones exactas;
- significado de dominio;
- recorrido causal;
- contratos e invariantes;
- datos y efectos;
- tests y runtime evidence;
- cambios temporales;
- confianza calibrada;
- contradicciones;
- procedencia local/shared;
- evidencia navegable;
- resultado compacto apto para un agente.

Sin leer manualmente decenas de archivos, sin depender de una nube, sin ocultar incertidumbre y sin confundir una inferencia con un hecho.
