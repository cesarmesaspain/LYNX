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

Orden obligatorio:
001 → 002 → 003 → 004 → 005 → 006 → 007 → 008 → 009 → 010 → 011 → 012 → 013 → 014 → 015.

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
