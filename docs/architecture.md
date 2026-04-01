# Ledger — Architecture Document

---

## 1. System Overview

```mermaid
graph TB
    subgraph Frontend ["Angular Frontend :4200"]
        UP[Upload Module]
        DASH[Dashboard]
        CHAT[Chat Interface]
        TX[Transactions View]
        SET[Settings]
    end

    subgraph Backend ["NestJS Backend :3000"]
        UC[Upload Controller]
        TC[Transactions Controller]
        AC[Analytics Controller]
        RC[RAG Controller]

        US[Upload Service]
        PS[Parser Service]
        CS[Chunker Service]
        ES[Embedding Service]
        RS[RAG Service]
        AS[Analytics Service]
        LS[LLM Service]
    end

    subgraph Data ["PostgreSQL + pgvector"]
        ST[(statements)]
        TT[(transactions)]
        EM[(embeddings)]
        CSS[(chat_sessions)]
        CM[(chat_messages)]
    end

    subgraph ExtGroq ["Groq"]
        MC[Chat API]
    end

    subgraph ExtOllama ["Ollama"]
        ME[Embed API]
    end

    UP -->|HTTP POST /upload| UC
    TX -->|HTTP GET /transactions| TC
    DASH -->|HTTP GET /analytics/*| AC
    CHAT -->|HTTP POST /chat| RC

    UC --> US --> PS --> CS --> ES
    ES --> ME
    RS --> LS --> MC
    RS --> ES

    US --> ST
    US --> TT
    ES --> EM
    RS --> CSS
    RS --> CM
    AS --> TT

    style Frontend fill:#e8f4f8
    style Backend fill:#fff3cd
    style Data fill:#d4edda
    style ExtGroq fill:#f8d7da
    style ExtOllama fill:#fce4ec
```

---

## 2. Data Flow — Upload & Ingest Pipeline

```mermaid
flowchart TD
    A[User uploads PDF/CSV] --> B{Detect file type}

    B -->|PDF| C[PDF Parser<br/><i>pdf-parse</i>]
    B -->|CSV| D[CSV Parser<br/><i>csv-parse</i>]

    C --> E[Bank-Specific Strategy<br/><i>Detect bank format automatically</i>]
    D --> E

    E --> F[Extract Transactions<br/><i>date, description, amount, type</i>]

    F --> G[AI Category Assignment<br/><i>Groq classifies each transaction</i>]

    G --> H[Store in PostgreSQL<br/><i>statements + transactions tables</i>]

    F --> I[Chunk Statement Text<br/><i>~500 tokens with overlap</i>]

    I --> J[Generate Embeddings<br/><i>Ollama nomic-embed-text → 768-dim vectors</i>]

    J --> K[Store in pgvector<br/><i>embeddings table</i>]

    H --> L[Done]
    K --> L

    style A fill:#e8f4f8
    style L fill:#d4edda
    style E fill:#fff3cd
```

---

## 3. Data Flow — RAG Chat Pipeline

```mermaid
sequenceDiagram
    participant User
    participant Angular
    participant NestJS
    participant Groq as Groq (Vercel AI SDK)
    participant Ollama as Ollama
    participant pgvector as PostgreSQL + pgvector

    User->>Angular: Types question
    Angular->>NestJS: POST /chat { sessionId?, message, currency }

    rect rgb(255, 243, 205)
        Note over NestJS: 1. Session + message persistence
        NestJS->>pgvector: Create/load ChatSession
        NestJS->>pgvector: Save user ChatMessage
        NestJS->>pgvector: Load conversation history (last 10)
    end

    rect rgb(248, 215, 218)
        Note over NestJS,Groq: 2. Streaming tool-calling loop
        NestJS->>Groq: streamText() with tools + history (SSE)
        Note over NestJS,Groq: Step 0 — DECOMPOSE
        Groq-->>NestJS: Tool call (decompose_query)
        NestJS->>Groq: generateObject() → SubQuery[] with intents
        Groq-->>NestJS: SubQuery[] (sql_aggregate | sql_filter | vector_search | hybrid)
        NestJS->>Groq: Tool result (sub-queries)
        loop Up to remaining tool-calling steps
            Groq-->>NestJS: Tool call (vector_search or sql_query)
            alt vector_search
                NestJS->>Ollama: Embed query → 768-dim vector
                Ollama-->>NestJS: Query vector
                NestJS->>pgvector: Cosine search (top 5 chunks)
                pgvector-->>NestJS: Relevant chunks
            else sql_query
                NestJS->>NestJS: Validate SQL (SELECT-only, transactions table)
                NestJS->>pgvector: Execute read-only query (LIMIT 100)
                pgvector-->>NestJS: Query results
            end
            NestJS->>Groq: Tool result
        end
        Groq-->>NestJS: Final text response (streamed)
    end

    NestJS-->>Angular: SSE stream (UI message stream format)
    Angular-->>User: Render markdown + streaming tokens

    rect rgb(212, 237, 218)
        Note over NestJS,pgvector: 3. Background persistence
        NestJS->>pgvector: Save assistant ChatMessage
        NestJS->>pgvector: Auto-title session (first message)
    end
```

