# LYNX — Estrategia y Roadmap Técnico-Comercial

> v1 — 2026-07-10. Documento interno de producto. No contractual.

## Resumen ejecutivo

LYNX compite en inteligencia de código para agentes, pero **no** contra Sourcegraph
en su totalidad. Sourcegraph es un avión comercial: miles de repos, HA multinodo,
cientos de integraciones, compliance extremo. LYNX es un helicóptero: 60–80% del
valor práctico para equipos de 5–200 desarrolladores, por una fracción del coste,
con ventajas nativas en local-first, privacidad, instalación ligera, y métricas
auditables.

**No intentamos copiar Sourcegraph. Ocupamos el segmento que Sourcegraph no puede
servir bien: el desarrollador individual y el equipo mediano que valora simplicidad,
velocidad de puesta en marcha y no depender de infraestructura externa.**

---

## Diferenciación

### Lo que LYNX hace mejor (ventajas estructurales)

| Dimensión | LYNX | Sourcegraph |
|---|---|---|
| Working tree no commiteado | Nativo — índice local + watcher en tiempo real | Requiere commit/push o configuración adicional |
| Instalación | `npm install -g lynx && lynx install` — 30s | Despliegue de servidor, PG, Redis, MinIO |
| Privacidad | Todo local, nada sale del dispositivo sin permiso | SaaS o self-hosted con infraestructura significativa |
| Métricas auditables | Provenance en cada métrica (measured/estimated/scenario) | Métricas agregadas sin trazabilidad por evento |
| Integración MCP | 25 herramientas MCP nativas con hook auto-aumentado | MCP requiere configuración y servidor externo |
| Contexto compacto | `pack_context` genera briefs de ~400 tokens | Sin equivalente directo para agentes |
| Análisis de impacto | `detect_changes` + `assess_impact` sobre diff real | Depende de indexación completa del servidor |
| Coste operativo | Cero infraestructura para modo local | Mínimo ~$200/mes en cloud para self-hosted |

### Lo que NO hacemos (y por qué está bien)

- **Escala de millones de repositorios**: LYNX es por proyecto/equipo, no para
  toda la organización. Para eso ya existe Sourcegraph.
- **HA multinodo con failover**: El índice local es suficiente; el índice
  compartido es un valor añadido, no el camino crítico.
- **Cientos de integraciones**: Priorizamos GitHub, GitLab, VS Code, Claude Code,
  Codex CLI. El resto por demanda.
- **Compliance extremo (FedRAMP, HIPAA)**: Enterprise Lite cubre necesidades
  básicas de auditoría y permisos. Compliance extremo es segmento Enterprise
  maduro, no nuestro target inicial.
- **Deep Search complejo (búsqueda estructural, diff search, monitores)**: Nos
  enfocamos en búsqueda textual/estructural con rerank semántico, grafo de
  llamadas, y análisis de impacto. El 20% de features que entrega el 80% del valor.

---

## Modelo de tres niveles

### Nivel 1 — LYNX Local

**Para**: Desarrolladores individuales y equipos de 2–10 personas.

**Precio indicativo**: Free (open-core), Pro $9–12/mes.

| Capacidad | Free | Pro |
|---|---|---|
| Indexación local (fast/moderate/full) | Hasta 50K archivos | Ilimitado |
| search_graph, trace_path, get_code_snippet | Sí | Sí |
| pack_context | Sí | Sí |
| Web dashboard local (métricas, action graph 3D) | Sí | Sí |
| Reordenamiento semántico (DeepSeek o API propia) | No | Sí |
| Rerank semántico medido (proveedor, latencia, coste) | No | Sí |
| Watcher automático | Sí | Sí |
| Doctor, install, upgrade | Sí | Sí |
| Métricas con procedencia (measured/estimated) | Sí | Sí |
| Export JSON/CSV de métricas | Sí | Sí |
| report HTML | No | Sí |
| Savings Lab (escenarios editables) | No | Sí |
| Nº máximo de proyectos indexados | 5 | Ilimitado |
| Soporte | Comunidad (GitHub) | Email, 48h |

### Nivel 2 — LYNX Team

**Para**: Equipos de 10–200 desarrolladores con múltiples repositorios.

**Precio indicativo**: $15–25/usuario/mes. Team Starter: $99/mes hasta 5 usuarios.

