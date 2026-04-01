# M5: RAG Chat with Tool Calling

> **Note**: As of M6, the LLM provider was migrated from Mistral to Groq (`llama-3.3-70b-versatile`), and embeddings from Mistral Embed to Ollama (`nomic-embed-text`). `MistralService` was renamed to `LlmService`. See ADR-003 update for details.

**Status**: Draft
**Date**: 2026-03-06
**Milestone**: M5 — RAG Chat

---

## Context

Ledger has bank statement text chunked and embedded in pgvector (M4). M5 adds a conversational chat interface where users ask questions about their finances. The LLM uses tool calling to retrieve relevant context — either via vector similarity search or direct SQL queries against the transactions table.

Key constraints:

- `EmbeddingsService` already exposes `similaritySearch()` and `getQueryEmbedding()` for pgvector lookups
- `MistralService` already wraps `@mistralai/mistralai` for categorization and embedding
- The Vercel AI SDK (`ai` + `@ai-sdk/mistral`) provides a framework-agnostic streaming + tool-calling loop
- Chat must feel responsive — token-by-token streaming via SSE, not request-response
- Single-user app — no auth, no multi-tenancy concerns for chat sessions

---

## Decisions

### 1. Session-Based Chat Threads

**Choice**: Two new tables — `chat_sessions` and `chat_messages` — with a one-to-many relationship.

```
chat_sessions:
- id: UUID (PK)
- title: VARCHAR(255) (auto-generated from first message, editable)
- created_at: TIMESTAMPTZ
- updated_at: TIMESTAMPTZ

chat_messages:
- id: UUID (PK)
- session_id: UUID (FK -> chat_sessions, CASCADE delete)
- role: VARCHAR(20) ('user' | 'assistant')
- content: TEXT
- sources: JSONB (nullable — tool results / citations for assistant messages)
- created_at: TIMESTAMPTZ
```

**Why sessions over flat history**: Users will ask different questions at different times — "what did I spend on groceries last month?" vs. "explain this large transaction." Separate sessions keep context coherent and allow the LLM to use conversation history within a session without cross-contamination.

**Session lifecycle**: Created on first message if no `sessionId` is provided. Title auto-generated from the first user message (truncated to 100 chars). Deletable via API.

### 2. SSE Streaming

**Choice**: Server-Sent Events for real-time token delivery.

The `POST /chat` endpoint returns `Content-Type: text/event-stream`. Each SSE event carries a text delta or a metadata payload (sources, session ID).

**Event format**:

```
event: text-delta
data: {"delta": "Based on"}

event: text-delta
data: {"delta": " your transactions,"}

event: sources
data: {"sources": [{"content": "...", "statementId": "...", "distance": 0.12}]}

event: done
data: {"sessionId": "uuid", "messageId": "uuid"}
```

**Why SSE over WebSocket**: Unidirectional (server-to-client) is all we need. SSE is simpler — no connection upgrade, no ping/pong, works through proxies. The client sends new messages via regular POST requests.

### 3. Vercel AI SDK for Tool-Calling Loop

**Choice**: Use `ai` and `@ai-sdk/mistral` packages for the streaming + tool-calling orchestration.

**Why**: The Vercel AI SDK handles the tool-calling loop automatically — when the LLM responds with a tool call, the SDK executes the tool, feeds the result back, and continues generation. This avoids manually implementing the multi-turn tool loop. The `streamText()` function returns an async iterable of text deltas that map directly to SSE events.

**Configuration**:

```typescript
streamText({
  model: mistral('mistral-large-latest'),
  system: SYSTEM_PROMPT,
  messages: conversationHistory,
  tools: { vector_search, sql_query },
  maxSteps: 3,
});
```

`maxSteps: 3` allows the LLM to call tools and reason over results without runaway loops.

### 4. Two Tools via Mistral Function Calling

#### `vector_search`

Embeds the query string via `mistral-embed`, then runs cosine similarity search against the `embeddings` table. Returns the top-5 chunks with content, statement ID, and distance score.

```typescript
vector_search: tool({
  description: 'Search bank statement text by semantic similarity',
  parameters: z.object({
    query: z.string().describe('The search query'),
  }),
  execute: async ({ query }) => {
    const vector = await embeddingsService.getQueryEmbedding(query);
    if (!vector) return { results: [] };
    return embeddingsService.similaritySearch(vector, 5);
  },
});
```

**Use case**: Contextual questions — "what was that large payment to ACME Corp?", "show me transactions from my January statement."

#### `sql_query`

The LLM generates a SQL query. The backend validates it for safety, executes it, and returns tabular results.

```typescript
sql_query: tool({
  description: 'Query the transactions database. Use for aggregations, counts, sums, date ranges.',
  parameters: z.object({
    query: z.string().describe('A read-only SELECT query against the transactions table'),
  }),
  execute: async ({ query }) => {
    validateSqlSafety(query);
    return dataSource.query(query);
  },
});
```