The RAG pipeline uses a **ReAct agent loop** (7 tools) via Vercel AI SDK's `streamText()` with `stopWhen: stepCountIs(3)`. The agent follows a DECOMPOSE → THINK → ACT → OBSERVE → REPEAT → DONE cycle. On every new user message the agent first calls `decompose_query` to break the question into typed sub-queries, then selects `vector_search`, `sql_query`, or both based on the returned intent tags. Responses stream to the frontend as SSE in the AI SDK v6 UI message stream format.

### ReAct Agent Tools (7 total)

| Tool              | Purpose                                                                                |
| ----------------- | -------------------------------------------------------------------------------------- |
| `decompose_query` | Break the user question into `SubQuery[]` with intent tags; called first on every turn |
| `think`           | Internal reasoning step (no side effects)                                              |
| `vector_search`   | Semantic similarity search over statement text chunks (pgvector)                       |
| `sql_query`       | Read-only SELECT against the transactions table                                        |
| `update_category` | Update the category of a transaction                                                   |
| `chart_data`      | Return structured data for rendering a chart                                           |
| `done`            | Signal end of reasoning loop and emit final answer                                     |

Intent tags returned by `decompose_query` guide tool selection: `sql_aggregate` and `sql_filter` → `sql_query`; `vector_search` → `vector_search`; `hybrid` → both.

### RAG System Prompt

The system prompt is built dynamically with the user's selected currency. It provides:

- ReAct loop instructions: DECOMPOSE (call `decompose_query` first), THINK, ACT, OBSERVE, REPEAT, DONE
- Tool descriptions and when to use each one
- Full `transactions` table schema for SQL generation
- Example SQL queries (PostgreSQL syntax) for common financial questions
- Currency formatting instructions

```
SYSTEM:
You are a helpful financial assistant analyzing the user's bank statements
and transactions.

Follow this loop for every message:
1. DECOMPOSE — call decompose_query to break the question into sub-queries
2. THINK     — call think to reason about which tools to use
3. ACT       — call the appropriate tool(s) based on sub-query intents
4. OBSERVE   — inspect results, repeat ACT if needed
5. DONE      — call done with the final answer

You have access to 7 tools:
- decompose_query: Break the question into typed sub-queries (always call first)
- think: Internal reasoning step
- vector_search: Semantic search over statement text chunks
- sql_query: Read-only SQL against the transactions table
- update_category: Update a transaction's category
- chart_data: Return structured data for a chart
- done: Signal the end of the loop

The transactions table schema (PostgreSQL):
  id, statement_id, date, description, amount, category, type

The user's preferred currency is {currency}. Format all monetary amounts
using {currency}.
```

---

## 4. Database Schema

```mermaid
erDiagram
    statements {
        uuid id PK
        varchar filename
        varchar file_type "pdf | csv"
        varchar file_path "UUID filename on disk"
        int file_size "bytes"
        text raw_text "nullable, populated by M3"
        timestamptz uploaded_at
    }

    transactions {
        uuid id PK
        uuid statement_id FK
        date date
        varchar description
        decimal amount "12,2"
        varchar category "AI-assigned"
        varchar type "debit | credit"
    }

    embeddings {
        uuid id PK
        uuid statement_id FK
        int chunk_index
        text content "chunk text"
        int token_count
        vector embedding "768-dim, nullable"
        timestamptz created_at
    }

    chat_sessions {
        uuid id PK
        varchar title "nullable, auto-generated"
        timestamptz created_at
        timestamptz updated_at
    }

    chat_messages {
        uuid id PK
        uuid session_id FK
        varchar role "user | assistant"
        text content
        jsonb sources "nullable, chunk references"
        timestamptz created_at
    }

    statements ||--o{ transactions : "has many"
    statements ||--o{ embeddings : "has many"
    chat_sessions ||--o{ chat_messages : "has many (CASCADE delete)"
```