| Capacidad | Incluido |
|---|---|
| Todo LYNX Pro | Sí |
| Índice compartido (lectura, opcional) | Sí |
| Gateway MCP único con procedencia y autorización | Sí |
| Multirrepo básico (cross-repo trace_path, search_graph) | Sí |
| Integración GitHub/GitLab (PR comments, status checks) | Sí |
| Roles: admin, member, viewer | Sí |
| Dashboard de equipo (métricas agregadas, líderes por proyecto) | Sí |
| Reportes compartidos | Sí |
| Deduplicación cross-repo (mismo símbolo en N repos) | Sí |
| Auditoría básica (quién buscó qué, cuándo) | Sí |
| Soporte | Slack compartido, 24h hábil |

### Nivel 3 — LYNX Enterprise Lite

**Para**: Organizaciones de 100–500+ desarrolladores con requisitos de compliance.

**Precio indicativo**: $30–45/usuario/mes. Descuento por volumen desde 100 usuarios.

| Capacidad | Incluido |
|---|---|
| Todo LYNX Team | Sí |
| SSO (SAML/OIDC) | Sí |
| Permisos por repositorio (RBAC) | Sí |
| Despliegue privado (VPC del cliente, sin datos externos) | Sí |
| Auditoría completa (query log, access log, export SIEM) | Sí |
| Índice compartido (lectura/escritura) | Sí |
| Retención de métricas configurable | Sí |
| SLA: 99.5% disponibilidad gateway | Sí |
| Soporte | Slack dedicado + email prioritario, 4h hábil |
| Onboarding asistido | 2 sesiones incluidas |

### Lo que queda fuera (por ahora)

- FedRAMP, HIPAA, SOC2 Tipo II
- SLA 99.99%
- Integraciones con Bitbucket Server, Gerrit, Perforce
- SSO con múltiples IdP simultáneos
- API pública versionada para terceros
- White-label / OEM

---

## Priorización 80/20

El 20% de capacidades que entrega el 80% del valor práctico:

1. **Indexación incremental fiable** — sin esto, nada funciona. El watcher + fast
   mode + SHA256 incremental ya cubre >95% de los casos.
2. **Búsqueda textual y estructural** — `search_graph`, `semantic_search`,
   `search_code`. Cubre el 90% de las preguntas de un agente.
3. **Definiciones y referencias** — `get_code_snippet`, `trace_path`, `query_graph`.
   Lo mínimo para entender código sin leer archivos.
4. **Empaquetado de contexto** — `pack_context`. El diferenciador principal para
   agentes: ~400 tokens en vez de ~20K.
5. **Análisis de impacto** — `detect_changes`, `smart_review`. Responde "¿qué rompí?"
   sin depender de CI.
6. **Multirrepo básico** — cross-repo trace_path y search_graph. El 80% de equipos
   tiene <10 repositorios activos.
7. **Gateway MCP único** — un solo endpoint para el agente, con procedencia
   obligatoria, autorización y fallback local transparente.
8. **Permisos y auditoría** — RBAC por repositorio, query log, access log. Lo
   mínimo para que un equipo confíe.
9. **Métricas creíbles** — provenance, categorías mutuamente excluyentes,
   sum(categories)=totals, idempotencia, sin afirmaciones no verificables.
10. **Instalación/doctor/upgrade** — tres comandos que siempre funcionan. Sin esto,
    la adopción se muere en el primer intento fallido.

### Lo que posponemos

- Deep Search: búsqueda estructural compleja, diff search, saved searches, monitors.
- Automatización: batch changes, code intelligence alerts, code ownership.
- Insights: dashboards de tendencias históricas, anomalías, predicciones.
- Admin: provisioning automático, SCIM, integración con directorio corporativo.
- Navegador de código web completo (el action graph 3D ya cubre exploración básica).

---

## Arquitectura objetivo: híbrida/federada

