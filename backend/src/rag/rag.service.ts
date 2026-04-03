import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import type { ModelMessage } from 'ai';
import { hasToolCall, stepCountIs } from 'ai';
import { ChatSession } from './entities/chat-session.entity';
import { ChatMessage } from './entities/chat-message.entity';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { LlmService } from '../llm/llm.service';
import { createVectorSearchTool } from './tools/vector-search.tool';
import { createSqlQueryTool } from './tools/sql-query.tool';
import { createThinkTool } from './tools/think.tool';
import { createDoneTool } from './tools/done.tool';
import { createUpdateCategoryTool } from './tools/update-category.tool';
import { createChartDataTool } from './tools/chart-data.tool';
import { createDecomposeQueryTool } from './tools/decompose-query.tool';

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

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    @InjectRepository(ChatSession)
    private readonly sessionRepo: Repository<ChatSession>,
    @InjectRepository(ChatMessage)
    private readonly messageRepo: Repository<ChatMessage>,
    @Inject(EmbeddingsService)
    private readonly embeddingsService: EmbeddingsService,
    @Inject(LlmService)
    private readonly llmService: LlmService,
    @Inject(DataSource)
    private readonly dataSource: DataSource,
  ) {}

  async chat(
    sessionId: string | null,
    message: string,
    currency: string = 'USD',
  ): Promise<{ streamResult: ReturnType<typeof import('ai').streamText>; sessionId: string }> {
    // 1. Create or get session
    let session: ChatSession;
    let isNewSession = false;

    if (sessionId) {
      const existing = await this.sessionRepo.findOne({ where: { id: sessionId } });
      if (!existing) {
        throw new Error(`Session ${sessionId} not found`);
      }
      session = existing;
    } else {
      session = this.sessionRepo.create({ title: null });
      session = await this.sessionRepo.save(session);
      isNewSession = true;
    }

    // 2. Save user message
    const userMessage = this.messageRepo.create({
      sessionId: session.id,
      role: 'user',
      content: message,
      sources: null,
    });
    await this.messageRepo.save(userMessage);

    // 3. Load conversation history (last 20 messages)
    const history = await this.messageRepo.find({
      where: { sessionId: session.id },
      order: { createdAt: 'ASC' },
      take: 20,
    });

    const messages: ModelMessage[] = history.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }));

    // 4. Build tools with injected dependencies
    const tools = {
      think: createThinkTool(),
      done: createDoneTool(),
      decompose_query: createDecomposeQueryTool(this.llmService),
      vector_search: createVectorSearchTool(this.embeddingsService),
      sql_query: createSqlQueryTool(this.dataSource),
      update_category: createUpdateCategoryTool(this.dataSource),
      chart_data: createChartDataTool(this.dataSource),
    };

    // 5. Call llmService.chatStream()
    const streamResult = this.llmService.chatStream({
      system: buildSystemPrompt(currency),
      messages,
      tools,
      stopWhen: [hasToolCall('done'), stepCountIs(10)],
      onStepFinish: ({ toolResults, stepNumber, finishReason }: Record<string, unknown>) => {
        this.logger.debug(`Step ${stepNumber} finished (${finishReason})`);
        if (Array.isArray(toolResults) && toolResults.length) {
          this.logger.debug(`Tool results: ${JSON.stringify(toolResults)}`);
        }
      },
    });

    // 6. Save assistant response after stream completes (background)
    const sessionForSave = session;
    const newSession = isNewSession;
    const userMsg = message;

    void (async () => {
      try {
        // The agent may put its answer in tool calls (done tool summary)
        // rather than as plain text. Extract from steps if text is empty.
        let text = await streamResult.text;
        if (!text) {
          const steps = await streamResult.steps;
          for (const step of steps) {
            for (const result of step.toolResults ?? []) {
              if (result.toolName === 'done' && typeof result.output?.summary === 'string') {
                text = result.output.summary;
              }
            }
          }
        }

        const assistantMessage = this.messageRepo.create({
          sessionId: sessionForSave.id,
          role: 'assistant',
          content: text,
          sources: null,
        });
        await this.messageRepo.save(assistantMessage);

        // Auto-generate title for new sessions
        if (newSession) {
          sessionForSave.title = userMsg.substring(0, 50);
          await this.sessionRepo.save(sessionForSave);
        }
      } catch (err) {
        this.logger.error(
          `Failed to save assistant message: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();

    return { streamResult, sessionId: session.id };
  }

  async getSessions(): Promise<ChatSession[]> {
    return this.sessionRepo.find({
      order: { updatedAt: 'DESC' },
    });
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.messageRepo.find({
      where: { sessionId },
      order: { createdAt: 'ASC' },
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.sessionRepo.delete(sessionId);
  }
}
