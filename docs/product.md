# Ledger — Product Document

### _Your financial ledger. Ask anything._

---

## 1. Vision

Ledger is a personal finance tool that lets you upload bank statements, automatically parse transactions, and interact with your financial data through natural language chat and visual analytics.

---

## Current Status

**M5 (RAG Chat) is complete.** The full upload-to-chat pipeline is functional: users can upload bank statements, view parsed transactions, and ask natural language questions about their finances. The chat system uses LLM function calling with three tools (`decompose_query` for adaptive query decomposition into structured sub-queries, `vector_search` for semantic retrieval over statement chunks, and `sql_query` for read-only aggregation queries against the transactions table), SSE streaming for real-time response display, and Markdown rendering. Compound questions (e.g. "How much did I spend on groceries vs dining, AND find any Uber charges?") are decomposed into tagged sub-queries before the agent acts, improving accuracy and tool selection. A settings page lets users select their currency, which persists in localStorage and formats monetary values in chat responses. Test coverage is at 96% (backend) and 95% (frontend) with 302 tests across both. Next milestone is M6 (Full Dashboard) for visual analytics.

---

## 2. Target User

- **Who**: Individual tracking personal finances
- **Problem**: Bank statements are PDFs/CSVs that sit in downloads folders. Understanding spending patterns requires manual spreadsheet work.
- **Solution**: Upload statements → get structured data + AI-powered Q&A + visual dashboards instantly

---

## 3. Core Features

### MVP (M0–M5) -- Complete

| Feature            | Description                                                                                             | Priority | Status |
| ------------------ | ------------------------------------------------------------------------------------------------------- | -------- | ------ |
| Statement Upload   | Drag-and-drop PDF/CSV upload with fire-and-forget UX                                                    | P0       | Done   |
| Multi-Bank Parsing | Extensible parser strategy for various bank formats                                                     | P0       | Done   |
| Transaction View   | Filterable, sortable table of parsed transactions                                                       | P0       | Done   |
| RAG Chat           | Session-based chat with SSE streaming, adaptive query decomposition, tool calling (vector search + SQL) | P0       | Done   |
| Markdown Rendering | Chat responses rendered as Markdown with proper formatting                                              | P0       | Done   |
| Settings           | Currency selector persisted in localStorage, formats amounts in chat                                    | P1       | Done   |

### Analytics (M7)

| Feature             | Description                                  | Priority |
| ------------------- | -------------------------------------------- | -------- |
| Spending Summary    | Total in/out, top categories, savings rate   | P0       |
| Category Breakdown  | Pie/bar chart of spending by category        | P0       |
| Monthly Trends      | Month-over-month line chart                  | P0       |
| Daily Heatmap       | Calendar heatmap of daily spending           | P1       |
| Recurring Detection | Identify subscriptions and recurring charges | P1       |
| Category Drill-Down | Click a category to see its transactions     | P1       |

### Polish (M8)

| Feature          | Description                              | Priority |
| ---------------- | ---------------------------------------- | -------- |
| Authentication   | JWT-based login/register                 | P2       |
| Category Editing | Fix AI-assigned categories manually      | P2       |
| Error Handling   | Consistent error states across all pages | P2       |

---

## 4. User Flows

### 4.1 Upload Flow

```mermaid
flowchart TD
    A[User opens Ledger] --> B[Drag & drop PDF/CSV]
    B --> C[Show spinner]
    C --> D{File type?}
    D -->|PDF| E[PDF Parser]
    D -->|CSV| F[CSV Parser]
    E --> G[Extract transactions]
    F --> G
    G --> H[Chunk text ~500 tokens]
    H --> I[Embed via Ollama]
    I --> J[Store in PostgreSQL + pgvector]
    J --> K[Redirect to transactions view]

    style A fill:#e8f4f8
    style K fill:#d4edda
```

### 4.2 Chat Flow

