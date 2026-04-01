<p align="center">
  <h1 align="center">Ledger</h1>
  <p align="center"><strong>Your financial ledger. Ask anything.</strong></p>
  <p align="center">Upload bank statements, auto-parse transactions, and chat with your financial data using AI.</p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-336%20passing-brightgreen" alt="Tests">
  <a href="https://codecov.io/gh/darth-dodo/ledger"><img src="https://codecov.io/gh/darth-dodo/ledger/branch/main/graph/badge.svg" alt="Codecov"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white" alt="NestJS">
  <img src="https://img.shields.io/badge/Angular-21-DD0031?logo=angular&logoColor=white" alt="Angular">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Groq-llama--3.3--70b-F55036" alt="Groq">
  <img src="https://img.shields.io/badge/Ollama-nomic--embed--text-1A1A2E" alt="Ollama">
  <img src="https://img.shields.io/badge/Vercel_AI_SDK-v6-000000?logo=vercel&logoColor=white" alt="Vercel AI SDK">
  <img src="https://img.shields.io/badge/ReAct-agent-8B5CF6" alt="ReAct Agent">
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS">
</p>

---

## The Problem

Bank statements sit in downloads folders as PDFs and CSVs. Understanding spending patterns means manual spreadsheet work. Searching for a specific transaction means scrolling through pages of data.

## How Ledger Solves It

1. **Upload** -- Drag and drop any bank statement (PDF or CSV)
2. **Parse** -- Transactions are automatically extracted and categorized by AI
3. **Embed** -- Statement content is chunked and vectorized for semantic search
4. **Ask** -- Chat with your financial data in natural language
5. **Visualize** -- See spending patterns on interactive dashboards _(coming soon)_

## Features

| Feature                      | Status             | Description                                            |
| ---------------------------- | ------------------ | ------------------------------------------------------ |
| Statement Upload             | :white_check_mark: | Drag-and-drop PDF/CSV with multi-bank support          |
| Transaction Parsing          | :white_check_mark: | Extensible parser strategy (PDF + CSV heuristics)      |
| AI Categorization            | :white_check_mark: | Groq-powered batch categorization of transactions      |
| Vector Embeddings            | :white_check_mark: | pgvector storage with cosine similarity search         |
| RAG Chat                     | :white_check_mark: | Natural language Q&A over your financial data          |
| Agentic ReAct Loop           | :white_check_mark: | Multi-step tool-calling agent (think → act → observe)  |
| Adaptive Query Decomposition | :white_check_mark: | LLM breaks compound questions into typed sub-queries   |
| Chart Data Tool              | :white_check_mark: | Agent generates chart-ready data (label/value columns) |
| Category Updates via Chat    | :white_check_mark: | Re-categorize transactions through conversation        |
| LLM Thinking Display         | :white_check_mark: | Transparent ReAct loop with live tool-call streaming   |
| Dashboard                    | :construction:     | Visual analytics and spending breakdowns               |
| Auth & Polish                | :construction:     | User accounts and production hardening                 |

## Screenshots

### Chat with Thinking Display

The agentic ReAct loop is fully transparent. While the LLM works, you see its thought process in a live-expanding accordion -- query decomposition, reasoning, SQL queries, and search results. The accordion auto-collapses when the final answer arrives.

| Thinking expanded                                   | Response with collapsed thinking       |
| --------------------------------------------------- | -------------------------------------- |
| ![Thinking expanded](m5-chat-thinking-expanded.png) | ![Chat response](m5-chat-response.png) |

## Architecture

```mermaid
graph TB
    subgraph Frontend ["Angular Frontend :4200"]
        UP[Upload Page]
        TX[Transactions View]
        CH[Chat Page]
    end

    subgraph Backend ["NestJS Backend :3000"]
        UC[Upload Controller]
        TC[Transactions Controller]
        RC[RAG Controller]
        HC[Health Controller]

        US[Upload Service]
        PS["Parsers (PDF + CSV)"]
        MS[LLM Service]
        CS[Chunker Service]
        ES[Embeddings Service]
        TS[Transactions Service]
        RS[RAG Service]
        AG["Agent Tools\n(think, decompose_query,\nsql_query, vector_search,\nupdate_category, chart_data, done)"]
    end

    subgraph Data ["PostgreSQL + pgvector"]
        ST[(statements)]
        TT[(transactions)]
        EM[(embeddings)]
        SS[(chat_sessions)]
        SM[(chat_messages)]
    end

    subgraph External ["AI Services"]
        CAT[Categorize]
        EMB["Embed (Ollama)"]
        LLM["Groq\nllama-3.3-70b-versatile"]
    end

    UP -->|POST /upload| UC
    TX -->|GET /transactions| TC
    CH -->|POST /chat SSE| RC

    UC --> US --> PS --> MS --> CAT
    US --> CS --> ES --> EMB
    US --> ST
    US --> TT
    ES --> EM
    TC --> TS --> TT
    RC --> RS --> MS --> LLM
    RS --> AG --> TT
    RS --> AG --> EM
    RS --> SS
    RS --> SM

    style Frontend fill:#e8f4f8
    style Backend fill:#fff3cd
    style Data fill:#d4edda
    style External fill:#f8d7da
```