```
┌─────────────────────────────────────────────────────────┐
│                   Agente (Claude Code, Codex, etc.)       │
│                          │ MCP                           │
│                          ▼                               │
│              ┌──────────────────────┐                    │
│              │   LYNX Gateway MCP │  ◄── único endpoint │
│              │   (local, puerto N)  │                    │
│              └──────┬───────────────┘                    │
│                     │                                    │
│         ┌───────────┴───────────┐                        │
│         ▼                       ▼                        │
│  ┌─────────────┐        ┌──────────────────┐            │
│  │ Índice Local │        │ Backend Central   │            │
│  │ (SQLite,     │        │ (índice compartido│            │
│  │  ~/.lynx)  │        │  autoritativo)    │            │
│  │             │        │                  │            │
│  │ • Working   │        │ • Repos compartidos│           │
│  │   tree no   │        │ • Cross-repo      │            │
│  │   commiteado│        │ • Métricas equipo │            │
│  │ • Watcher   │        │ • Auditoría       │            │
│  │ • Fallback  │        │ • RBAC            │            │
│  └─────────────┘        └──────────────────┘            │
└─────────────────────────────────────────────────────────┘
```

### Principios de la arquitectura federada

1. **Índice local prioritario** para cambios no publicados. El working tree manda.
   Si un archivo tiene modificaciones locales, el índice local tiene prioridad sobre
   el compartido.

2. **Backend central autoritativo** para repos compartidos. Cuando no hay cambios
   locales, el índice compartido es la fuente de verdad. Evita que cada desarrollador
   re-indexe los mismos repos.

3. **Gateway MCP único** con:
   - **Procedencia obligatoria**: cada resultado indica si vino de índice local,
     índice compartido, o fallback heurístico.
   - **Deduplicación**: mismo símbolo en local y compartido → un solo resultado
     con procedencia mixta.
   - **Autorización**: el gateway aplica RBAC antes de devolver resultados del
     índice compartido.
   - **Fallback local**: si el backend central no responde en <300ms, el gateway
     responde con resultados locales y marca `provenance: local_fallback`.

4. **Sin dependencia externa en el hot path**: `pack_context`, `search_graph`, y
   `get_code_snippet` deben funcionar 100% offline. El backend central es un
   acelerador, no un requisito.

5. **Sincronización eventual**: el índice compartido se actualiza con webhooks de
   GitHub/GitLab o polling periódico. No hay consistencia fuerte en tiempo real.

---

## Prioridad estratégica inmediata

Antes de continuar con las fases 11–14, el orden de trabajo del proyecto pasa a ser:

1. **Optimización de LYNX (máxima prioridad).**
   - Reducir la sobreinvestigación del agente.
   - Reducir tokens, coste y latencia.
   - Optimizar los perfiles mínimos de herramientas por tipo de tarea.
   - Diseñar herramientas compuestas que resuelvan tareas completas con menos llamadas.
   - Mejorar continuamente el rendimiento y la eficiencia del agente.

2. **Evolución del Semantic-Aware Code Graph (SACG).**
   - Ampliar el conocimiento semántico del grafo.
   - Incorporar nuevas relaciones y evidencias.
   - Mejorar `explain_symbol`, `trace_path` y el análisis de impacto.
   - Convertir el SACG en el principal diferenciador técnico de LYNX.

El benchmark deja de ser el objetivo principal del desarrollo y pasa a utilizarse principalmente como instrumento para medir objetivamente la evolución de LYNX. Las fases 11–14 continúan siendo el roadmap oficial y deberán ejecutarse alineadas con estas dos prioridades.

---

## Fases de implementación

### Fase 11 — Consolidación de producto (2026-07 a 2026-08)

Objetivo: LYNX Local es sólido y genera confianza.