```mermaid
sequenceDiagram
    participant U as User
    participant FE as Angular Frontend
    participant BE as NestJS Backend
    participant PG as PostgreSQL + pgvector
    participant AI as Groq LLM

    U->>FE: "How much did I spend on food?"
    FE->>BE: POST /chat/sessions/:id/messages { content }
    Note over FE,BE: SSE stream opens

    BE->>AI: decompose_query (break compound question into sub-queries with intent tags)
    AI-->>BE: Sub-queries with tags: sql_aggregate | sql_filter | vector_search | hybrid

    loop Tool-calling loop (max 3 steps, guided by intent tags)
        BE->>AI: Chat completion with tool definitions
        AI-->>BE: tool_call: vector_search OR sql_query

        alt vector_search
            BE->>AI: Embed query → vector
            AI-->>BE: Query embedding
            BE->>PG: Cosine similarity search (top 5 chunks)
            PG-->>BE: Relevant transaction chunks
        else sql_query
            BE->>PG: Read-only SQL against transactions table
            PG-->>BE: Query results
        end

        BE->>AI: Tool result appended to context
    end

    AI-->>BE: Final text response (streamed)
    BE-->>FE: SSE tokens streamed in real time
    BE->>PG: Persist assistant message to session history
    FE-->>U: Markdown-rendered answer with live token display
```

### 4.3 Dashboard Flow

```mermaid
flowchart TD
    A[User opens Dashboard] --> B[Fetch analytics endpoints]
    B --> C[/analytics/summary]
    B --> D[/analytics/categories]
    B --> E[/analytics/monthly]
    B --> F[/analytics/daily]

    C --> G[Stat Cards<br/>Total Spent · Income · Savings Rate]
    D --> H[Category Breakdown<br/>Pie Chart + Bar Chart]
    E --> I[Monthly Trends<br/>Line Chart]
    F --> J[Daily Heatmap<br/>Calendar View]

    G --> K[Dashboard Page]
    H --> K
    I --> K
    J --> K

    style K fill:#d4edda
```

---

## 5. Chat Examples

| User Query                                                                | Type     | Expected Behavior                                                       |
| ------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| "How much did I spend on food in January?"                                | Spending | Sum food transactions, cite specific ones                               |
| "What's my biggest expense this month?"                                   | Spending | Find max transaction, provide context                                   |
| "Am I spending more on Swiggy than last month?"                           | Pattern  | Compare across statement periods                                        |
| "What subscriptions am I paying for?"                                     | Pattern  | Identify recurring charges                                              |
| "What was that 12,000 charge last week?"                                  | Anomaly  | Find and explain specific transaction                                   |
| "Flag any unusual transactions"                                           | Anomaly  | Identify outliers from spending patterns                                |
| "How much did I spend on groceries vs dining, AND find any Uber charges?" | Compound | Decomposed into separate sub-queries; each answered with the right tool |

---

## 6. Milestone Roadmap

| Milestone | Name              | Status   | Key Deliverables                                                             |
| --------- | ----------------- | -------- | ---------------------------------------------------------------------------- |
| M0        | Monorepo Scaffold | Complete | pnpm workspace, NestJS + Angular, Docker Compose for PostgreSQL              |
| M1        | Health Check      | Complete | `/health` endpoint, CI pipeline, basic connectivity                          |
| M2        | File Upload       | Complete | Drag-and-drop upload, statement entity, file storage                         |
| M3        | Parse & Persist   | Complete | PDF/CSV parsers (strategy pattern), transactions table, AI categories        |
| M4        | Chunk & Embed     | Complete | Text chunking (~500 tokens), Ollama embeddings, pgvector storage             |
| M5        | RAG Chat          | Complete | Session-based chat, SSE streaming, vector_search + sql_query tools, settings |
| M6        | Groq ZDR + Ollama | Planned  | Migrate to Groq (ZDR) for chat, Ollama for local embeddings                  |
| M7        | Full Dashboard    | Planned  | Spending summary, category breakdown, monthly trends, daily heatmap          |
| M8        | Auth & Polish     | Planned  | JWT auth, category editing, error handling                                   |