**Use case**: Analytical questions — "how much did I spend on dining in February?", "what are my top 5 expense categories?"

**SQL safety rules** (see section below).

### 5. MistralService Gets `chatStream()`

**Choice**: Add a `chatStream()` method to the existing `MistralService` rather than creating a separate AI service.

This centralizes all Mistral SDK usage in one place. The method accepts a system prompt, message history, and tool definitions, and returns the `streamText()` result from the Vercel AI SDK.

```typescript
// mistral.service.ts
async chatStream(options: {
  system: string;
  messages: CoreMessage[];
  tools: Record<string, CoreTool>;
  maxSteps?: number;
}) {
  return streamText({
    model: mistral('mistral-large-latest'),
    ...options,
  });
}
```

**Alternative considered**: A standalone `AiService` wrapping the Vercel AI SDK. Rejected because `MistralService` already owns the Mistral client setup and API key validation. Adding chat alongside categorize and embed keeps the surface area small.

---

## Architecture

### Backend Module Structure

```
backend/src/rag/
├── rag.module.ts
├── rag.controller.ts
├── rag.service.ts
├── sql-safety.ts
├── prompts.ts
├── dto/
│   ├── chat-request.dto.ts
│   └── chat-message.dto.ts
└── entities/
    ├── chat-session.entity.ts
    └── chat-message.entity.ts
```

**`RagModule`** imports `EmbeddingsModule` (for `similaritySearch`, `getQueryEmbedding`) and `MistralModule` (for `chatStream`). Registers `ChatSession` and `ChatMessage` entities.

**`RagController`** — API endpoints:

| Method | Endpoint                      | Description                      |
| ------ | ----------------------------- | -------------------------------- |
| POST   | `/chat`                       | Send message, receive SSE stream |
| GET    | `/chat/sessions`              | List all chat sessions           |
| GET    | `/chat/sessions/:id/messages` | Get messages for a session       |
| DELETE | `/chat/sessions/:id`          | Delete session + messages        |

**`RagService`** — orchestration:

1. Resolve or create `ChatSession`
2. Save user message to `chat_messages`
3. Load conversation history for the session
4. Build system prompt + tool definitions
5. Call `MistralService.chatStream()` with history and tools
6. Stream text deltas to the client via SSE
7. On stream completion: save assistant message + sources to `chat_messages`

### Frontend Structure

```
frontend/src/app/features/chat/
├── chat.component.ts
├── chat.component.html
├── chat.component.scss
├── chat.service.ts
├── message-bubble/
│   ├── message-bubble.component.ts
│   ├── message-bubble.component.html
│   └── message-bubble.component.scss
└── source-card/
    ├── source-card.component.ts
    ├── source-card.component.html
    └── source-card.component.scss
```

**`ChatComponent`**: Split layout — session sidebar on the left, message area on the right. Input bar at the bottom. Session list loads on init via `GET /chat/sessions`.

**`ChatService`**: Regular `HttpClient` for REST calls (list sessions, delete session). For streaming, uses `EventSource` or `fetch()` with `ReadableStream` to consume SSE from `POST /chat`.

**`MessageBubbleComponent`**: Renders user and assistant messages with distinct styling. Assistant messages may include a `sources` array rendered as `SourceCardComponent` instances below the message text.

**`SourceCardComponent`**: Displays a cited chunk — shows a snippet of the source text and the statement it came from.

### Database Migration

New TypeORM migration: `CreateChatTables`.

```sql
CREATE TABLE chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  sources JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);
```

Follows the same migration pattern from ADR-003 — explicit SQL, `migrationsRun: true`, no `synchronize`.

---

## RAG Prompt Template

```
SYSTEM: You are a financial assistant analyzing the user's bank statements.
You have access to two tools:
- vector_search: Search statement text chunks by semantic similarity
- sql_query: Query the transactions database for aggregations and lookups
Use the appropriate tool based on the question. For calculations/aggregations, prefer sql_query.
For contextual questions about specific transactions, prefer vector_search.
Always cite your sources.

USER: {question}
```

The system prompt is static. Conversation history is loaded from `chat_messages` for the active session and appended as prior user/assistant message pairs.

---

## SSE Flow

```
Client                          Server
  |                               |
  |  POST /chat                   |
  |  { sessionId?, message }      |
  |------------------------------>|
  |                               |  1. Create session if needed
  |                               |  2. Save user message
  |                               |  3. Load conversation history
  |                               |  4. Build prompt + tools
  |                               |  5. streamText(model, messages, tools, maxSteps: 3)
  |                               |
  |  event: text-delta            |
  |  data: {"delta": "Based"}     |
  |<------------------------------|  6. Stream tokens
  |  event: text-delta            |
  |  data: {"delta": " on your"}  |
  |<------------------------------|
  |  ...                          |
  |  event: sources               |
  |  data: {"sources": [...]}     |
  |<------------------------------|  7. Send tool results as sources
  |  event: done                  |
  |  data: {"sessionId", "msgId"} |
  |<------------------------------|  8. Save assistant message + sources
  |                               |
```