### Key Indexes

```sql
-- Vector similarity search (IVFFlat for approximate nearest neighbor)
CREATE INDEX ON embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Transaction queries
CREATE INDEX ON transactions (date);
CREATE INDEX ON transactions (category);
CREATE INDEX ON transactions (statement_id);

-- Chat message lookup by session
CREATE INDEX ON chat_messages (session_id);
```

---

## 5. NestJS Backend Structure

```mermaid
graph TD
    subgraph AppModule
        subgraph UploadModule
            UC2[UploadController]
            US2[UploadService]
            PDF[PdfParser]
            CSV[CsvParser]
        end

        subgraph TransactionsModule
            TC2[TransactionsController]
            TS2[TransactionsService]
            TE[Transaction Entity]
        end

        subgraph EmbeddingsModule
            ES2[EmbeddingsService]
            CHK[ChunkerService]
            EE[Embedding Entity]
        end

        subgraph RagModule ["RagModule ✅ M5"]
            RC2[RagController]
            RS2[RagService]
            CSE[ChatSession Entity]
            CME[ChatMessage Entity]
            DQT[decompose_query Tool]
            VST[vector_search Tool]
            SQT[sql_query Tool]
        end

        subgraph AnalyticsModule ["AnalyticsModule 🚧 M7"]
            AC2[AnalyticsController]
            AS2[AnalyticsService]
        end

        subgraph LlmModule
            LS2[LlmService]
        end

        DB["db/ (migrations + data-source)"]
    end

    style UploadModule fill:#e8f4f8
    style TransactionsModule fill:#d4edda
    style EmbeddingsModule fill:#fff3cd
    style RagModule fill:#f8d7da
    style AnalyticsModule fill:#e2d9f3
    style LlmModule fill:#fce4ec
```

### Directory Layout

```
backend/
├── src/
│   ├── app.module.ts              # Conditional TypeORM + module registration
│   ├── app.controller.ts          # Root controller
│   ├── main.ts                    # Bootstrap with graceful shutdown
│   ├── config.ts                  # Typed env config loader
│   ├── logger.ts                  # Structured JSON logger
│   ├── health/                    # ✅ M1
│   │   ├── health.module.ts
│   │   └── health.controller.ts
│   ├── upload/                    # ✅ M2
│   │   ├── upload.module.ts
│   │   ├── upload.controller.ts
│   │   ├── upload.service.ts
│   │   ├── entities/
│   │   │   └── statement.entity.ts
│   │   ├── dto/
│   │   │   └── upload-response.dto.ts
│   │   └── parsers/               # ✅ M3
│   │       ├── parser.interface.ts
│   │       ├── pdf.parser.ts
│   │       └── csv.parser.ts
│   ├── transactions/              # ✅ M3
│   │   ├── transactions.module.ts
│   │   ├── transactions.controller.ts
│   │   ├── transactions.service.ts
│   │   └── entities/
│   │       └── transaction.entity.ts
│   ├── embeddings/                # ✅ M4
│   │   ├── embeddings.module.ts
│   │   ├── embeddings.service.ts
│   │   ├── chunker.service.ts
│   │   └── entities/
│   │       └── embedding.entity.ts
│   ├── llm/                       # ✅ M3 (renamed from mistral/ in M6)
│   │   ├── llm.module.ts
│   │   └── llm.service.ts
│   ├── db/                        # ✅ M4
│   │   ├── data-source.ts
│   │   ├── migrate.ts
│   │   └── migrations/
│   │       ├── index.ts
│   │       ├── 1709700000000-InitialSchema.ts
│   │       └── 1709700000001-AddChatTables.ts
│   ├── rag/                       # ✅ M5
│   │   ├── rag.module.ts
│   │   ├── rag.controller.ts      #   POST /chat (SSE), GET sessions, DELETE session
│   │   ├── rag.service.ts         #   Session mgmt, message persistence, tool-calling loop
│   │   ├── entities/
│   │   │   ├── chat-session.entity.ts
│   │   │   └── chat-message.entity.ts
│   │   └── tools/
│   │       ├── decompose-query.tool.ts # Query decomposition into typed SubQuery[]
│   │       ├── vector-search.tool.ts   # Semantic search via embeddings
│   │       └── sql-query.tool.ts       # Read-only SELECT with safety validation
│   ├── analytics/                 # 🚧 M7 (planned)
│   └── common/                    # 🚧 M8 (planned)
├── nest-cli.json
├── tsconfig.json
└── package.json
```