```mermaid
gantt
    title Ledger Development Milestones
    dateFormat YYYY-MM-DD
    axisFormat %b %d

    section Foundation
        M0 - Monorepo Scaffold       :done, m0, 2026-03-03, 1d
        M1 - Health Check             :done, m1, after m0, 1d

    section Core Pipeline
        M2 - File Upload              :done, m2, after m1, 2d
        M3 - Parse & Persist          :done, m3, after m2, 3d
        M4 - Chunk & Embed            :done, m4, after m3, 2d

    section Features
        M5 - RAG Chat                 :done, m5, after m4, 3d
        M6 - Groq ZDR + Ollama        :m6, after m5, 2d

    section Dashboard
        M7 - Full Dashboard           :m7, after m6, 3d

    section Polish
        M8 - Auth & Polish            :m8, after m7, 2d
```

---

## 7. Tech Stack

| Layer           | Technology                               | Purpose                                                            |
| --------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| Frontend        | Angular 19 (TypeScript)                  | SPA with components, services, routing                             |
| Backend         | NestJS (TypeScript)                      | REST API with modules, DI, decorators                              |
| Database        | PostgreSQL + pgvector                    | Transactions + vector similarity search                            |
| AI              | Groq + Ollama                            | LLM (llama-3.3-70b-versatile via Groq) + Embeddings (nomic-embed-text via Ollama) |
| AI SDK          | Vercel AI SDK (`ai` + `@ai-sdk/groq`)    | Streaming chat completions, tool-calling loop, SSE transport       |
| File Parsing    | pdf-parse, csv-parse                     | Extract text from bank statements                                  |
| Markdown        | marked                                   | Render AI chat responses as formatted Markdown (via MarkdownPipe)  |
| Testing         | Vitest + @vitest/coverage-v8             | Unit/integration tests with V8 coverage (302 tests, 95%+ coverage) |
| Charts          | Chart.js / ngx-charts (planned M7)       | Dashboard visualizations                                           |
| Package Manager | pnpm                                     | Fast installs, strict dependency resolution                        |
| Deployment      | Docker Compose (local)                   | PostgreSQL + pgvector container                                    |

---

## 8. Constraints & Decisions

| Decision          | Choice                         | Rationale                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat architecture | Tool-calling with three tools  | Every user message is first passed to `decompose_query`, which breaks compound questions into structured sub-queries tagged with intent (`sql_aggregate`, `sql_filter`, `vector_search`, `hybrid`). The agent then uses those tags to guide tool selection between `vector_search` (semantic) and `sql_query` (aggregation). Up to 3 tool calls per turn. Falls back to `hybrid` intent if decomposition fails. |
| Streaming         | SSE via Vercel AI SDK          | Real-time token display gives responsive UX. SSE is simpler than WebSockets for unidirectional streaming.                                                                                                                                                                                                                                                                                                       |
| Chat sessions     | Persistent session history     | Each chat session stores messages in PostgreSQL. Enables multi-turn context and conversation continuity.                                                                                                                                                                                                                                                                                                        |
| Currency settings | localStorage + chat formatting | User picks currency once in settings; amounts in chat responses are formatted accordingly. No backend change needed.                                                                                                                                                                                                                                                                                            |
| Upload UX         | Fire and forget                | MVP simplicity. No progress steps or background processing.                                                                                                                                                                                                                                                                                                                                                     |
| Auth timing       | Deferred to M8                 | No login friction during development. Single-user local app doesn't need auth early.                                                                                                                                                                                                                                                                                                                            |
| Parser design     | Strategy pattern               | Bank PDF formats vary across institutions. Each bank gets its own parser. Start with one, add more.                                                                                                                                                                                                                                                                                                             |
| Deployment        | Local Docker Compose           | No cloud until product is solid.                                                                                                                                                                                                                                                                                                                                                                                |
| Database          | PostgreSQL + pgvector          | Single DB for both structured data and vector search. No separate vector DB needed.                                                                                                                                                                                                                                                                                                                             |
