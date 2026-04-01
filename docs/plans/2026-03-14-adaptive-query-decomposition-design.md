# Adaptive Query Decomposition — Design Document

> **Note**: As of M6, the LLM provider was migrated from Mistral to Groq (`llama-3.3-70b-versatile`), and embeddings from Mistral Embed to Ollama (`nomic-embed-text`). `MistralService` was renamed to `LlmService`. See [ADR-005](../adrs/adr-005-groq-ollama-migration.md) for details.

**Date**: 2026-03-14
**Status**: Approved
**Linear**: [AI-92](https://linear.app/ai-adventures/issue/AI-92)

## Problem

The ReAct agent loop receives the raw user message and must independently determine how to approach it. For compound questions like _"How much did I spend on groceries vs dining last month, and find any Uber charges?"_, the agent tends to handle sub-questions sequentially with unnecessary `think` iterations, or misses parts of the question entirely. There is no structured intent routing to guide which tools to apply to which parts.

## Solution

Add a `decompose_query` tool to the ReAct loop that fires on every message. It uses a dedicated `generateObject` call (non-streaming, no tools) to decompose the user's message into structured sub-queries, each tagged with a recommended tool intent. The agent uses these sub-queries as its work plan for the rest of the loop.

## Architecture

```
user message
     │
     ▼
ReAct loop starts
     │
     ▼
agent → decompose_query(message)
           │
           ▼  [generateObject call — Mistral, non-streaming]
           returns SubQuery[]
           [{ query: string, intent: "sql_aggregate" | "sql_filter" | "vector_search" | "hybrid" }]
     │
     ▼
agent works through each sub-query guided by intent tags
  sql_aggregate  →  sql_query
  sql_filter     →  sql_query
  vector_search  →  vector_search
  hybrid         →  sql_query + vector_search
     │
     ▼
agent → done(synthesized answer)
```

Simple queries return a single-element array — the only overhead is the extra LLM call.

## Components

### 1. `MistralService.decomposeQuery(message: string)` — AI-93

New method on the existing `MistralService`.

- Uses `generateObject` from the Vercel AI SDK (`ai` package)
- Output schema (Zod):
  ```ts
  z.object({
    subQueries: z.array(
      z.object({
        query: z.string(),
        intent: z.enum(['sql_aggregate', 'sql_filter', 'vector_search', 'hybrid']),
      }),
    ),
  });
  ```
- System prompt for the decomposition call:
  ```
  You are a query decomposition assistant for a financial transaction analysis system.
  Decompose the user's question into independent sub-queries.
  For each sub-query, classify the intent:
    - sql_aggregate: requires SUM, COUNT, AVG (e.g. "total spend on X", "how many times", "average amount")
    - sql_filter: requires filtering transactions (e.g. "find transactions at X", "show charges from Y")
    - vector_search: semantic/contextual search (e.g. "anything related to X", "charges that look like Y")
    - hybrid: needs both SQL aggregation and semantic search
  If the query is simple and doesn't need decomposition, return it as a single sub-query.
  ```
- Graceful fallback: if `generateObject` throws, return `[{ query: message, intent: 'hybrid' }]`

### 2. `decompose-query.tool.ts` — AI-94

New file at `backend/src/rag/tools/decompose-query.tool.ts`.

```ts
export function createDecomposeQueryTool(mistralService: MistralService) {
  return tool({
    description:
      'Decompose the user message into structured sub-queries with intent tags. Call this first on every message.',
    inputSchema: z.object({
      message: z.string().describe('The original user message to decompose'),
    }),
    execute: async ({ message }) => mistralService.decomposeQuery(message),
  });
}
```

### 3. `RagService` wiring + system prompt update — AI-95

**Tools map** (`rag.service.ts`):

```ts
decompose_query: createDecomposeQueryTool(this.mistralService),
```

**System prompt additions** (`buildSystemPrompt()`):

- Add `decompose_query` to the Available tools list with instruction: _"Always call this first. It breaks compound questions into sub-queries with intent tags."_
- Add intent-to-tool mapping guidance:
  ```
  After decompose_query, use intent tags to select tools:
  - sql_aggregate → sql_query (aggregations: SUM, COUNT, AVG)
  - sql_filter    → sql_query (filtering/listing transactions)
  - vector_search → vector_search (semantic/merchant search)
  - hybrid        → both sql_query and vector_search
  ```

### 4. Tests — AI-96

| File                           | Test                                                                      |
| ------------------------------ | ------------------------------------------------------------------------- |
| `mistral.service.spec.ts`      | `decomposeQuery()` returns single sub-query for simple message            |
| `mistral.service.spec.ts`      | `decomposeQuery()` returns multiple sub-queries for compound message      |
| `mistral.service.spec.ts`      | `decomposeQuery()` falls back to `[{ query, intent: 'hybrid' }]` on error |
| `decompose-query.tool.spec.ts` | Tool calls `decomposeQuery` with input message                            |
| `decompose-query.tool.spec.ts` | Tool returns correctly shaped `subQueries` array                          |
| `rag.service.spec.ts`          | `decompose_query` tool is present in tools map passed to `chatStream`     |

## Data Flow Example

```
user: "How much did I spend on groceries vs dining last month, and find any Uber charges?"

decompose_query →
  subQueries: [
    { query: "total groceries spend last month",  intent: "sql_aggregate" },
    { query: "total dining spend last month",     intent: "sql_aggregate" },
    { query: "Uber charges",                      intent: "vector_search"  }
  ]

agent → sql_query("SELECT SUM(amount)... WHERE category='groceries' AND date >= ...")
agent → sql_query("SELECT SUM(amount)... WHERE category='dining' AND date >= ...")
agent → vector_search("Uber")
agent → done("Groceries: €120, Dining: €85. Found 3 Uber charges totalling €47.")
```

## Trade-offs

| Concern                                | Impact                      | Mitigation                                                                          |
| -------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| Extra LLM call on every message        | +latency                    | `generateObject` is non-streaming and fast; fallback ensures no blocking failure    |
| Double API cost per request            | Higher Mistral spend        | Acceptable at current scale; revisit if cost becomes a concern                      |
| Decomposition quality depends on model | Sub-optimal splits possible | Fallback to `hybrid` intent keeps the agent functional even with poor decomposition |

## Files Changed

- `backend/src/mistral/mistral.service.ts`
- `backend/src/mistral/mistral.service.spec.ts`
- `backend/src/rag/tools/decompose-query.tool.ts` _(new)_
- `backend/src/rag/tools/decompose-query.tool.spec.ts` _(new)_
- `backend/src/rag/rag.service.ts`
- `backend/src/rag/rag.service.spec.ts`