---

## 6. Angular Frontend Structure

### Component Architecture

```mermaid
graph TD
    subgraph AppComponent
        NAV[Navigation Bar]

        subgraph UploadPage ["/upload"]
            DZ[FileDropzone]
            SL[StatementsList]
        end

        subgraph TransactionsPage ["/transactions"]
            TF[TransactionFilters]
            TT2[TransactionsTable]
        end

        subgraph ChatPage ["/chat"]
            SB[Session Sidebar]
            MA[Message Area]
            MI[MessageInput]
            MD[MarkdownPipe]
        end

        subgraph SettingsPage ["/settings"]
            CS[CurrencySelector]
        end

        subgraph DashboardPage ["/dashboard"]
            STAT[StatCards]
            CAT[CategoryBreakdown]
            MTR[MonthlyTrends]
            HM[DailyHeatmap]
            REC[RecurringList]
        end
    end

    style UploadPage fill:#e8f4f8
    style TransactionsPage fill:#d4edda
    style ChatPage fill:#f8d7da
    style SettingsPage fill:#fce4ec
    style DashboardPage fill:#e2d9f3
```

### Directory Layout

```
frontend/
├── src/
│   ├── app/
│   │   ├── app.component.ts           # Nav bar + router outlet
│   │   ├── app.config.ts              # provideRouter + provideHttpClient
│   │   ├── app.routes.ts              # Lazy-loaded routes
│   │   ├── core/
│   │   │   └── services/
│   │   │       ├── api.service.ts          # ✅ M2: HTTP client wrapper
│   │   │       ├── transactions.service.ts # ✅ M3: Transaction HTTP client
│   │   │       ├── chat.service.ts         # ✅ M5: SSE streaming + session CRUD
│   │   │       └── settings.service.ts     # ✅ M5: Currency localStorage persistence
│   │   ├── shared/
│   │   │   ├── components/
│   │   │   │   └── file-dropzone/          # ✅ M2: Drag-and-drop
│   │   │   └── pipes/
│   │   │       └── markdown.pipe.ts        # ✅ M5: Markdown rendering (marked)
│   │   └── features/
│   │       ├── upload/                     # ✅ M2: Upload page
│   │       ├── transactions/               # ✅ M3: Transactions page
│   │       ├── chat/                       # ✅ M5: RAG chat interface
│   │       │   └── chat.component.ts       #   Session sidebar + SSE streaming
│   │       ├── settings/                   # ✅ M5: User preferences
│   │       │   └── settings.component.ts   #   Currency selector
│   │       └── dashboard/                  # 🚧 M7 (planned)
│   └── styles.scss
├── angular.json
├── tsconfig.json
└── package.json
```

---

## 7. API Endpoints

### Upload

| Method | Endpoint          | Description                                      |
| ------ | ----------------- | ------------------------------------------------ |
| POST   | `/upload`         | Upload PDF/CSV → triggers parse + embed pipeline |
| GET    | `/statements`     | List all uploaded statements                     |
| GET    | `/statements/:id` | Statement detail + parsed transactions           |
| DELETE | `/statements/:id` | Delete statement + related data                  |

### Transactions

| Method | Endpoint            | Description                                          |
| ------ | ------------------- | ---------------------------------------------------- |
| GET    | `/transactions`     | List transactions (filter by date, category, amount) |
| PATCH  | `/transactions/:id` | Edit category or description                         |

### Analytics

| Method | Endpoint                | Description                                |
| ------ | ----------------------- | ------------------------------------------ |
| GET    | `/analytics/summary`    | Total in/out, top categories, savings rate |
| GET    | `/analytics/categories` | Spending by category                       |
| GET    | `/analytics/monthly`    | Month-over-month breakdown                 |
| GET    | `/analytics/daily`      | Daily spending data (for heatmap)          |

