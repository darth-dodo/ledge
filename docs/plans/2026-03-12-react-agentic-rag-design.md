# ReAct Agentic RAG Design

> **Note**: As of M6, the LLM provider was migrated from Mistral to Groq (`llama-3.3-70b-versatile`), and embeddings from Mistral Embed to Ollama (`nomic-embed-text`). `MistralService` was renamed to `LlmService`. See [ADR-005](../adrs/adr-005-groq-ollama-migration.md) for details.

**Date**: 2026-03-12
**Status**: Approved
**Branch**: feat/m5-rag-chat

## Problem

The current RAG chat is a simple tool-selector: the LLM picks one of two tools (`vector_search`, `sql_query`), calls it once or twice, and responds. It lacks:

- **Structured reasoning** — no visible thought process before acting
- **Self-correction** — if a query returns empty/wrong results, the agent doesn't retry with a different approach
- **Rich capabilities** — users can't re-categorize transactions or get chart-ready data through chat
- **Intelligent termination** — the agent stops after a fixed step count (3), not when it's actually done

## Solution: Tool-Structured ReAct

Use the Vercel AI SDK's native multi-step agent loop with explicit `think` and `done` tools to enforce ReAct (Reason-Act-Observe) behavior. Add `update_category` and `chart_data` tools for richer capabilities.

## Architecture

```
User Question
    |
System Prompt (ReAct instructions)
    |
+--- Agent Loop (stopWhen: hasToolCall('done') OR stepCountIs(10)) ---+
|                                                                      |
|  Step N: LLM chooses one of:                                         |
|    think          - structured reasoning (no-op, returns thought)    |
|    sql_query      - SQL against transactions table                   |
|    vector_search  - semantic search over statement chunks            |
|    update_category - re-categorize a transaction                     |
|    chart_data     - generate chart-ready structured data             |
|    done           - signal completion (triggers stop condition)      |
|                                                                      |
+----------------------------------------------------------------------+
```

### Agent Loop Control

- `stopWhen: [hasToolCall('done'), stepCountIs(10)]` — stops when agent calls `done` OR after 10 steps max
- `onStepFinish` callback logs each step for observability

## New Tools

### `think` (reasoning, no-op)

Forces the LLM to write structured reasoning as a tool call, making the thought process visible and auditable.

```typescript
// Input:  { thought: string }
// Output: { thought: string } (echo back)
```

### `done` (control flow)

Signals the agent is satisfied. Triggers `hasToolCall('done')` stop condition.

```typescript
// Input:  { summary: string }
// Output: { summary: string }
```

### `update_category` (action)

Lets the agent re-categorize transactions when users ask ("mark that Uber charge as business").

```typescript
// Input:  { transactionId: string, newCategory: string }
// Output: { success: boolean, transactionId, oldCategory, newCategory }
```

Validation:

- Category must be from allowed list (groceries, dining, transport, etc.)
- Transaction must exist
- Returns old + new category for confirmation in response

### `chart_data` (data)

Generates structured data the frontend can render as charts.

```typescript
// Input:  { type: 'pie' | 'bar' | 'line', title: string, sql: string }
// Output: { chartType, title, labels: string[], values: number[] }
```

Reuses the same SQL validation from `sql_query` tool.

## System Prompt

Rewritten to enforce ReAct loop:

```
You are an agentic financial assistant. Follow this reasoning loop:

1. THINK: Always call `think` first to plan your approach
2. ACT: Call the appropriate tool (sql_query, vector_search, update_category, chart_data)
3. OBSERVE: Review tool results
4. REPEAT: If results are unexpected, think about why and try differently
5. DONE: Call `done` when you have a complete answer

Self-correction rules:
- If SQL returns 0 rows, try vector_search or a different SQL pattern
- If vector_search is vague, extract specific terms and use SQL
- Always verify amounts make sense before responding
```

## Changes to Existing Code

### `mistral.service.ts`

- Replace `maxSteps` param with `stopWhen` (accepting SDK stop conditions directly)
- Add optional `onStepFinish` callback param

### `rag.service.ts`

- Build all 6 tools in the tools object
- Pass `stopWhen: [hasToolCall('done'), stepCountIs(10)]`
- Wire `onStepFinish` for structured logging
- Increase conversation history from 10 to 20 messages (agent uses more context)

### New Files

- `backend/src/rag/tools/think.tool.ts`
- `backend/src/rag/tools/done.tool.ts`
- `backend/src/rag/tools/update-category.tool.ts`
- `backend/src/rag/tools/chart-data.tool.ts`

### No Frontend Changes Required

The AI SDK's `pipeUIMessageStreamToResponse` streams tool calls natively. The frontend already handles SSE. Think/done tool calls will appear in the stream — the frontend can render or filter them in a future iteration.

## Example Flows

### Multi-step self-correction

```
User: "How much did I spend on Uber this month?"
  think: "Search for Uber transactions using SQL ILIKE"
  sql_query: SELECT ... WHERE description ILIKE '%uber%' -> 0 rows
  think: "No results. Description might be different. Try vector search."
  vector_search: "uber rides" -> finds "UBER *TRIP" entries
  think: "Found pattern 'UBER *TRIP'. Retry SQL with correct pattern."
  sql_query: SELECT SUM(amount) ... WHERE description ILIKE '%uber%trip%' -> $127.50
  done: "You spent $127.50 on Uber this month"
```

### Category update

```
User: "That Starbucks charge should be dining, not groceries"
  think: "Need to find the Starbucks transaction and update its category"
  sql_query: SELECT id, description, category FROM transactions WHERE description ILIKE '%starbucks%' ORDER BY date DESC LIMIT 5
  think: "Found it: id=abc-123, currently 'groceries'. User wants 'dining'."
  update_category: { transactionId: "abc-123", newCategory: "dining" }
  done: "Updated your Starbucks charge from groceries to dining"
```

### Chart generation

```
User: "Show me a breakdown of my spending by category"
  think: "User wants a pie chart of spending by category"
  chart_data: { type: "pie", title: "Spending by Category", sql: "SELECT category, SUM(amount) ... GROUP BY category" }
  done: "Here's your spending breakdown by category"
```

## Testing Strategy

- Unit tests for each new tool (think, done, update_category, chart_data)
- Update existing rag.service.spec.ts for new tool wiring and stopWhen config
- Update mistral.service.spec.ts for new chatStream signature
