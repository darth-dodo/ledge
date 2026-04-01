# Milestone 2 → Milestone 3 Handoff

> **Note**: As of M6, the LLM provider was migrated from Mistral to Groq, and embeddings from Mistral Embed to Ollama. See [ADR-005](../adrs/adr-005-groq-ollama-migration.md).

**Project**: Ledger
**Date**: 2026-03-04
**Handoff ID**: M2-M3

---

## Handoff Summary

**From**: Architect → Developer Persona (Sequential)
**To**: Architect → Developer → QA Persona (Sequential)
**Transition**: M2 (File Upload) → M3 (Parse & Persist)
**Status**: CLEAN_HANDOFF

---

## Context Transfer

### What Was Done

**Completed Work**:

- Designed file upload strategy (ADR-001) covering storage, validation, schema, and API design
- Created NestJS upload module with POST /upload, GET /statements, GET /statements/:id, DELETE /statements/:id
- Created Statement TypeORM entity with UUID PK, file metadata, nullable raw_text
- Implemented layered validation: MIME type + file extension + 10MB size limit + UUID filenames
- Created Angular upload page with drag-and-drop FileDropzone component and statements list
- Added ApiService for frontend-backend HTTP communication
- Wrote 32 new tests (10 controller unit + 9 service unit + 13 integration)
- Made TypeORM conditional in AppModule for CI smoke test compatibility

**Time Spent**: ~3 hours

**Artifacts Created**:

- `docs/adrs/adr-001-upload-strategy.md` — Architecture decision record for upload strategy
- `backend/src/upload/` — Complete upload module (controller, service, entity, DTOs, tests)
- `backend/src/app.module.ts` — Updated with conditional TypeORM + UploadModule
- `frontend/src/app/core/services/api.service.ts` — HTTP client wrapper
- `frontend/src/app/shared/components/file-dropzone/` — Drag-and-drop component
- `frontend/src/app/features/upload/` — Upload page component
- `docs/milestones/m2-file-upload.md` — Milestone completion document

**Key Decisions**:

- Local filesystem storage under UPLOAD_DIR with UUID filenames (simplicity for single-user MVP)
- Synchronous upload flow — parsing deferred to M3
- Layered validation at Multer (size) + Controller (MIME + extension) levels
- Explicit `@Inject()` decorators and `@Column({ type: ... })` for vitest/esbuild compatibility
- Conditional TypeORM loading when DATABASE_URL is missing/fake

---

### What Needs to Happen Next

**Immediate Actions** (Priority: High):

1. Design parser strategy pattern (ADR-002) — define ParserInterface with `canParse()` and `parse()` methods (~30min, Architect)
2. Implement PDF parser using `pdf-parse` library (~1h, Developer)
3. Implement CSV parser using `csv-parse` library (~1h, Developer)

**Follow-up Tasks** (Priority: Medium):

- [ ] Create transactions table and Transaction entity
- [ ] Extract transactions from parsed text: date, description, amount, type
- [ ] AI category assignment via Mistral API
- [ ] Wire parsing into upload flow (after file storage, parse and populate raw_text + transactions)
- [ ] Create GET /transactions with filters (date, category, amount)
- [ ] Create PATCH /transactions/:id for category edits
- [ ] Add Angular transactions view with filterable table
- [ ] Test idempotency (re-upload same file)

**Future Considerations** (Priority: Low):

- Bank-specific parser strategies for institutions with non-standard formats
- File content deduplication to prevent re-processing identical statements
- Background job queue for long-running parse operations (if PDF parsing is slow)

---

### Blockers and Concerns

**Active Blockers**: None

**Concerns Raised**:

- **Concern 1**: vitest/esbuild does not support emitDecoratorMetadata
  - Type: Technical
  - Severity: Medium (workaround in place)
  - Recommendation: All new NestJS constructors must use explicit `@Inject()`, all TypeORM columns must specify `type`. Document this as a project convention.

---

### Quality Status

**Quality Gates Progress**: 6/8 (2 N/A)

| Gate          | Status | Details                                                   |
| ------------- | ------ | --------------------------------------------------------- |
| Syntax        | ✅     | TypeScript compiles cleanly                               |
| Types         | ✅     | `tsc --noEmit` passes for backend and frontend            |
| Lint          | ✅     | ESLint + Prettier pass                                    |
| Security      | ✅     | Layered validation, UUID filenames prevent path traversal |
| Tests         | ✅     | 61 tests passing (32 new + 29 existing)                   |
| Performance   | ➖     | N/A — no performance targets                              |
| Accessibility | ➖     | N/A — minimal frontend                                    |
| Integration   | ✅     | Smoke test passes with conditional TypeORM                |

**Outstanding Quality Issues**: None

---

### Context Files

**Essential Reading**:

- `backend/src/upload/upload.service.ts` — Service pattern for DB + filesystem operations
- `backend/src/upload/entities/statement.entity.ts` — TypeORM entity pattern (explicit types, @Inject)
- `backend/src/upload/upload.integration.spec.ts` — Integration test pattern with mock repo
- `backend/src/app.module.ts` — Conditional module loading pattern
- `docs/adrs/adr-001-upload-strategy.md` — Upload strategy decisions

**Related Documentation**:

- `docs/architecture.md` — Section 9 (Parser Strategy Pattern), Section 4 (Database Schema)
- `docs/product.md` — Section 3 (Core Features: Multi-Bank Parsing)

---

## State of the System

- **What works**: File upload (PDF/CSV), statements CRUD, Angular upload page, drag-and-drop, health check, all 61 tests pass, CI green
- **Known issues**: None critical
- **Technical debt**: Conditional TypeORM loading adds complexity to AppModule; explicit @Inject() is a workaround not a fix

## Context for M3

The upload module stores files on disk and metadata in PostgreSQL. The `raw_text` column on the Statement entity is nullable and ready for M3 to populate with parsed content. The `transactions` table from architecture.md needs to be created.

Key points:

- The Statement entity's `raw_text` field is where parsed text should be stored
- Parser strategy pattern is already designed in `docs/architecture.md` section 9
- New entities must follow the explicit `type` pattern on `@Column()` decorators
- New services must use explicit `@Inject()` on constructor parameters
- New modules that depend on TypeORM should be added to the conditional block in AppModule

## Recommendations

- Follow the parser strategy pattern from architecture.md: `ParserInterface` with `canParse()` and `parse()` methods
- Create `backend/src/upload/parsers/` directory with `parser.interface.ts`, `pdf.parser.ts`, `csv.parser.ts`
- Create `backend/src/transactions/` module following the upload module pattern
- Use `csv-parse` for CSV parsing and `pdf-parse` for PDF text extraction
- Integration test the full pipeline: upload file → parse → verify transactions in DB
- Consider adding the Mistral module early (even with a mock) for AI category assignment

---

**Handoff Status**: COMPLETED
**Last Updated**: 2026-03-04
