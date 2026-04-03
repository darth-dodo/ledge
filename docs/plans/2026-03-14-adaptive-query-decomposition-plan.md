# Adaptive Query Decomposition Implementation Plan

> **Note**: As of M6, the LLM provider was migrated from Mistral to Groq (`llama-3.3-70b-versatile`), and embeddings from Mistral Embed to Ollama (`nomic-embed-text`). `MistralService` was renamed to `LlmService`. See [ADR-005](../adrs/adr-005-groq-ollama-migration.md) for details.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `decompose_query` tool to the ReAct agent loop that uses `generateObject` to split every user message into structured sub-queries with intent tags, guiding the agent's tool selection.

**Architecture:** A new `MistralService.decomposeQuery()` method fires a focused `generateObject` call (non-streaming, no tools) returning `SubQuery[]`. A `createDecomposeQueryTool` wraps it as a Vercel AI SDK tool injected into the ReAct loop. The system prompt instructs the agent to call it first on every message.

**Tech Stack:** NestJS, Vercel AI SDK (`generateObject` from `ai`), `@ai-sdk/mistral`, Zod, Vitest

**Linear:** AI-92 (parent), AI-93, AI-94, AI-95, AI-96

---

### Task 1: Add `decomposeQuery()` to MistralService (AI-93)

**Files:**

- Modify: `backend/src/mistral/mistral.service.ts`

**Step 1: Add `generateObject` to the `ai` import**

In `mistral.service.ts`, line 4, add `generateObject` and `generateObject`'s return type to the imports:

```ts
import {
  streamText,
  generateObject,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
  type StopCondition,
} from 'ai';
```

**Step 2: Add the `decomposeQuery` method**

Add this after the `chatStream` method (after line 147, before the closing `}`):

```ts
async decomposeQuery(message: string): Promise<Array<{ query: string; intent: 'sql_aggregate' | 'sql_filter' | 'vector_search' | 'hybrid' }>> {
  if (!this.aiModel) {
    return [{ query: message, intent: 'hybrid' }];
  }

  const DECOMPOSE_SYSTEM = `You are a query decomposition assistant for a financial transaction analysis system.