## Quick Start

```bash
# Clone and install
git clone git@github.com:darth-dodo/ledger.git
cd ledger && pnpm install

# Start PostgreSQL (with pgvector)
docker compose up -d

# Configure environment
cp backend/.env.example backend/.env
# Add your GROQ_API_KEY and OLLAMA_BASE_URL to backend/.env

# Start backend (port 3000)
cd backend && pnpm dev

# Start frontend (port 4200)
cd frontend && pnpm dev
```

## Development

```bash
# Run all tests (336 tests)
make test

# Run with coverage
make test-coverage                     # Backend + frontend coverage

# Individual test suites
cd backend && pnpm test                # 278 backend tests
cd frontend && pnpm test               # 58 frontend tests (with coverage)

# Type check
cd backend && pnpm build

# Database migrations
cd backend && pnpm migrate             # Run pending migrations
cd backend && pnpm migration:revert    # Revert last migration
```

### Coverage

| Module   | Statements | Branches | Functions | Lines |
| -------- | ---------- | -------- | --------- | ----- |
| Backend  | 96%        | 91%      | 100%      | 96%   |
| Frontend | 94%        | 93%      | 85%       | 96%   |

Coverage is enforced in CI and thresholds are set at 85% for the backend (`backend/vitest.config.ts`).

## Tech Stack

| Layer    | Technology                          | Purpose                                           |
| -------- | ----------------------------------- | ------------------------------------------------- |
| Frontend | Angular 21, Tailwind CSS 4, daisyUI | SPA with standalone components                    |
| Backend  | NestJS 11, TypeORM                  | REST API with dependency injection                |
| Database | PostgreSQL + pgvector               | Relational data + vector embeddings               |
| AI       | Groq + Ollama + Vercel AI SDK       | Categorization, embeddings, ReAct agent streaming |
| Testing  | Vitest                              | Unit + integration tests (336 total)              |
| Runtime  | tsx, pnpm                           | TypeScript execution, package management          |

## Project Structure

```
ledger/
├── backend/                # NestJS API (port 3000)
│   └── src/
│       ├── upload/         # POST /upload, GET/DELETE /statements
│       ├── transactions/   # GET /transactions, PATCH /transactions/:id
│       ├── embeddings/     # Chunking + vector embedding pipeline
│       ├── llm/            # LLM service (categorize + chatStream via Groq)
│       ├── rag/            # Chat sessions, ReAct agent, 7 agent tools
│       ├── health/         # GET /health
│       └── db/             # Migrations and data source config
├── frontend/               # Angular SPA (port 4200)
│   └── src/app/
│       ├── core/           # Services (ApiService)
│       ├── shared/         # Reusable components (FileDropzone)
│       └── features/       # Page components (Upload, Chat, Settings)
├── docs/
│   ├── product.md          # Product spec
│   ├── architecture.md     # System design
│   ├── adrs/               # Architecture decision records
│   └── milestones/         # Milestone docs and retros
└── docker-compose.yml      # PostgreSQL + pgvector
```

## Documentation

- [Product Spec](docs/product.md) -- Vision, features, and user stories
- [Architecture](docs/architecture.md) -- System design and data flow
- [ADR-001: Upload Strategy](docs/adrs/adr-001-upload-strategy.md) -- File handling decisions
- [ADR-002: Parser Strategy](docs/adrs/adr-002-parser-strategy.md) -- Multi-format parsing design
- [ADR-003: Embedding Strategy](docs/adrs/adr-003-embedding-strategy.md) -- RAG vector storage decisions
- [ADR-004: LLM Thinking Display](docs/adrs/adr-004-llm-thinking-display.md) -- Transparent ReAct loop via SSE
- [Adaptive Query Decomposition Design](docs/plans/2026-03-14-adaptive-query-decomposition-design.md) -- ReAct agent + decomposition design
- [Changelog](CHANGELOG.md)
