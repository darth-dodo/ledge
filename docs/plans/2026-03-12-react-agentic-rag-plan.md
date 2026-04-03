# ReAct Agentic RAG Implementation Plan

> **Note**: As of M6, the LLM provider was migrated from Mistral to Groq (`llama-3.3-70b-versatile`), and embeddings from Mistral Embed to Ollama (`nomic-embed-text`). `MistralService` was renamed to `LlmService`. See [ADR-005](../adrs/adr-005-groq-ollama-migration.md) for details.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the RAG chat from a simple tool-selector to a ReAct agent with structured reasoning, self-correction, and new capabilities (update_category, chart_data).

**Architecture:** Tool-structured ReAct using Vercel AI SDK's native multi-step loop. `think` and `done` tools enforce Reason→Act→Observe cycle. `stopWhen: [hasToolCall('done'), stepCountIs(10)]` for intelligent termination.

**Tech Stack:** Vercel AI SDK v5+ (`ai`, `@ai-sdk/mistral`), NestJS, TypeORM, Vitest, Zod

**Linear:** [AI-76](https://linear.app/ai-adventures/issue/AI-76/implement-react-agentic-rag-pattern-with-new-tools)

---

## Task 1: Create `think` tool (TDD)

**Files:**

- Create: `backend/src/rag/tools/think.tool.ts`
- Test: `backend/src/rag/tools/think.tool.spec.ts`

**Step 1: Write the failing test**

```typescript
// backend/src/rag/tools/think.tool.spec.ts
import { describe, it, expect } from 'vitest';
import { createThinkTool } from './think.tool';

describe('createThinkTool', () => {
  const tool = createThinkTool();

  it('echoes back the thought string', async () => {
    const result = await tool.execute(
      { thought: 'I need to check spending for March' },
      {} as Record<string, never>,
    );

    expect(result).toEqual({ thought: 'I need to check spending for March' });
  });

  it('handles empty thought string', async () => {
    const result = await tool.execute({ thought: '' }, {} as Record<string, never>);

    expect(result).toEqual({ thought: '' });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && pnpm test -- --run src/rag/tools/think.tool.spec.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// backend/src/rag/tools/think.tool.ts
import { tool } from 'ai';
import { z } from 'zod';

export function createThinkTool() {
  return tool({
    description:
      'Use this tool to think through your approach before acting. Write your reasoning about what tools to call and why. This helps you plan multi-step analyses.',
    inputSchema: z.object({
      thought: z.string().describe('Your reasoning about what to do next'),
    }),
    execute: async ({ thought }: { thought: string }) => {
      return { thought };
    },
  });
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && pnpm test -- --run src/rag/tools/think.tool.spec.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/rag/tools/think.tool.ts backend/src/rag/tools/think.tool.spec.ts
git commit -m "feat(rag): add think tool for structured agent reasoning"
```

---

## Task 2: Create `done` tool (TDD)

**Files:**

- Create: `backend/src/rag/tools/done.tool.ts`
- Test: `backend/src/rag/tools/done.tool.spec.ts`

**Step 1: Write the failing test**

```typescript
// backend/src/rag/tools/done.tool.spec.ts
import { describe, it, expect } from 'vitest';
import { createDoneTool } from './done.tool';

describe('createDoneTool', () => {
  const tool = createDoneTool();

  it('echoes back the summary string', async () => {
    const result = await tool.execute(
      { summary: 'You spent $127.50 on Uber this month' },
      {} as Record<string, never>,
    );

    expect(result).toEqual({ summary: 'You spent $127.50 on Uber this month' });
  });

  it('handles empty summary', async () => {
    const result = await tool.execute({ summary: '' }, {} as Record<string, never>);

    expect(result).toEqual({ summary: '' });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && pnpm test -- --run src/rag/tools/done.tool.spec.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// backend/src/rag/tools/done.tool.ts
import { tool } from 'ai';
import { z } from 'zod';

export function createDoneTool() {
  return tool({
    description:
      'Call this tool when you have gathered enough information and are ready to give your final answer. Provide a brief summary of what you found.',
    inputSchema: z.object({
      summary: z.string().describe('Brief summary of your findings before responding to the user'),
    }),
    execute: async ({ summary }: { summary: string }) => {
      return { summary };
    },
  });
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && pnpm test -- --run src/rag/tools/done.tool.spec.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/rag/tools/done.tool.ts backend/src/rag/tools/done.tool.spec.ts
git commit -m "feat(rag): add done tool for agent completion signaling"
```

---

## Task 3: Create `update_category` tool (TDD)

**Files:**

- Create: `backend/src/rag/tools/update-category.tool.ts`
- Test: `backend/src/rag/tools/update-category.tool.spec.ts`

**Context:** The `VALID_CATEGORIES` set is in `backend/src/mistral/mistral.service.ts`. We need to extract it to a shared location or duplicate it. Since it's a small constant, export it from a shared file.

**Step 1: Extract VALID_CATEGORIES to shared constants**

Create `backend/src/shared/categories.ts`:

```typescript
export const VALID_CATEGORIES = new Set([
  'groceries',
  'dining',
  'transport',
  'utilities',
  'entertainment',
  'shopping',
  'health',
  'education',
  'travel',
  'income',
  'transfer',
  'other',
]);
```

Update `backend/src/mistral/mistral.service.ts` to import from shared:

```typescript
import { VALID_CATEGORIES } from '../shared/categories.js';
```

(Remove the local `VALID_CATEGORIES` declaration.)

**Step 2: Write the failing test**

```typescript
// backend/src/rag/tools/update-category.tool.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { createUpdateCategoryTool } from './update-category.tool';

const mockQuery = vi.fn();
const mockDataSource = { query: mockQuery } as unknown as DataSource;

function buildTool() {
  return createUpdateCategoryTool(mockDataSource);
}

async function execute(transactionId: string, newCategory: string) {
  const tool = buildTool();
  return tool.execute({ transactionId, newCategory }, {} as Record<string, never>);
}

describe('createUpdateCategoryTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates category and returns old + new', async () => {
    // First query: find transaction
    mockQuery.mockResolvedValueOnce([{ id: 'tx-1', category: 'groceries' }]);
    // Second query: update
    mockQuery.mockResolvedValueOnce([]);

    const result = await execute('tx-1', 'dining');

    expect(result).toEqual({
      success: true,
      transactionId: 'tx-1',
      oldCategory: 'groceries',
      newCategory: 'dining',
    });
  });

  it('rejects invalid category', async () => {
    const result = await execute('tx-1', 'invalid-category');

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('Invalid category'),
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns error when transaction not found', async () => {
    mockQuery.mockResolvedValueOnce([]);

    const result = await execute('nonexistent-id', 'dining');

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('not found'),
    });
  });

  it('returns error on database failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));

    const result = await execute('tx-1', 'dining');

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('connection lost'),
    });
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd backend && pnpm test -- --run src/rag/tools/update-category.tool.spec.ts`
Expected: FAIL

**Step 4: Write implementation**

```typescript
// backend/src/rag/tools/update-category.tool.ts
import { tool } from 'ai';
import { z } from 'zod';
import type { DataSource } from 'typeorm';
import { VALID_CATEGORIES } from '../../shared/categories.js';

export function createUpdateCategoryTool(dataSource: DataSource) {
  return tool({
    description:
      'Update the category of a specific transaction. Use this when the user wants to re-categorize a transaction. You must first find the transaction ID using sql_query.',
    inputSchema: z.object({
      transactionId: z.string().describe('The UUID of the transaction to update'),
      newCategory: z
        .string()
        .describe(
          'The new category (groceries, dining, transport, utilities, entertainment, shopping, health, education, travel, income, transfer, other)',
        ),
    }),
    execute: async ({
      transactionId,
      newCategory,
    }: {
      transactionId: string;
      newCategory: string;
    }) => {
      const normalized = newCategory.toLowerCase();
      if (!VALID_CATEGORIES.has(normalized)) {
        return {
          success: false,
          error: `Invalid category "${newCategory}". Must be one of: ${[...VALID_CATEGORIES].join(', ')}`,
        };
      }

      try {
        const rows = await dataSource.query('SELECT id, category FROM transactions WHERE id = $1', [
          transactionId,
        ]);

        if (rows.length === 0) {
          return { success: false, error: `Transaction ${transactionId} not found` };
        }

        const oldCategory = rows[0].category;

        await dataSource.query('UPDATE transactions SET category = $1 WHERE id = $2', [
          normalized,
          transactionId,
        ]);

        return {
          success: true,
          transactionId,
          oldCategory,
          newCategory: normalized,
        };
      } catch (err) {
        return {
          success: false,
          error: `Update failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });
}
```

**Step 5: Run test to verify it passes**

Run: `cd backend && pnpm test -- --run src/rag/tools/update-category.tool.spec.ts`
Expected: PASS

**Step 6: Run mistral service tests to ensure import refactor didn't break anything**

Run: `cd backend && pnpm test -- --run src/mistral/mistral.service.spec.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add backend/src/shared/categories.ts backend/src/rag/tools/update-category.tool.ts backend/src/rag/tools/update-category.tool.spec.ts backend/src/mistral/mistral.service.ts
git commit -m "feat(rag): add update_category tool and extract shared categories"
```

---

## Task 4: Create `chart_data` tool (TDD)

**Files:**

- Create: `backend/src/rag/tools/chart-data.tool.ts`
- Test: `backend/src/rag/tools/chart-data.tool.spec.ts`

**Step 1: Write the failing test**

```typescript
// backend/src/rag/tools/chart-data.tool.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { createChartDataTool } from './chart-data.tool';