Decompose the user's question into independent sub-queries. For each sub-query, classify the intent:
- sql_aggregate: requires SUM, COUNT, AVG (e.g. "total spend on X", "how many times", "average amount")
- sql_filter: requires filtering/listing transactions (e.g. "find transactions at X", "show charges from Y")
- vector_search: semantic/contextual search (e.g. "anything related to X", "charges that look like Y", merchant names)
- hybrid: needs both SQL aggregation and semantic search
If the query is simple and doesn't need decomposition, return it as a single sub-query.`;

  try {
    const { object } = await generateObject({
      model: this.aiModel,
      system: DECOMPOSE_SYSTEM,
      prompt: message,
      schema: z.object({
        subQueries: z.array(
          z.object({
            query: z.string(),
            intent: z.enum(['sql_aggregate', 'sql_filter', 'vector_search', 'hybrid']),
          }),
        ),
      }),
    });
    return object.subQueries;
  } catch (err) {
    this.logger.warn(
      `Query decomposition failed, falling back to hybrid: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [{ query: message, intent: 'hybrid' }];
  }
}
```

**Step 3: Add `zod` import**

`zod` is already a project dependency (used in all tools). Add it to the imports at the top of `mistral.service.ts`:

```ts
import { z } from 'zod';
```

**Step 4: Verify TypeScript compiles**

Run: `pnpm --filter backend build`
Expected: No type errors

**Step 5: Commit**

```bash
git add backend/src/mistral/mistral.service.ts
git commit -m "feat(rag): add MistralService.decomposeQuery() using generateObject"
```

---

### Task 2: Unit tests for `decomposeQuery()` (AI-96 part 1)

**Files:**

- Modify: `backend/src/mistral/mistral.service.spec.ts`

**Step 1: Add `mockGenerateObject` to the hoisted mock block**

The spec file has a `vi.hoisted` block at the top. Add `mockGenerateObject` to it:

```ts
const { mockChatComplete, mockStreamText, mockStepCountIs, mockCreateMistral, mockGenerateObject } =
  vi.hoisted(() => ({
    mockChatComplete: vi.fn(),
    mockStreamText: vi.fn(),
    mockStepCountIs: vi.fn(),
    mockCreateMistral: vi.fn(),
    mockGenerateObject: vi.fn(),
  }));
```

**Step 2: Add `generateObject` to the `ai` mock**

Find the `vi.mock('ai', ...)` block and add `generateObject`:

```ts
vi.mock('ai', () => ({
  streamText: mockStreamText,
  stepCountIs: mockStepCountIs,
  generateObject: mockGenerateObject,
}));
```

**Step 3: Write the failing tests**

Add a new `describe` block at the end of the test file:

```ts
describe('decomposeQuery', () => {
  let service: MistralService;

  beforeEach(() => {
    process.env.MISTRAL_API_KEY = 'test-key';
    service = new MistralService();
    mockGenerateObject.mockReset();
  });

  afterEach(() => {
    delete process.env.MISTRAL_API_KEY;
  });

  it('returns a single sub-query for a simple message', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        subQueries: [{ query: 'total spend last month', intent: 'sql_aggregate' }],
      },
    });

    const result = await service.decomposeQuery('How much did I spend last month?');

    expect(result).toEqual([{ query: 'total spend last month', intent: 'sql_aggregate' }]);
  });

  it('returns multiple sub-queries for a compound message', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        subQueries: [
          { query: 'total groceries last month', intent: 'sql_aggregate' },
          { query: 'total dining last month', intent: 'sql_aggregate' },
          { query: 'Uber charges', intent: 'vector_search' },
        ],
      },
    });

    const result = await service.decomposeQuery(
      'How much on groceries vs dining, and find Uber charges?',
    );

    expect(result).toHaveLength(3);
    expect(result[2].intent).toBe('vector_search');
  });

  it('falls back to hybrid intent when generateObject throws', async () => {
    mockGenerateObject.mockRejectedValue(new Error('API error'));

    const message = 'What are my biggest expenses?';
    const result = await service.decomposeQuery(message);

    expect(result).toEqual([{ query: message, intent: 'hybrid' }]);
  });

  it('returns hybrid fallback when API key is not set', async () => {
    delete process.env.MISTRAL_API_KEY;
    const noKeyService = new MistralService();

    const message = 'Show me my transactions';
    const result = await noKeyService.decomposeQuery(message);

    expect(result).toEqual([{ query: message, intent: 'hybrid' }]);
  });
});
```

**Step 4: Run tests to verify they fail**

Run: `pnpm --filter backend test mistral.service`
Expected: FAIL — `mockGenerateObject is not a function` or similar

**Step 5: Run tests again after Task 1 is complete**

Run: `pnpm --filter backend test mistral.service`
Expected: All `decomposeQuery` tests PASS

**Step 6: Commit**

```bash
git add backend/src/mistral/mistral.service.spec.ts
git commit -m "test(rag): add decomposeQuery unit tests"
```

---

### Task 3: Create `decompose-query.tool.ts` (AI-94)

**Files:**

- Create: `backend/src/rag/tools/decompose-query.tool.ts`

**Step 1: Write the failing test first**

Create `backend/src/rag/tools/decompose-query.tool.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('ai', () => ({
  tool: vi.fn((config) => config),
}));

import { createDecomposeQueryTool } from './decompose-query.tool';

describe('createDecomposeQueryTool', () => {
  const mockMistralService = {
    decomposeQuery: vi.fn(),
  };

  it('calls decomposeQuery with the input message', async () => {
    const subQueries = [{ query: 'total spend', intent: 'sql_aggregate' as const }];
    mockMistralService.decomposeQuery.mockResolvedValue(subQueries);

    const tool = createDecomposeQueryTool(mockMistralService as never);
    const result = await tool.execute({ message: 'How much did I spend?' }, {} as never);

    expect(mockMistralService.decomposeQuery).toHaveBeenCalledWith('How much did I spend?');
    expect(result).toEqual({ subQueries });
  });

  it('returns correctly shaped subQueries array', async () => {
    const subQueries = [
      { query: 'groceries total', intent: 'sql_aggregate' as const },
      { query: 'Uber charges', intent: 'vector_search' as const },
    ];
    mockMistralService.decomposeQuery.mockResolvedValue(subQueries);

    const tool = createDecomposeQueryTool(mockMistralService as never);
    const result = await tool.execute({ message: 'groceries and Uber?' }, {} as never);

    expect(result).toEqual({ subQueries });
    expect(result.subQueries).toHaveLength(2);
  });

  it('propagates errors from decomposeQuery', async () => {
    mockMistralService.decomposeQuery.mockRejectedValue(new Error('fail'));

    const tool = createDecomposeQueryTool(mockMistralService as never);

    await expect(tool.execute({ message: 'test' }, {} as never)).rejects.toThrow('fail');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter backend test decompose-query.tool`
Expected: FAIL — `Cannot find module './decompose-query.tool'`

**Step 3: Implement the tool**

Create `backend/src/rag/tools/decompose-query.tool.ts`:

```ts
import { tool } from 'ai';
import { z } from 'zod';
import type { MistralService } from '../../mistral/mistral.service';

export function createDecomposeQueryTool(mistralService: MistralService) {
  return tool({
    description:
      'Decompose the user message into structured sub-queries with intent tags. Call this first on every message to plan your approach.',
    inputSchema: z.object({
      message: z.string().describe('The original user message to decompose into sub-queries'),
    }),
    execute: async ({ message }: { message: string }) => {
      const subQueries = await mistralService.decomposeQuery(message);
      return { subQueries };
    },
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter backend test decompose-query.tool`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add backend/src/rag/tools/decompose-query.tool.ts backend/src/rag/tools/decompose-query.tool.spec.ts
git commit -m "feat(rag): add decompose_query tool with MistralService integration"
```

---

### Task 4: Wire tool into RagService + update system prompt (AI-95)

**Files:**

- Modify: `backend/src/rag/rag.service.ts`

**Step 1: Add the import**

Add at the top of `rag.service.ts` alongside the other tool imports (after line 15):

```ts
import { createDecomposeQueryTool } from './tools/decompose-query.tool';
```

**Step 2: Add tool to the tools map**

In `RagService.chat()`, the tools map starts at line 118. Add `decompose_query`:

```ts
const tools = {
  think: createThinkTool(),
  done: createDoneTool(),
  decompose_query: createDecomposeQueryTool(this.mistralService),
  vector_search: createVectorSearchTool(this.embeddingsService),
  sql_query: createSqlQueryTool(this.dataSource),
  update_category: createUpdateCategoryTool(this.dataSource),
  chart_data: createChartDataTool(this.dataSource),
};
```

**Step 3: Update the system prompt**

In `buildSystemPrompt()`, update the Available tools list and add the ReAct step for decomposition. Replace the existing tools section:

```ts
function buildSystemPrompt(currency: string): string {
  return `You are an agentic financial assistant analyzing the user's bank statements and transactions.

You follow a ReAct (Reason-Act-Observe) loop for every question:

1. DECOMPOSE: Always call \`decompose_query\` first with the user's message to break it into sub-queries with intent tags
2. THINK: Call the \`think\` tool to plan your approach for each sub-query
3. ACT: Call the appropriate tool(s) guided by the intent tags
4. OBSERVE: Review the results
5. REPEAT: If results are unexpected or incomplete, think again and try a different approach
6. DONE: Call the \`done\` tool when you have a complete answer for all sub-queries

Available tools:
- decompose_query: Break the user message into sub-queries with intent tags. ALWAYS call this first.
- think: Plan your approach before acting. Use after decompose_query.
- sql_query: Query the PostgreSQL transactions database. Best for calculations, aggregations, filtering.
- vector_search: Semantic search over bank statement text. Best for finding specific merchants or contextual questions.
- update_category: Re-categorize a transaction. Find the transaction ID with sql_query first.
- chart_data: Generate chart-ready data. Query MUST return "label" and "value" columns.
- done: Signal you have enough information to answer. Always call this last.

Intent tag guidance from decompose_query:
- sql_aggregate → use sql_query with SUM/COUNT/AVG
- sql_filter    → use sql_query with WHERE filters
- vector_search → use vector_search
- hybrid        → use both sql_query and vector_search

The transactions table schema (PostgreSQL):
  id            UUID PRIMARY KEY
  statement_id  UUID (foreign key to statements)
  date          DATE
  description   VARCHAR
  amount        NUMERIC(12,2)
  category      VARCHAR (groceries, dining, transport, utilities, entertainment, shopping, health, education, travel, income, transfer, other)
  type          VARCHAR ('debit' or 'credit')

IMPORTANT: Use PostgreSQL syntax, NOT SQLite.

Self-correction rules:
- If SQL returns 0 rows, try vector_search or a different ILIKE pattern
- If vector_search results are vague, extract specific terms and use SQL
- Always verify amounts and counts make sense before calling done
- For category updates, always confirm the transaction ID exists first

The user's preferred currency is ${currency}. Format all monetary amounts using ${currency}.
Always cite specific data in your response.
If the data doesn't contain the answer, say so honestly.`;
}
```

**Step 4: Verify TypeScript compiles**

Run: `pnpm --filter backend build`
Expected: No type errors

**Step 5: Commit**

```bash
git add backend/src/rag/rag.service.ts
git commit -m "feat(rag): wire decompose_query tool into ReAct loop and update system prompt"
```

---

### Task 5: Update RagService tests (AI-96 part 2)

**Files:**

- Modify: `backend/src/rag/rag.service.spec.ts`

**Step 1: Add mock for the new tool**

In `rag.service.spec.ts`, the vi.mock blocks start at line 14. Add:

```ts
vi.mock('./tools/decompose-query.tool', () => ({
  createDecomposeQueryTool: vi.fn(() => 'mockDecomposeQueryTool'),
}));
```

**Step 2: Add import for the new mock**

After the existing tool imports (around line 44), add:

```ts
import { createDecomposeQueryTool } from './tools/decompose-query.tool';
```

**Step 3: Add the test assertion**

Find the test that verifies the tools map is passed to `chatStream` (look for `createThinkTool` assertion) and add an assertion for `decompose_query`:

```ts
it('passes decompose_query tool to chatStream', async () => {
  // Arrange: set up session + message repos as in existing tests
  mockSessionRepo.findOne.mockResolvedValue(null);
  mockSessionRepo.save.mockResolvedValue({ id: 'new-session' });
  mockMessageRepo.save.mockResolvedValue({});
  mockMessageRepo.find.mockResolvedValue([]);
  mockMistralService.chatStream.mockReturnValue({
    text: Promise.resolve(''),
    steps: Promise.resolve([]),
  });

  await service.chat(null, 'How much did I spend?', 'EUR');

  const callArgs = mockMistralService.chatStream.mock.calls[0][0];
  expect(callArgs.tools).toHaveProperty('decompose_query', 'mockDecomposeQueryTool');
  expect(createDecomposeQueryTool).toHaveBeenCalledWith(mockMistralService);
});
```

**Step 4: Run all RAG tests**

Run: `pnpm --filter backend test rag`
Expected: All tests PASS

**Step 5: Run full test suite**

Run: `pnpm --filter backend test`
Expected: All tests PASS, no regressions

**Step 6: Commit**

```bash
git add backend/src/rag/rag.service.spec.ts
git commit -m "test(rag): add decompose_query tool wiring assertions to RagService spec"
```

---

### Task 6: Final verification

**Step 1: TypeScript check**

Run: `pnpm --filter backend build`
Expected: Zero errors

**Step 2: Full test run**

Run: `pnpm --filter backend test`
Expected: All tests pass

**Step 3: Push branch**

```bash
git push -u origin feat/m5-rag-chat
```

---

## Summary of files changed

| File                                                 | Action                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `backend/src/mistral/mistral.service.ts`             | Add `decomposeQuery()` method + `generateObject`/`z` imports |
| `backend/src/mistral/mistral.service.spec.ts`        | Add `mockGenerateObject` + `decomposeQuery` test suite       |
| `backend/src/rag/tools/decompose-query.tool.ts`      | **New** — `createDecomposeQueryTool` factory                 |
| `backend/src/rag/tools/decompose-query.tool.spec.ts` | **New** — tool unit tests                                    |
| `backend/src/rag/rag.service.ts`                     | Add import + wire tool + update system prompt                |
| `backend/src/rag/rag.service.spec.ts`                | Add mock + assertion for `decompose_query`                   |