The tool-calling loop happens server-side within `streamText()`. The client only sees text deltas and final metadata — tool invocations are transparent to the frontend.

---

## SQL Safety

The `sql_query` tool accepts LLM-generated SQL. The `validateSqlSafety()` function enforces:

1. **Only SELECT**: Reject any statement starting with INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, GRANT, REVOKE
2. **Only transactions table**: Parse the query and verify the only table referenced is `transactions` (reject joins to other tables, subqueries against other tables)
3. **No semicolons**: Prevent multi-statement injection
4. **Row limit**: Append `LIMIT 100` if no LIMIT clause is present
5. **Read-only connection**: Execute via a read-only database role or `SET TRANSACTION READ ONLY` as defense-in-depth

```typescript
function validateSqlSafety(query: string): void {
  const normalized = query.trim().toLowerCase();

  if (!normalized.startsWith('select')) {
    throw new BadRequestException('Only SELECT queries are allowed');
  }

  if (normalized.includes(';')) {
    throw new BadRequestException('Multi-statement queries are not allowed');
  }

  const forbidden = [
    'insert',
    'update',
    'delete',
    'drop',
    'alter',
    'create',
    'truncate',
    'grant',
    'revoke',
  ];
  for (const keyword of forbidden) {
    if (normalized.includes(keyword)) {
      throw new BadRequestException(`Forbidden SQL keyword: ${keyword}`);
    }
  }

  // Verify only transactions table is referenced
  const tablePattern = /\bfrom\s+(\w+)/gi;
  let match;
  while ((match = tablePattern.exec(query)) !== null) {
    if (match[1]?.toLowerCase() !== 'transactions') {
      throw new BadRequestException(`Access to table "${match[1]}" is not allowed`);
    }
  }
}
```

**Limitation**: This is heuristic-based, not a full SQL parser. Sufficient for a single-user local app. For production multi-tenant use, a proper SQL parser or query builder would be needed.

---

## New Dependencies

| Package           | Purpose                                   |
| ----------------- | ----------------------------------------- |
| `ai`              | Vercel AI SDK core — `streamText`, `tool` |
| `@ai-sdk/mistral` | Mistral provider for Vercel AI SDK        |
| `zod`             | Schema validation for tool parameters     |

`zod` may already be a transitive dependency. `ai` and `@ai-sdk/mistral` are the only new additions.

---

## Linear Issues

| Issue | Scope                                 | Dependencies |
| ----- | ------------------------------------- | ------------ |
| AI-66 | Database migration (chat tables)      | None         |
| AI-67 | Vercel AI SDK integration             | AI-66        |
| AI-68 | RAG tools (vector_search + sql_query) | AI-67        |
| AI-69 | RagModule controller + service        | AI-68        |
| AI-70 | Angular chat UI                       | AI-69        |
| AI-71 | Tests                                 | AI-69, AI-70 |

Suggested order: AI-66 -> AI-67 -> AI-68 -> AI-69 -> AI-70 -> AI-71. AI-70 can start in parallel with AI-69 using a mock SSE endpoint.

---

## Consequences

**Positive**:

- Reuses existing `EmbeddingsService` and `MistralService` — minimal new infrastructure
- Vercel AI SDK handles the tool-calling loop — no manual multi-turn orchestration
- SSE is simple and well-supported in Angular via `EventSource` or `fetch` streams
- Session-based threads keep conversation context clean and deletable
- SQL tool enables precise analytical queries that vector search alone cannot answer

**Negative**:

- SSE does not support request headers natively via `EventSource` — if auth is added later, the client will need to switch to `fetch`-based SSE consumption
- LLM-generated SQL is inherently unpredictable — safety validation is heuristic, not provably complete
- Two new tables add migration complexity

**Risks**:

- Mistral tool-calling reliability: The LLM may generate invalid SQL or choose the wrong tool. Mitigation: `maxSteps: 3` limits retries, and the assistant message includes error context for the user.
- Streaming error handling: If the LLM fails mid-stream, the client needs to handle partial messages gracefully. Mitigation: the `done` event signals successful completion; absence of it after a timeout indicates failure.
- Conversation history length: Long sessions may exceed the context window. Mitigation: truncate history to the most recent N messages (e.g., 20) when building the prompt.

---

## References

- [docs/adrs/adr-003-embedding-strategy.md](../adrs/adr-003-embedding-strategy.md) — Embedding pipeline and pgvector setup
- [docs/adrs/adr-002-parser-strategy.md](../adrs/adr-002-parser-strategy.md) — Parser strategy and idempotency patterns
- [Vercel AI SDK docs](https://sdk.vercel.ai/docs) — `streamText`, tool definitions, Mistral provider
- [Mistral function calling](https://docs.mistral.ai/capabilities/function_calling/) — Tool-calling capabilities
