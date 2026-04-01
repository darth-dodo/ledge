# Milestone 3: Parse & Persist

> **Note**: As of M6, the LLM provider was migrated from Mistral to Groq, and embeddings from Mistral Embed to Ollama. `MistralService` was renamed to `LlmService`. See [ADR-005](../adrs/adr-005-groq-ollama-migration.md).

## Objective

Implement strategy-pattern parsers for PDF/CSV bank statements, extract and persist transactions with AI-powered categorization via Mistral, and build a filterable Angular transactions view.

## Acceptance Criteria

- [x] ADR-002 documents the parser strategy pattern decisions
- [x] `ParserInterface` with `canParse()` and `parse()` methods
- [x] PDF parser extracts transactions using `pdf-parse`
- [x] CSV parser extracts transactions using `csv-parse`
- [x] Transaction entity with statement FK, date, description, amount, type, category
- [x] Upload flow triggers parsing and populates `raw_text` on Statement
- [x] Mistral AI assigns categories to parsed transactions
- [x] `GET /transactions` with filters (date range, category, amount range)
- [x] `PATCH /transactions/:id` for manual category edits
- [x] Angular transactions page with filterable table
- [x] Unit tests per parser (happy path + malformed input)
- [x] Integration test for full pipeline (upload → parse → persist → query)
- [x] Re-upload idempotency (same file doesn't create duplicate transactions)
- [x] CI passes (lint, types, tests)

## Prerequisites (Gate-In)

- [x] M2 deliverables verified: upload module, statements CRUD, Angular upload page
- [x] Statement entity has nullable `raw_text` column ready for parser output
- [x] `UPLOAD_DIR` stores files on disk accessible for parsing
- [x] Conditional TypeORM loading pattern established in AppModule

## Task Breakdown

| #     | Task                                                | Labels        | Coordination | Estimate |
| ----- | --------------------------------------------------- | ------------- | ------------ | -------- |
| AI-28 | Design parser strategy pattern (ADR-002)            | Docs, Backend | Architect    | ~30min   |
| AI-29 | Implement PDF and CSV parsers with ParserInterface  | Backend       | Developer    | ~2h      |
| AI-31 | Create transactions table and CRUD endpoints        | Backend       | Developer    | ~1.5h    |
| AI-30 | AI category assignment via Mistral                  | AI, Backend   | Developer    | ~1.5h    |
| AI-32 | Add Angular transactions view with filterable table | Frontend      | Developer    | ~1.5h    |
| AI-33 | Write parser unit and integration tests             | Testing       | QA           | ~1.5h    |

## Dependency Graph

```
AI-28 → AI-29 (parsers need ADR decisions)
AI-29 → AI-31 (transactions table needs parsed data shape)
AI-31 → AI-30 (categorization writes to transactions table)
AI-31 → AI-32 (frontend needs GET /transactions API)
AI-29 + AI-31 → AI-33 (tests need parsers + transactions)

      AI-28
        │
      AI-29
        │
      AI-31
      ╱    ╲
  AI-30   AI-32
      ╲    ╱
      AI-33
```

AI-30 and AI-32 are independent of each other and can be parallelized after AI-31.

## Architecture

### Parser Strategy Pattern

```
ParserInterface
├── canParse(buffer: Buffer, filename: string): boolean
└── parse(buffer: Buffer): ParsedTransaction[]

Implementations:
├── PdfParser  — uses pdf-parse, detects via .pdf extension + PDF magic bytes
└── CsvParser  — uses csv-parse, detects via .csv extension
```

`UploadService.processFile()` iterates registered parsers, calls `canParse()` to select the right one, then `parse()` to extract transactions. This makes adding bank-specific parsers trivial — implement the interface and register.

Reference: [architecture.md](../architecture.md) section 9.

### Upload → Parse Flow

```
POST /upload (existing)
  │
  ├── Store file on disk (M2, unchanged)
  ├── Create Statement row (M2, unchanged)
  │
  ├── NEW: Read file buffer from disk
  ├── NEW: Select parser via canParse()
  ├── NEW: Parse → extract raw_text + transactions[]
  ├── NEW: Update Statement.raw_text
  ├── NEW: Categorize transactions via Mistral
  └── NEW: Bulk-insert transactions
```

The upload endpoint remains synchronous. Parsing PDF/CSV bank statements is fast enough (<1s) that async processing is unnecessary for MVP.

### Transaction Schema

```sql
CREATE TABLE transactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id UUID NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  description  VARCHAR(500) NOT NULL,
  amount       DECIMAL(12,2) NOT NULL,
  type         VARCHAR(10) NOT NULL CHECK (type IN ('debit', 'credit')),
  category     VARCHAR(100)
);

CREATE INDEX ON transactions (statement_id);
CREATE INDEX ON transactions (date);
CREATE INDEX ON transactions (category);
```

`ON DELETE CASCADE` ensures deleting a statement cleans up its transactions.

### Mistral Category Assignment

Batch transactions descriptions into a single Mistral chat call with a classification prompt:

```
SYSTEM: You are a financial transaction categorizer.
Classify each transaction into exactly one category from:
[groceries, dining, transport, utilities, entertainment,
 shopping, health, education, travel, income, transfer, other]

Respond with a JSON array of categories in the same order.

USER: ["SWIGGY ORDER #123", "UBER TRIP", "NETFLIX SUBSCRIPTION", ...]
```

This is more token-efficient than one call per transaction. Store the category on the transaction row. Users can override via `PATCH /transactions/:id`.

### API Endpoints (New)

| Method | Endpoint            | Description                          |
| ------ | ------------------- | ------------------------------------ |
| GET    | `/transactions`     | List transactions with query filters |
| PATCH  | `/transactions/:id` | Update category or description       |

**GET /transactions query params:**

| Param         | Type     | Example             |
| ------------- | -------- | ------------------- |
| `statementId` | UUID     | Filter by statement |
| `startDate`   | ISO date | `2026-01-01`        |
| `endDate`     | ISO date | `2026-01-31`        |
| `category`    | string   | `groceries`         |
| `minAmount`   | number   | `100`               |
| `maxAmount`   | number   | `5000`              |
| `type`        | string   | `debit` or `credit` |

### Angular Transactions Page

```
/transactions route
├── TransactionFilters component
│   ├── Date range picker (start/end)
│   ├── Category dropdown
│   ├── Amount range inputs (min/max)
│   └── Type toggle (all/debit/credit)
└── TransactionsTable component
    ├── Columns: date, description, amount, type, category
    ├── Sortable headers
    └── Inline category edit (click to change)
```

## New Files (Planned)

```
backend/src/
├── upload/parsers/
│   ├── parser.interface.ts      # ParserInterface + ParsedTransaction type
│   ├── pdf.parser.ts            # PDF parser using pdf-parse
│   └── csv.parser.ts            # CSV parser using csv-parse
├── transactions/
│   ├── transactions.module.ts
│   ├── transactions.controller.ts
│   ├── transactions.service.ts
│   └── entities/
│       └── transaction.entity.ts
├── mistral/
│   ├── mistral.module.ts
│   └── mistral.service.ts

frontend/src/app/
├── core/services/
│   └── transactions.service.ts   # HTTP client for /transactions
└── features/transactions/
    ├── transactions.component.ts  # Page with filters + table
    ├── transaction-filters.component.ts
    └── transactions-table.component.ts

docs/adrs/
└── adr-002-parser-strategy.md
```

## New Dependencies

| Package                | Purpose                           | Workspace |
| ---------------------- | --------------------------------- | --------- |
| `pdf-parse`            | PDF text extraction               | backend   |
| `csv-parse`            | CSV parsing                       | backend   |
| `@mistralai/mistralai` | Mistral AI SDK for categorization | backend   |

## Key Conventions (from M2 handoff)

- All TypeORM `@Column()` decorators must specify explicit `type` (vitest/esbuild compat)
- All NestJS constructor params must use explicit `@Inject()` or `@InjectRepository()`
- New TypeORM-dependent modules added to conditional block in `app.module.ts`
- Follow existing test patterns from `upload.integration.spec.ts`

## Idempotency Strategy

Re-uploading the same file should not create duplicate transactions. Options:

1. **Statement-level guard**: Check if `Statement.raw_text` is already populated — skip parsing
2. **Transaction-level dedup**: Before bulk insert, delete existing transactions for that statement_id
3. **File hash**: Store SHA-256 hash of file content, reject duplicates at upload time

Recommended: Option 2 (delete-and-reparse) — simplest, handles the case where parser logic improves and user wants to re-parse.

## Risks

- **PDF parsing quality**: Generic `pdf-parse` may not cleanly extract tabular transaction data from all bank PDF formats. Mitigation: start with well-structured PDFs, add bank-specific parsers later.
- **Mistral API availability**: Categorization depends on external API. Mitigation: make categorization optional — store transactions with `category: null` if Mistral fails, let user categorize manually.
- **CSV format variance**: Bank CSVs have no standard column naming. Mitigation: use heuristic column detection (look for date-like, amount-like, description-like columns).

## Quality Gates

| Gate             | Target | Notes                                                 |
| ---------------- | ------ | ----------------------------------------------------- |
| 1. Syntax        | Pass   | TypeScript compiles cleanly                           |
| 2. Types         | Pass   | `tsc --noEmit` for backend and frontend               |
| 3. Lint          | Pass   | ESLint + Prettier                                     |
| 4. Security      | Pass   | Validate Mistral API key exists, sanitize parsed text |
| 5. Tests         | Pass   | Parser unit tests + pipeline integration test         |
| 6. Performance   | N/A    | No performance targets for parsing                    |
| 7. Accessibility | N/A    | Basic table UI                                        |
| 8. Integration   | Pass   | CI smoke test passes                                  |