- [x] Métricas con procedencia, categorías mutuamente excluyentes, idempotencia
- [x] `summarizeHistory`, `aggregateTotal`, `collectProjectCards` unificados
- [x] Cobertura honesta (no disponible en vez de cobertura completa falsa)
- [x] Reconstrucción segura de snapshots (`rebuildDailySnapshots`)
- [x] Normalización de nombres de proyecto con alias explícitos
- [x] Tests de integración para el pipeline completo de métricas (metrics-pipeline.test.ts, 10 tests)
- [x] `lynx upgrade` — actualización del binario, migraciones de esquema
- [x] `lynx doctor` extendido: detecta snapshots corruptos, ofrece rebuild (11/11 checks)
- [x] Dashboard interactivo: métricas por ventana temporal (24h/7d/30d/total) con JS + SSR fallback
- [x] Dashboard: métricas con badges de procedencia y cobertura honesta por ventana
- [x] Tiers y capacidades locales: matriz Free/Pro/Team/Enterprise con `tierSatisfies()` y gating
- [x] Licencias locales: detección de tier, `TierGateError`, 33 capacidades gated
- [x] Aislamiento completo de tests: `LYNX_HOME` temporal, 0 escrituras reales, prueba contractual
- [ ] Dashboard: CSV export con descarga por ventana (paginación y JSON ya funcionan; CSV pendiente)
- [ ] **Graph Drift Detector**: comparar `git rev-parse HEAD` + timestamps de `file_hashes` contra `stat()` del disco antes de devolver resultados. Alerta si el índice está desactualizado respecto al working tree (~50–100ms, sin reindexar). Red de seguridad que evita decisiones sobre datos stale.
- [ ] **RRF Búsqueda Híbrida Unificada**: fusionar BM25 (`search_graph`) + vectores (`semantic_search`) + rerank LLM en una sola llamada con Reciprocal Rank Fusion. Las piezas ya existen por separado; unificarlas reduce round-trips del agente y mejora precisión.
- [ ] **Recorte Inteligente de Contexto en `investigate_symbol`**: colapsar o resumir cuerpos de funciones que superen un presupuesto de tokens, conservando solo firmas y tipos. Evita que God Objects saturen el contexto del agente.
- [ ] **Filtro de Impacto Activo (`only_diff_intersect`)**: parámetro booleano en `trace_path`, `search_graph` y `query_graph` que filtra resultados para mostrar solo caminos/nodos que intersectan archivos modificados en `git diff`. Intersección de arrays entre nodos del grafo y diff real — ~50 líneas, ahorro de tokens del ~80-90% en trazados sobre cambios activos. Conecta `detect_changes` con las herramientas de grafo.
- [ ] **Esqueleto AST (`skeleton` mode)**: modo de lectura en `get_code_snippet` que devuelve la función objetivo completa pero colapsa el cuerpo de todas las demás funciones del archivo a una sola línea (`{ ... }`). Usa los line ranges ya indexados en `nodes`. Conserva el contexto estructural del archivo (firmas, herencia) consumiendo ~10% de los tokens. Sinergia directa con Recorte Inteligente de Contexto.
- [ ] **Entrypoint Mapping — Extracción multienfoque**: ampliar el extractor de entrypoints más allá de Next.js App Router. Añadir patrones AST para Express (`app.get('/path', handler)`), Fastify (`fastify.get('/path', handler)`), NestJS (`@Get('/path')`), Koa, y Hono. Cada framework ~30-50 líneas de extractor. La columna `is_entry_point` ya existe en `nodes`; `passRoutes` ya crea nodos `Route` para Next.js. Esto generaliza el concepto. (~200 líneas total.)
- [ ] **Entrypoint Mapping — Tool + enriquecimiento**: nueva tool `list_entrypoints(project, method?, path_pattern?)` que consulta `SELECT * FROM nodes WHERE is_entry_point = 1`. Enriquecer `trace_path` para que cada nodo devuelva su `entrypoint_path` cuando es alcanzable transitivamente desde un entrypoint: `"POST /api/checkout (src/controllers/checkout.controller.ts:24)"`. Enriquecer `search_graph` con filtro `is_entry_point` y badge visual en resultados. (~100 líneas.)
- [ ] **Blast Radius — `queryDownstreamDependents` en `assess_impact`**: sexta consulta en el pipeline de `assess_impact` que responde la pregunta más común tras un cambio: "¿qué archivos importan o llaman a los símbolos que he modificado?" Una sola query SQL — `SELECT target_file FROM edges WHERE source_file IN (modified_files) AND type IN ('CALLS','IMPORTS','USAGE')` — resuelve el radio de impacto en <20ms. Añade el campo `direct_dependent_files` al output. Cierra el ciclo de edición: el agente sabe instantáneamente qué rompe antes de commitear. (~50 líneas.)
- [ ] **Sibling Call Invariant Checker (`check_invariants`)**: herramienta independiente que detecta "reglas invisibles" del código — pares de llamadas que co-ocurren en el mismo ámbito (misma función contenedora) con alta frecuencia. Algoritmo en 3 pasos SQL puro: (1) encontrar padres que llaman al símbolo A, (2) encontrar qué otros símbolos B llaman esos mismos padres, (3) si ≥85% de los padres de A también llaman a B, se ha descubierto un invariante arquitectónico implícito. Filtros anti-ruido: excluir nodos con fan-out >5% del proyecto (utilidades transversales como `logger.info`) y restringir co-ocurrencia al mismo nodo padre (scope de función). Tool nueva `check_invariants(project, file?)` — no sobrecarga `assess_impact`. Output: `"Has añadido charge() pero te falta recordTransaction() (94% confianza, 17/18 casos)"`. (~150-200 líneas.) Sinergia directa con Context-Flow: `pack_context` precargará invariantes de los símbolos en la zona de enfoque.
- [ ] **Event-Bridge Edge Resolver — Trazador de Flujos Asíncronos (`TRIGGERS`)**: tres cambios quirúrgicos sobre infraestructura ya existente: (1) Upgrade de `passSemanticLight` para asociar `EMITS`/`LISTENS_ON` a la función contenedora, no al archivo (~40 líneas). (2) Nuevo pass post-resolución: `JOIN publishers p JOIN subscribers s ON p.channelName = s.channelName → INSERT TRIGGERS edge` con confianza 0.7 (~50 líneas). (3) Activar `TRIGGERS`, `EMITS` y `LISTENS_ON` en los modos `data_flow` y `cross_service` de `trace_path` (~5 líneas). Resultado: `trace_path` ya no se detiene en `.emit()` o `.add()` — sigue el flujo completo a través de eventos, colas y dispatchers. `registerUser()` → `[TRIGGERS]` → `sendWelcomeEmail()`. Determinista, offline, <15ms en consulta. (~100 líneas total.)
- [ ] **Architecture Drift Prevention — Validador de Fronteras Arquitectónicas (`lynx-rules.json`)**: séptima consulta en el pipeline de `assess_impact` que cruza los edges del diff contra reglas de capas definidas por el usuario. Archivo de configuración `lynx-rules.json` con formato simple: `"layers": { "view": ["controller"], "controller": ["service"], "service": ["db"] }` donde cada entrada declara qué capas puede llamar cada capa. Mapeo de archivos a capas por glob: `"layerMap": { "view": "src/ui/**", "controller": "src/controllers/**", "service": "src/services/**", "db": "src/data/**" }`. Al ejecutar `assess_impact`, LYNX cruza `modified_files` × `edges` × `layer_rules` y emite violaciones: `"src/ui/login.ts → src/services/auth.ts VIOLA la regla 'view no puede llamar a service'"`. Convierte a LYNX en el primer "Linter de Arquitectura para IAs" — ningún desarrollador senior querrá trabajar con un agente que no garantice que el código generado respeta las fronteras del diseño. (~250-350 líneas.) Sinergia directa con SACG-027 (Blast Radius) y SACG-028 (Sibling Invariants) — la Trinidad Definitiva de Validación de Contexto para Agentes.
- [ ] **Mapa de Fronteras (`lynx-services.json`)**: archivo de configuración opcional que mapea endpoints HTTP/gRPC/GraphQL a repositorios externos. Cuando `trace_path` en modo `cross_service` detecta una llamada mapeada, sugiere al agente continuar el trazado en el repositorio destino. LYNX ya extrae `CROSS_HTTP_CALLS`, `CROSS_GRPC_CALLS`, etc.; esto añade la capa de resolución multi-repo sin analizar red. (~100 líneas, requiere adopción del usuario.)
- [ ] **Context-Flow: evolución activa de `pack_context` (Fase 1 — pre-computo de trazas)**: `pack_context` ejecuta `trace_path(depth=2)` automáticamente sobre los top 2-3 candidatos y devuelve el critical path resuelto en vez de solo sugerirlo. Elimina 2-3 round-trips del agente. Depende de: `only_diff_intersect` (priorizar zona caliente del diff), Graph Drift Detector (alertar índice stale), y Skeleton mode (referenciar snippets plegados en vez de duplicar lógica de lectura). (~150 líneas.)
- [ ] **Context-Flow: Fase 2 — cruce con diff activo**: `pack_context` consulta `detect_changes` internamente para priorizar candidatos en archivos modificados. Si el diff actual toca `pool.ts`, los candidatos en ese archivo reciben boost automático. Elimina la necesidad de que el agente correlacione diff + grafo manualmente. (~60 líneas.)
- [ ] **Context-Flow: Fase 3 — co-change mining (opcional, flag `include_cochange=true`)**: `pack_context` analiza `git log --follow` para detectar archivos modificados juntos históricamente. Fuera del hot path por defecto — solo bajo flag explícito para no degradar latencia. (~200 líneas. Pendiente de validación de señal/ruido antes de activar por defecto.)