### Chat (RAG)

| Method | Endpoint                      | Description                                                         |
| ------ | ----------------------------- | ------------------------------------------------------------------- |
| POST   | `/chat`                       | Send message → SSE stream (tool-calling loop, returns X-Session-Id) |
| GET    | `/chat/sessions`              | List all chat sessions (ordered by updatedAt DESC)                  |
| GET    | `/chat/sessions/:id/messages` | Get messages for a session (ordered by createdAt ASC)               |
| DELETE | `/chat/sessions/:id`          | Delete a session and its messages (CASCADE)                         |

### Health

| Method | Endpoint  | Description          |
| ------ | --------- | -------------------- |
| GET    | `/health` | Backend health check |

---

## 8. LLM & Embedding Integration

The project uses **Groq** for LLM inference (chat, categorization, query decomposition) and **Ollama** for local embeddings. The integration is split across two services: `LlmService` for all Groq-powered operations and `EmbeddingsService` for Ollama-powered vector generation.

### LlmService (`src/llm/llm.service.ts`)

Three capabilities via `@ai-sdk/groq`:

**1. Chat Categorization** — batch transaction classification (via Vercel AI SDK `generateObject`)

```typescript
// llm.service.ts — uses generateObject() with Zod schema
async categorize(descriptions: string[]): Promise<(string | null)[]> {
  const { object } = await generateObject({
    model: this.aiModel,          // createGroq({ apiKey })('llama-3.3-70b-versatile')
    schema: categorizeSchema,     // Zod schema for { categories: string[] }
    prompt: `Categorize these transactions: ${JSON.stringify(descriptions)}`,
  });
  // Validate against VALID_CATEGORIES set
}
```

**2. Query Decomposition** — structured sub-query generation (via Vercel AI SDK `generateObject`)

```typescript
// llm.service.ts — uses generateObject() (non-streaming)
async decomposeQuery(message: string): Promise<SubQuery[]> {
  const { object } = await generateObject({
    model: this.aiModel,
    schema: z.object({
      subQueries: z.array(z.object({
        query: z.string(),
        intent: z.enum(['sql_aggregate', 'sql_filter', 'vector_search', 'hybrid']),
      })),
    }),
    prompt: `Decompose this financial question into sub-queries: ${message}`,
  });
  return object.subQueries;
}
```

**3. Streaming Chat with Tools** — ReAct agent loop (via Vercel AI SDK `@ai-sdk/groq`)

```typescript
// llm.service.ts — uses createGroq() from @ai-sdk/groq
chatStream(params: {
  system: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxSteps?: number;
}): ReturnType<typeof streamText> {
  return streamText({
    model: this.aiModel,          // createGroq({ apiKey })('llama-3.3-70b-versatile')
    system: params.system,
    messages: params.messages,
    tools: params.tools,
    stopWhen: stepCountIs(params.maxSteps ?? 3),
  });
}
```

### EmbeddingsService (`src/embeddings/embeddings.service.ts`)

Embeddings are generated locally via **Ollama** using the `nomic-embed-text` model (768-dim vectors).

```typescript
// embeddings.service.ts — uses ollama client
async getEmbeddings(texts: string[]): Promise<number[][]> {
  // Calls Ollama at OLLAMA_BASE_URL with model 'nomic-embed-text'
  // Returns 768-dim vectors for each input text
}
```

The `LlmService` requires `GROQ_API_KEY` and gracefully degrades when not set (categorization skipped, chat throws). The `EmbeddingsService` requires `OLLAMA_BASE_URL` (defaults to `http://localhost:11434`) for local embedding generation.

---

## 9. Parser Strategy Pattern

```mermaid
classDiagram
    class ParserInterface {
        <<interface>>
        +canParse(buffer: Buffer, filename: string) boolean
        +parse(buffer: Buffer) Transaction[]
    }

    class PdfParser {
        +canParse(buffer, filename) boolean
        +parse(buffer) Transaction[]
    }

    class CsvParser {
        +canParse(buffer, filename) boolean
        +parse(buffer) Transaction[]
    }

    class GenericPdfParser {
        +canParse(buffer, filename) boolean
        +parse(buffer) Transaction[]
    }

    class BankAPdfParser {
        +canParse(buffer, filename) boolean
        +parse(buffer) Transaction[]
    }

    class UploadService {
        -parsers: ParserInterface[]
        +processFile(file) Transaction[]
    }

    ParserInterface <|.. PdfParser
    ParserInterface <|.. CsvParser
    ParserInterface <|.. GenericPdfParser
    ParserInterface <|.. BankAPdfParser
    UploadService --> ParserInterface : uses
```

