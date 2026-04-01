# Changelog

All notable changes to the Ledger project.

## [Unreleased]

## M6 — Groq LLM + Ollama Embeddings

### Changed

- **LLM Provider**: Migrated from Mistral AI to Groq (`llama-3.3-70b-versatile`) for chat streaming, categorization, and query decomposition
- **Embedding Provider**: Migrated from Mistral Embed API to Ollama (`nomic-embed-text`, 768-dim local embeddings)
- **Service Rename**: `MistralService` → `LlmService`, `src/mistral/` → `src/llm/`
- **Categorization**: Rewritten to use `generateObject()` with Zod schema instead of raw API parsing
- **Database**: New migration to change pgvector column from 1024 to 768 dimensions

### Removed

- `@mistralai/mistralai` and `@ai-sdk/mistral` dependencies
- `MISTRAL_API_KEY` environment variable

### Added

- `@ai-sdk/groq` and `ollama` dependencies
- `GROQ_API_KEY` and `OLLAMA_BASE_URL` environment variables
- Database migration `1709700000002-ChangeEmbeddingDimension`

## [0.5.0] — 2026-03-06

### Milestone 4: Chunk & Embed

### Added

- ADR-003 documenting embedding strategy (chunking, pgvector, Mistral Embed)
- ChunkerService with ~500 token character-based chunks and configurable overlap
- Mistral Embed API integration (1024-dim vectors via mistral-embed model)
- Embedding entity with pgvector column and IVFFlat cosine similarity index
- TypeORM migration infrastructure (InitialSchema migration, data-source config, migrate script)
- Similarity search method for future RAG pipeline
- 17 embedding service tests + 21 chunker service tests (178 total)

### Changed

- Switched from `synchronize: true` to TypeORM migrations to fix pgvector column drop bug (typeorm#10056)
- Added explicit `@Inject()` decorators for ChunkerService and DataSource (esbuild DI compatibility)
- Upload pipeline now chains: parse → categorize → persist → chunk → embed

## [0.4.0] — 2026-03-04

### Milestone 3: Parse & Persist

### Added

- ADR-002 documenting parser strategy pattern (ParserInterface, heuristic detection)
- ParserInterface with `canParse()` and `parse()` methods
- PDF parser using pdf-parse with heuristic transaction line detection
- CSV parser using csv-parse with heuristic column detection
- Transaction TypeORM entity with statement FK, date, description, amount, type, category
- Mistral AI batch categorization of transaction descriptions
- `GET /transactions` with filters (statementId, date range, category, amount range, type)
- `PATCH /transactions/:id` for manual category and description edits
- Angular transactions page with filterable table and category editing
- Upload pipeline integration: upload → parse → categorize → persist
- Delete-and-reparse idempotency strategy for re-uploads
- DaisyUI integration and restyled frontend components
- Project Makefile with common development commands
- 117 new tests (178 total): parser, transaction, mistral, integration tests

## [0.3.0] — 2026-03-04

### Milestone 2: File Upload

### Added

- ADR-001 documenting upload strategy (local filesystem, Multer, layered validation)
- Upload module — NestJS controller + service with POST /upload, GET/DELETE /statements endpoints
- Statement TypeORM entity for `statements` table (UUID PK, file metadata, raw_text)
- Layered file validation — MIME type + extension check, 10MB limit, UUID filenames on disk
- Angular upload page with drag-and-drop FileDropzone component
- Angular ApiService for HTTP communication with backend
- 10 controller unit tests, 9 service unit tests, 13 integration tests (61 total)
- TypeORM + PostgreSQL integration with conditional module loading for CI

### Changed

- AppModule conditionally loads TypeORM when DATABASE_URL is present (smoke test compatibility)

## [0.2.0] — 2026-03-04

### Milestone 1: Health Check

### Added

- NestJS health module with GET /health endpoint returning `{ status: "ok", timestamp, uptime }`
- 4 unit tests + 3 integration tests for health controller (supertest)
- CI smoke test job that boots server and validates /health

### Fixed

- Missing @types/node in backend devDependencies (M0 gap)
- Backend ESLint script not working from subdirectory (M0 gap)

## [0.1.0] — 2026-03-04

### Milestone 0: Monorepo Scaffold

### Added

- NestJS backend scaffold with AppModule, AppController, and tests
- Angular frontend scaffold with standalone components (pnpm)
- Typed config loader (`backend/src/config.ts`) with env validation and defaults
- Structured JSON logger (`backend/src/logger.ts`) implementing NestJS LoggerService
- Graceful shutdown hooks (SIGTERM/SIGINT) in `main.ts`
- CORS support configurable via `CORS_ORIGIN` env var
- Multi-stage backend Dockerfile (`node:22-alpine` + pnpm)
- Docker Compose with PostgreSQL + pgvector and backend service
- Database migration runner scaffold (`backend/src/db/migrate.ts`)
- ESLint v9 flat config with typescript-eslint and Prettier
- Pre-commit hooks for code quality gates
- GitHub Actions CI (lint, test, build)
- Product and architecture documentation with Mermaid diagrams
- Agentic framework with personas, workflows, and quality gates
- `.env.example` with all configuration variables

### Changed

- **Runtime migration**: Bun → Node.js + pnpm + tsx + vitest
- Root and backend package.json scripts unified on pnpm
- Dockerfile switched from `oven/bun` to `node:22-alpine`
- CI workflow switched from `oven-sh/setup-bun` to `actions/setup-node` + `pnpm/action-setup`
- All `Bun.env` references replaced with `process.env` + dotenv
- All `bun:test` imports replaced with `vitest`
- CLAUDE.md rewritten for Node.js + pnpm guidance
- Agentic framework config updated for pnpm/vitest toolchain

### Removed

- Bun runtime dependency and `@types/bun`
- `bun.lock` lockfile
- Bun-specific quality gates example (`bun.md`)

### 12-Factor Compliance

- **#2 Dependencies**: Both `bun.lock` (removed) and `pnpm-lock.yaml` committed
- **#3 Config**: All config via environment variables, validated at startup
- **#5 Build/Release/Run**: Multi-stage Docker build separates concerns
- **#6 Processes**: Stateless server, no local state
- **#7 Port Binding**: PORT configurable via env (default 3000)
- **#9 Disposability**: Graceful shutdown with `enableShutdownHooks()`
- **#10 Dev/Prod Parity**: Same Docker image for all environments
- **#11 Logs**: Structured JSON to stdout, no file logging
- **#12 Admin Processes**: Migration runner scaffold in place