### Fase 12 — LYNX Team MVP (2026-08 a 2026-10)

Objetivo: Un equipo de 5 puede compartir índice y métricas.

- [x] Gateway MCP federado: `IndexProvider` (local + shared), `FederatedGateway` (merge, dedup, timeout)
- [x] Primer vertical slice: `search_graph` y `trace_path` con `InMemorySharedIndexProvider`
- [x] Provenance obligatoria: `local | shared | mixed | local_fallback` en cada resultado
- [x] Deduplicación estable por símbolo/archivo con prioridad local (search: qn+file_path, trace: qn identity)
- [x] Autorización abstracta (`Authorizer`, `NoopAuthorizer`, `DenyAllAuthorizer`) antes de shared y post-filtrado
- [x] Timeout configurable con `Promise.race` — fallback local cuando shared expira/falla
- [x] Núcleos puros (`executeLocalSearchGraph`, `executeLocalTracePath`): sin métricas, narrativa ni MCP
- [x] Handlers refactorizados: delegan data retrieval a núcleos puros, conservan contrato local
- [x] 46 tests de federación: regresión (deep-equality), prioridad, shared-only, mixed, auth-denegada, timeout, error, orden estable
- [x] 461 tests total (38 files) — typecheck 0, build 0, doctor 11/11, git diff clean
- [x] Wiring productivo: `getFederatedConfig()` en handlers → gateway → providers; sin singleton global
- [x] 11 tests de integración handler→gateway: shared, mixed, auth, timeout, error vía search_graph + trace_path
- [x] Bug fix: `recordUsageEvent({ type: 'trace_path' })` corregido (era `search_graph`), `UsageEventType` actualizado
- [ ] Backend central: índice compartido read-only, API REST + WebSocket (real, no fake)
- [ ] Sincronización: webhook GitHub/GitLab → reindex → notificar gateways
- [ ] Cross-repo `trace_path`: seguir llamadas entre repositorios del equipo
- [ ] Roles básicos: admin, member, viewer con tokens de acceso
- [ ] Dashboard de equipo: métricas agregadas, top proyectos, top usuarios
- [ ] Métricas cross-repo: deduplicación de eventos entre repositorios
- [ ] `lynx team init` — configura un proyecto team en <2 minutos