The `UploadService` iterates through registered parsers, calling `canParse()` to find the right one. This makes adding new bank formats trivial — implement the interface and register it. Start with a generic PDF/CSV parser, then add bank-specific parsers as needed for formats that don't parse cleanly.

---

## 10. Environment Variables

```env
# .env (never commit)
DATABASE_URL=postgresql://ledger:ledger@localhost:5432/ledger
GROQ_API_KEY=your-key-here
OLLAMA_BASE_URL=http://localhost:11434
JWT_SECRET=your-jwt-secret
UPLOAD_DIR=./uploads
```

---

## 11. Docker Compose (M3+)

```yaml
# docker-compose.yml
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: ledger
      POSTGRES_USER: ledger
      POSTGRES_PASSWORD: ledger
    ports:
      - '5432:5432'
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

---

## 12. Key Dependencies

### Backend (NestJS)

| Package                       | Purpose                                        |
| ----------------------------- | ---------------------------------------------- |
| `@nestjs/core`                | NestJS framework                               |
| `@nestjs/typeorm` + `typeorm` | ORM + database                                 |
| `pg`                          | PostgreSQL driver                              |
| `@ai-sdk/groq`                | Vercel AI SDK Groq provider (chat, categorize) |
| `ai`                          | Vercel AI SDK (streamText, tool-calling)       |
| `ollama`                      | Ollama client (local embeddings)               |
| `zod`                         | Schema validation (tool input schemas)         |
| `pdf-parse`                   | PDF text extraction                            |
| `csv-parse`                   | CSV parsing                                    |
| `multer`                      | File upload handling                           |

### Frontend (Angular)

| Package                   | Purpose                        |
| ------------------------- | ------------------------------ |
| `@angular/core`           | Angular framework              |
| `tailwindcss` + `daisyui` | Utility-first CSS + components |
| `marked`                  | Markdown rendering in chat     |
| `@tailwindcss/typography` | Prose styling for markdown     |

---

## 13. Testing & Coverage

### Test Strategy

| Layer    | Runner               | Tests | Coverage                                            |
| -------- | -------------------- | ----- | --------------------------------------------------- |
| Backend  | Vitest               | 246   | 96.46% statements, 91.01% branches, 100% functions  |
| Frontend | Vitest (via Angular) | 56    | 95.02% statements, 92.38% branches, 87.5% functions |

**Total: 302 tests, all passing.**

### Backend Test Organization

```
backend/src/
├── *.spec.ts                    # Co-located with source files
├── upload/
│   ├── upload.service.spec.ts
│   ├── upload.controller.spec.ts
│   ├── upload.integration.spec.ts
│   └── parsers/
│       ├── pdf.parser.spec.ts
│       └── csv.parser.spec.ts
├── rag/
│   ├── rag.service.spec.ts
│   ├── rag.controller.spec.ts
│   └── tools/
│       ├── sql-query.tool.spec.ts
│       └── vector-search.tool.spec.ts
├── transactions/
│   ├── transactions.service.spec.ts
│   └── transactions.controller.spec.ts
├── embeddings/
│   └── embeddings.service.spec.ts
└── llm/
    └── llm.service.spec.ts
```

### Frontend Test Organization

```
frontend/src/app/
├── app.component.spec.ts
├── core/services/
│   ├── api.service.spec.ts
│   ├── chat.service.spec.ts        # SSE streaming, legacy format parsing
│   ├── settings.service.spec.ts
│   └── transactions.service.spec.ts
└── shared/
    ├── components/file-dropzone/
    │   └── file-dropzone.component.spec.ts
    └── pipes/
        └── markdown.pipe.spec.ts
```

### Coverage Enforcement

- **Backend**: Thresholds set at 85% (statements, branches, functions, lines) in `backend/vitest.config.ts`
- **Frontend**: Coverage enabled by default via `angular.json` test options using `@vitest/coverage-v8`
- **CI**: Both backend and frontend coverage reports are generated in the GitHub Actions pipeline and displayed in the job summary