const mockQuery = vi.fn();
const mockDataSource = { query: mockQuery } as unknown as DataSource;

function buildTool() {
  return createChartDataTool(mockDataSource);
}

async function execute(type: string, title: string, sql: string) {
  const tool = buildTool();
  return tool.execute({ type, title, sql }, {} as Record<string, never>);
}

describe('createChartDataTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns structured chart data from SQL results', async () => {
    mockQuery.mockResolvedValue([
      { label: 'groceries', value: 500 },
      { label: 'dining', value: 300 },
      { label: 'transport', value: 150 },
    ]);

    const result = await execute(
      'pie',
      'Spending by Category',
      "SELECT category AS label, SUM(amount) AS value FROM transactions WHERE type = 'debit' GROUP BY category ORDER BY value DESC",
    );

    expect(result).toEqual({
      chartType: 'pie',
      title: 'Spending by Category',
      labels: ['groceries', 'dining', 'transport'],
      values: [500, 300, 150],
    });
  });

  it('rejects non-SELECT queries', async () => {
    const result = await execute('bar', 'Bad', 'DROP TABLE transactions');

    expect(result).toHaveProperty('error');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects queries referencing non-transactions tables', async () => {
    const result = await execute('bar', 'Bad', 'SELECT * FROM users');

    expect(result).toHaveProperty('error');
    expect(result.error).toContain('transactions');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns error on SQL execution failure', async () => {
    mockQuery.mockRejectedValue(new Error('syntax error'));

    const result = await execute(
      'bar',
      'Test',
      'SELECT category AS label, SUM(amount) AS value FROM transactions GROUP BY category',
    );

    expect(result).toHaveProperty('error');
    expect(result.error).toContain('syntax error');
  });

  it('handles empty results', async () => {
    mockQuery.mockResolvedValue([]);

    const result = await execute(
      'line',
      'Empty',
      'SELECT date AS label, SUM(amount) AS value FROM transactions GROUP BY date',
    );

    expect(result).toEqual({
      chartType: 'line',
      title: 'Empty',
      labels: [],
      values: [],
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && pnpm test -- --run src/rag/tools/chart-data.tool.spec.ts`
Expected: FAIL

**Step 3: Write implementation**

Note: Reuse the `validateSql` function from `sql-query.tool.ts`. Extract it to a shared util first.

Create `backend/src/rag/tools/validate-sql.ts`:

```typescript
const FORBIDDEN_KEYWORDS = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i;
const ALLOWED_TABLE = /\btransactions\b/i;

export function validateSql(sql: string): string | null {
  const trimmed = sql.trim();

  if (!/^SELECT\b/i.test(trimmed)) {
    return 'Query must start with SELECT';
  }

  if (FORBIDDEN_KEYWORDS.test(trimmed)) {
    return 'Query contains forbidden keywords (DROP, DELETE, INSERT, UPDATE, ALTER, CREATE)';
  }

  if (trimmed.includes(';')) {
    return 'Query must not contain semicolons';
  }

  const fromMatches = trimmed.match(/\bFROM\s+(\w+)/gi);
  const joinMatches = trimmed.match(/\bJOIN\s+(\w+)/gi);

  if (fromMatches) {
    for (const match of fromMatches) {
      const tableName = match.replace(/\bFROM\s+/i, '').trim();
      if (!ALLOWED_TABLE.test(tableName)) {
        return `Only the "transactions" table may be queried, found: ${tableName}`;
      }
    }
  }

  if (joinMatches) {
    return 'JOINs to other tables are not allowed';
  }

  return null;
}
```

Update `backend/src/rag/tools/sql-query.tool.ts` to import from `validate-sql.ts` (remove the inline `validateSql` and constants).

Then create the chart-data tool:

```typescript
// backend/src/rag/tools/chart-data.tool.ts
import { tool } from 'ai';
import { z } from 'zod';
import type { DataSource } from 'typeorm';
import { validateSql } from './validate-sql.js';

export function createChartDataTool(dataSource: DataSource) {
  return tool({
    description:
      'Generate chart-ready data by running a SQL query. The query MUST return rows with "label" and "value" columns (use AS aliases). Returns structured data with labels and values arrays.',
    inputSchema: z.object({
      type: z.enum(['pie', 'bar', 'line']).describe('Chart type'),
      title: z.string().describe('Chart title for display'),
      sql: z
        .string()
        .describe('SELECT query returning "label" and "value" columns from the transactions table'),
    }),
    execute: async ({ type, title, sql }: { type: string; title: string; sql: string }) => {
      const error = validateSql(sql);
      if (error) {
        return { error };
      }

      let safeSql = sql.trim();
      if (!/\bLIMIT\b/i.test(safeSql)) {
        safeSql = `${safeSql} LIMIT 100`;
      }

      try {
        const rows = (await dataSource.query(safeSql)) as Record<string, unknown>[];
        const labels = rows.map((r) => String(r.label ?? ''));
        const values = rows.map((r) => Number(r.value ?? 0));

        return { chartType: type, title, labels, values };
      } catch (err) {
        return {
          error: `Chart query failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && pnpm test -- --run src/rag/tools/chart-data.tool.spec.ts`
Expected: PASS

**Step 5: Run existing sql-query tests to ensure the refactor didn't break them**

Run: `cd backend && pnpm test -- --run src/rag/tools/sql-query.tool.spec.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add backend/src/rag/tools/validate-sql.ts backend/src/rag/tools/chart-data.tool.ts backend/src/rag/tools/chart-data.tool.spec.ts backend/src/rag/tools/sql-query.tool.ts
git commit -m "feat(rag): add chart_data tool and extract shared SQL validation"
```

---

## Task 5: Update `mistral.service.ts` chatStream signature (TDD)

**Files:**

- Modify: `backend/src/mistral/mistral.service.ts:136-153`
- Test: `backend/src/mistral/mistral.service.spec.ts`

**Step 1: Update the failing tests first**

The `chatStream` method needs to accept `stopWhen` directly (any valid AI SDK stop condition) and an optional `onStepFinish` callback, instead of just `maxSteps`.

Update the chatStream test section in `mistral.service.spec.ts`:

```typescript
// Replace the existing chatStream tests with:

describe('chatStream', () => {
  it('throws error when API key not configured', () => {
    delete process.env.MISTRAL_API_KEY;
    const service = new MistralService();

    expect(() =>
      service.chatStream({
        system: 'You are a helper',
        messages: [{ role: 'user', content: 'hello' }] as unknown[],
      }),
    ).toThrow('Mistral API key not configured');
  });

  it('passes stopWhen directly to streamText', () => {
    process.env.MISTRAL_API_KEY = 'test-api-key';
    mockStreamText.mockReturnValue('stream-result');

    const service = new MistralService();
    const tools = { myTool: {} } as unknown as Record<string, unknown>;
    const messages = [{ role: 'user', content: 'hello' }] as unknown[];
    const stopWhen = ['mock-stop-condition'];

    service.chatStream({
      system: 'You are a helper',
      messages,
      tools,
      stopWhen,
    });

    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        stopWhen,
        tools,
      }),
    );
  });

  it('defaults stopWhen to stepCountIs(3) when not provided', () => {
    process.env.MISTRAL_API_KEY = 'test-api-key';
    mockStepCountIs.mockReturnValue('stop-default');
    mockStreamText.mockReturnValue('stream-result');

    const service = new MistralService();

    service.chatStream({
      system: 'system prompt',
      messages: [] as unknown[],
    });

    expect(mockStepCountIs).toHaveBeenCalledWith(3);
    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        stopWhen: 'stop-default',
      }),
    );
  });

  it('passes onStepFinish callback when provided', () => {
    process.env.MISTRAL_API_KEY = 'test-api-key';
    mockStreamText.mockReturnValue('stream-result');

    const service = new MistralService();
    const onStepFinish = vi.fn();

    service.chatStream({
      system: 'system prompt',
      messages: [] as unknown[],
      onStepFinish,
    });

    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        onStepFinish,
      }),
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && pnpm test -- --run src/mistral/mistral.service.spec.ts`
Expected: FAIL — chatStream doesn't accept `stopWhen` or `onStepFinish` yet

**Step 3: Update implementation**

In `backend/src/mistral/mistral.service.ts`, replace the `chatStream` method (lines 136-153):

```typescript
  chatStream(params: {
    system: string;
    messages: ModelMessage[];
    tools?: ToolSet;
    stopWhen?: unknown;
    onStepFinish?: (step: Record<string, unknown>) => void | Promise<void>;
  }): ReturnType<typeof streamText> {
    if (!this.aiModel) {
      throw new Error('Mistral API key not configured');
    }

    return streamText({
      model: this.aiModel,
      system: params.system,
      messages: params.messages,
      tools: params.tools,
      stopWhen: params.stopWhen ?? stepCountIs(3),
      onStepFinish: params.onStepFinish,
    });
  }
```

**Step 4: Run test to verify it passes**

Run: `cd backend && pnpm test -- --run src/mistral/mistral.service.spec.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/mistral/mistral.service.ts backend/src/mistral/mistral.service.spec.ts
git commit -m "feat(mistral): accept stopWhen and onStepFinish in chatStream"
```

---

## Task 6: Wire ReAct agent in `rag.service.ts` (TDD)

**Files:**

- Modify: `backend/src/rag/rag.service.ts`
- Test: `backend/src/rag/rag.service.spec.ts`

**Step 1: Update test mocks and tool creation tests**

In `rag.service.spec.ts`:

Add mocks for new tool factories at the top (alongside existing mocks):

```typescript
vi.mock('ai', () => ({
  streamText: vi.fn(),
  tool: vi.fn((config) => config),
  stepCountIs: vi.fn((n) => n),
  hasToolCall: vi.fn((name) => `hasToolCall:${name}`),
}));

vi.mock('./tools/think.tool', () => ({
  createThinkTool: vi.fn(() => 'mockThinkTool'),
}));

vi.mock('./tools/done.tool', () => ({
  createDoneTool: vi.fn(() => 'mockDoneTool'),
}));

vi.mock('./tools/update-category.tool', () => ({
  createUpdateCategoryTool: vi.fn(() => 'mockUpdateCategoryTool'),
}));

vi.mock('./tools/chart-data.tool', () => ({
  createChartDataTool: vi.fn(() => 'mockChartDataTool'),
}));
```

Import the new factories and `hasToolCall`:

```typescript
import { createThinkTool } from './tools/think.tool';
import { createDoneTool } from './tools/done.tool';
import { createUpdateCategoryTool } from './tools/update-category.tool';
import { createChartDataTool } from './tools/chart-data.tool';
```

Update the "tool creation" test section:

```typescript
describe('chat() — tool creation', () => {
  it('creates all six tools', async () => {
    await service.chat(null, 'Search something');

    expect(createThinkTool).toHaveBeenCalled();
    expect(createDoneTool).toHaveBeenCalled();
    expect(createVectorSearchTool).toHaveBeenCalledWith(embeddingsService);
    expect(createSqlQueryTool).toHaveBeenCalledWith(dataSource);
    expect(createUpdateCategoryTool).toHaveBeenCalledWith(dataSource);
    expect(createChartDataTool).toHaveBeenCalledWith(dataSource);
  });

  it('passes all tools to chatStream', async () => {
    await service.chat(null, 'Search something');

    expect(mistralService.chatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: {
          think: 'mockThinkTool',
          done: 'mockDoneTool',
          vector_search: 'mockVectorTool',
          sql_query: 'mockSqlTool',
          update_category: 'mockUpdateCategoryTool',
          chart_data: 'mockChartDataTool',
        },
      }),
    );
  });
});
```

Update the "streaming and response" test to check for `stopWhen` instead of `maxSteps`:

```typescript
it('calls mistralService.chatStream with stopWhen conditions', async () => {
  await service.chat(null, 'Hello');

  expect(mistralService.chatStream).toHaveBeenCalledWith(
    expect.objectContaining({
      system: expect.stringContaining('agentic financial assistant'),
      stopWhen: ['hasToolCall:done', 10],
      onStepFinish: expect.any(Function),
    }),
  );
});
```

Update the "system prompt" tests to check for ReAct keywords:

```typescript
it('system prompt contains ReAct instructions', async () => {
  await service.chat(null, 'Hello');

  const call = mistralService.chatStream.mock.calls[0][0];
  expect(call.system).toContain('think');
  expect(call.system).toContain('done');
  expect(call.system).toContain('THINK');
  expect(call.system).toContain('update_category');
  expect(call.system).toContain('chart_data');
});
```

Update conversation history test to check for 20 messages:

```typescript
it('loads conversation history (last 20 messages)', async () => {
  await service.chat(null, 'Hello');

  expect(messageRepo.find).toHaveBeenCalledWith({
    where: { sessionId: 'session-1' },
    order: { createdAt: 'ASC' },
    take: 20,
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd backend && pnpm test -- --run src/rag/rag.service.spec.ts`
Expected: FAIL — service still builds only 2 tools, uses `maxSteps`

**Step 3: Update the rag.service.ts implementation**

Replace the full file — key changes:

- Import new tool factories and `hasToolCall` from `ai`
- Rewrite `buildSystemPrompt` for ReAct
- Build all 6 tools
- Pass `stopWhen: [hasToolCall('done'), stepCountIs(10)]` and `onStepFinish`
- Increase history to 20 messages

```typescript
// New imports at top:
import { hasToolCall, stepCountIs } from 'ai';
import { createThinkTool } from './tools/think.tool';
import { createDoneTool } from './tools/done.tool';
import { createUpdateCategoryTool } from './tools/update-category.tool';
import { createChartDataTool } from './tools/chart-data.tool';
```

New `buildSystemPrompt`:

```typescript
function buildSystemPrompt(currency: string): string {
  return `You are an agentic financial assistant analyzing the user's bank statements and transactions.

You follow a ReAct (Reason-Act-Observe) loop for every question:

1. THINK: Always call the \`think\` tool first to plan your approach
2. ACT: Call the appropriate tool(s)
3. OBSERVE: Review the results
4. REPEAT: If results are unexpected or incomplete, think again and try a different approach
5. DONE: Call the \`done\` tool when you have a complete answer

Available tools:
- think: Plan your approach before acting. Always use this first.
- sql_query: Query the PostgreSQL transactions database. Best for calculations, aggregations, filtering.
- vector_search: Semantic search over bank statement text. Best for finding specific merchants or contextual questions.
- update_category: Re-categorize a transaction. Find the transaction ID with sql_query first.
- chart_data: Generate chart-ready data. Query MUST return "label" and "value" columns.
- done: Signal you have enough information to answer. Always call this last.

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

In the `chat` method, update tool building and chatStream call:

```typescript
// 3. Load conversation history (last 20 messages)
const history = await this.messageRepo.find({
  where: { sessionId: session.id },
  order: { createdAt: 'ASC' },
  take: 20,
});

// ...

// 4. Build tools with injected dependencies
const tools = {
  think: createThinkTool(),
  done: createDoneTool(),
  vector_search: createVectorSearchTool(this.embeddingsService),
  sql_query: createSqlQueryTool(this.dataSource),
  update_category: createUpdateCategoryTool(this.dataSource),
  chart_data: createChartDataTool(this.dataSource),
};

// 5. Call mistralService.chatStream() with ReAct loop control
const streamResult = this.mistralService.chatStream({
  system: buildSystemPrompt(currency),
  messages,
  tools,
  stopWhen: [hasToolCall('done'), stepCountIs(10)],
  onStepFinish: ({ toolResults, stepNumber, finishReason }) => {
    this.logger.debug(`Step ${stepNumber} finished (${finishReason})`);
    if (toolResults?.length) {
      this.logger.debug(`Tool results: ${JSON.stringify(toolResults)}`);
    }
  },
});
```

**Step 4: Run tests to verify they pass**

Run: `cd backend && pnpm test -- --run src/rag/rag.service.spec.ts`
Expected: PASS

**Step 5: Run the full test suite**

Run: `cd backend && pnpm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add backend/src/rag/rag.service.ts backend/src/rag/rag.service.spec.ts
git commit -m "feat(rag): wire ReAct agent loop with 6 tools and intelligent stop conditions"
```

---

## Task 7: Final verification and cleanup

**Step 1: Run full backend test suite**

Run: `cd backend && pnpm test`
Expected: All tests PASS

**Step 2: Run type check**

Run: `cd backend && pnpm build`
Expected: No type errors

**Step 3: Run lint**

Run: `cd backend && pnpm lint`
Expected: Clean (fix any issues)

**Step 4: Commit any lint fixes**

```bash
git add -A
git commit -m "chore: fix lint issues from ReAct agent implementation"
```

---

## Summary of all files changed

**New files (6):**

- `backend/src/shared/categories.ts`
- `backend/src/rag/tools/think.tool.ts` + spec
- `backend/src/rag/tools/done.tool.ts` + spec
- `backend/src/rag/tools/update-category.tool.ts` + spec
- `backend/src/rag/tools/chart-data.tool.ts` + spec
- `backend/src/rag/tools/validate-sql.ts`

**Modified files (4):**

- `backend/src/mistral/mistral.service.ts` — import shared categories, update chatStream signature
- `backend/src/mistral/mistral.service.spec.ts` — update chatStream tests
- `backend/src/rag/rag.service.ts` — ReAct system prompt, 6 tools, stopWhen, onStepFinish
- `backend/src/rag/rag.service.spec.ts` — new tool mocks and assertions
- `backend/src/rag/tools/sql-query.tool.ts` — import validateSql from shared util