### Fase 13 — Enterprise Lite (2026-10 a 2026-12)

Objetivo: Una organización de 200+ devs puede desplegar en su VPC.

- [ ] SSO SAML/OIDC (Keycloak, Okta, Azure AD como primeros IdP)
- [ ] RBAC por repositorio: read, write, admin a nivel de repo individual
- [ ] Auditoría: query log, access log, export JSON/CSV, retención configurable
- [ ] Despliegue privado: Docker Compose + instrucciones para AWS/GCP/Azure
- [ ] SLA 99.5% con health checks y métricas de disponibilidad
- [ ] Licencias JWT: sin phone-home, validación offline con expiración

### Fase 14 — Maduración (2027-01 en adelante)

Objetivo: Ecosistema, adopción, y comunidad.

- [ ] API pública versionada para integraciones de terceros
- [ ] Plugin system: extractores de lenguaje, rerankers, reporters
- [ ] Marketplace comunitario para plugins y configuraciones
- [ ] GitHub App oficial: PR comments con impacto, definiciones, referencias
- [ ] VS Code extension: panel lateral con grafo, métricas, búsqueda
- [ ] Documentación pública: guías, tutoriales, referencia de API

---

## Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Sourcegraph lanza producto local ligero | Media | Alto | Ventaja de foso: MCP nativo + métricas + working tree. Competir en integración con agentes, no en búsqueda pura |
| Adopción lenta por falta de marca | Alta | Medio | Crecer por boca a boca en comunidades de agentes (Claude Code, Codex, Cursor). El producto gratuito es el mejor marketing |
| Dependencia de APIs de terceros para rerank | Media | Medio | DeepSeek como fallback local; modo determinista siempre disponible; rerank no es crítico para el core |
| Fragmentación del ecosistema MCP | Media | Bajo | LYNX ya soporta 8 agentes; el formato MCP es estable; añadir nuevos agentes es ~20 líneas de configuración |
| Complejidad de la sincronización federada | Alta | Medio | Empezar con read-only compartido; la consistencia eventual es suficiente para el 90% de casos; no prometer tiempo real |
| Fatiga del equipo (proyecto de una persona) | Alta | Alto | Priorizar 80/20 sin piedad; decir que no a features; automatizar release/testing/doctor; construir comunidad de contribuidores |
| Competencia de GitHub Copilot/Cody con code graph integrado | Media | Medio | Diferenciación: LYNX es multi-agente, multi-LLM, local-first. Copilot está atado a GitHub y VS Code |

