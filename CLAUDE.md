Default to using Node.js with pnpm.

- Use `pnpm install` for installing dependencies
- Use `pnpm run <script>` or `pnpm <script>` to run scripts
- Use `tsx <file>` to run TypeScript files directly
- Use `vitest` for testing (`pnpm test` runs `vitest run`)
- Use `dotenv/config` to load .env files (import at entry point)

## Backend (NestJS)

- Runtime: Node.js with tsx for TypeScript execution
- Package manager: pnpm
- Test runner: vitest
- `pnpm dev` — start dev server with watch mode (tsx watch)
- `pnpm test` — run tests (vitest)
- `pnpm build` — type-check (tsc --noEmit)

## Frontend (Angular)

- Package manager: pnpm
- `pnpm dev` — start Angular dev server (ng serve)
- `pnpm build` — production build (ng build)
- `pnpm test` — run tests (ng test)

## M3 Modules (Parse & Persist)

### Transactions module (`backend/src/transactions/`)

- `GET /transactions` — list with filters (statementId, date range, category, amount range, type)
- `PATCH /transactions/:id` — update category or description
- Transactions are created automatically during upload (via parser pipeline)

### LLM module (`backend/src/llm/`)

- Uses `@ai-sdk/groq` with `generateText()` + `Output.object()` and Zod schema for structured output (AI SDK v6 pattern; `generateObject()` is deprecated)
- Provider configured with `structuredOutputs: false` because most Groq models don't support `json_schema` response format — falls back to `json_object` mode
- Batch-categorizes transaction descriptions via Groq (`qwen/qwen3-32b`)
- `GROQ_API_KEY` is optional in `.env` — app starts without it, LLM features (categorization, chat) are disabled
- Embeddings handled by `EmbeddingsService` using Ollama (`nomic-embed-text`, 768-dim); Ollama runs as a Docker Compose service

### Parser strategy (`backend/src/upload/parsers/`)

- `ParserInterface` with `canParse(buffer, filename)` and `parse(buffer)` methods
- `PdfParser` — extracts text via `pdf-parse`, heuristic transaction detection
- `CsvParser` — parses via `csv-parse`, heuristic column detection
- Parsers registered in `upload.module.ts` via `PARSERS` multi-provider token
- See `docs/adrs/adr-002-parser-strategy.md` for design decisions

## M5 Modules (RAG Chat)

### RAG module (`backend/src/rag/`)

- `POST /chat` — SSE streaming chat endpoint. Body: `{ sessionId?, message, currency? }`. Creates session if none provided. Streams response via Vercel AI SDK `pipeUIMessageStreamToResponse()`.
- `GET /chat/sessions` — list chat sessions
- `GET /chat/sessions/:id/messages` — get messages for a session
- `DELETE /chat/sessions/:id` — delete a session and its messages
- Tools: `decompose_query` (breaks the user message into sub-queries with intent tags, called first in every ReAct loop), `vector_search` (semantic similarity via pgvector embeddings), and `sql_query` (read-only SELECT against transactions table with safety validation)
- Uses Vercel AI SDK v6 (`ai` + `@ai-sdk/groq`) for streaming + tool-calling loops
- System prompt includes user's preferred currency for amount formatting

### Settings (`frontend/src/app/features/settings/`)

- `SettingsService` — persists currency preference in localStorage
- Currency sent with each chat request, threaded into LLM system prompt

### LLM service additions

- `chatStream()` method added alongside existing `categorize()` — uses `streamText()` via Groq with `stopWhen: stepCountIs(n)` for multi-step tool calling
- `decomposeQuery()` method — uses `generateText` + `Output.object` with a Zod schema to decompose a user message into `SubQuery[]` with intent tags; called by the `decompose_query` tool on every chat message