---

## Segmentos objetivo (Go-to-market inicial)

1. **Desarrolladores con Claude Code/Codex CLI** — ya usan MCP, ya sienten el
   dolor de contexto limitado. LYNX les da ~400 tokens en vez de ~20K por
   tarea. Canal: GitHub, docs de Claude Code, comunidades MCP.

2. **Startups de 5–50 devs** — sin infraestructura de código, sin presupuesto para
   Sourcegraph ($150+/dev/mes). LYNX Team a $15–25/dev/mes es margen cómodo.
   Canal: recomendación de desarrolladores que ya usan LYNX Local.

3. **Equipos de plataforma/DevEx en empresas medianas** — necesitan métricas de
   productividad de agentes y visibilidad de código sin montar Sourcegraph.
   LYNX Enterprise Lite les da auditoría + SSO + VPC. Canal: contactos directos,
   conferencias de DevEx.

---

## Notas de producto

- **No prometer "nunca" ni "siempre"**: las métricas son estimadas con procedencia
  explícita. No decimos "LYNX ahorra X tokens exactos". Decimos "LYNX estima
  X tokens ahorrados con confianza 0.7 basado en Y eventos".

- **No usar precios de competidores en comunicaciones**: este documento es interno.
  Las comunicaciones externas hablan de valor, no de comparaciones.

- **No hardcodear precios de APIs externas**: el pricing config es editable por el
  usuario. Los defaults son estimaciones conservadoras marcadas como tales.

- **Métricas auditables como ventaja competitiva**: poder responder "¿de dónde
  sale este número?" con un event_id, un hash de query, y una fórmula documentada
  es algo que Sourcegraph no ofrece. Explotarlo en ventas a equipos de plataforma.

- **El nombre "Enterprise Lite" es intencional**: decir "Enterprise" sin
  calificativo crea expectativas de compliance extremo que no queremos cumplir.
  "Lite" señala honestamente el alcance.

---

## Invariantes técnicos permanentes

Establecidos durante la validación de métricas (2026-07-10) y aplicables a todo
el desarrollo futuro:

1. **Idempotencia**: `flushTodayEvents` reemplaza, no acumula. Dos llamadas
   consecutivas producen el mismo resultado.
2. **sum(categories) = totals**: todas las métricas derivan de categorías
   mutuamente excluyentes. Sin atajos, sin sumas paralelas.
3. **Coincidencia API/HTML**: `/api/metrics`, `/api/projects`, y el dashboard
   HTML consumen la misma fuente canónica (`aggregateTotal`).
4. **Cobertura honesta**: si sessions/tasks/deterministic_mode no están
   disponibles, se reporta "no disponible", no 0 ni "cobertura completa".
5. **Sin duplicación**: dedup por event_id (v3) o hash legacy estable.
6. **Procedencia obligatoria**: cada número tiene `measured`, `estimated`, o
   `scenario` con fuente, fórmula, confianza y sample_size.
7. **Reconstrucción segura**: backup antes de mutar snapshots. Rollback ante
   fallo. Nunca borrar sin conservar evidencia.
8. **Alias explícitos**: normalización de nombres de proyecto solo mediante
   mapa de alias configurado. Sin fuzzy matching automático.
