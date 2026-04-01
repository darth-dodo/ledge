import { Injectable, Logger } from '@nestjs/common';
import { createGroq } from '@ai-sdk/groq';
import {
  streamText,
  generateObject,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
  type StopCondition,
} from 'ai';
import { z } from 'zod';
import { VALID_CATEGORIES } from '../shared/categories.js';

const SYSTEM_PROMPT = `You are a bank transaction categorizer. For each transaction description, assign exactly one category from this list:
groceries, dining, transport, utilities, entertainment, shopping, health, education, travel, income, transfer, other

Respond with ONLY a JSON object containing a "categories" key with an array of category strings in the same order as the input descriptions. No explanation, no markdown.

Example input: ["WALMART GROCERY", "UBER TRIP", "NETFLIX"]
Example output: {"categories":["groceries","transport","entertainment"]}`;

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly aiModel: ReturnType<ReturnType<typeof createGroq>> | null;

  constructor() {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      this.logger.warn('GROQ_API_KEY not set — LLM features will be disabled');
      this.aiModel = null;
    } else {
      this.aiModel = createGroq({ apiKey })('llama-3.3-70b-versatile');
    }
  }

  async categorize(descriptions: string[]): Promise<(string | null)[]> {
    if (!this.aiModel || descriptions.length === 0) {
      return descriptions.map(() => null);
    }

    // Batch large lists to avoid response mismatches
    const BATCH_SIZE = 20;
    if (descriptions.length > BATCH_SIZE) {
      const results: (string | null)[] = [];
      for (let i = 0; i < descriptions.length; i += BATCH_SIZE) {
        const batch = descriptions.slice(i, i + BATCH_SIZE);
        const batchResults = await this.categorizeBatch(batch);
        results.push(...batchResults);
      }
      return results;
    }

    return this.categorizeBatch(descriptions);
  }

  private async categorizeBatch(descriptions: string[]): Promise<(string | null)[]> {
    try {
      const { object } = await generateObject({
        model: this.aiModel!,
        system: SYSTEM_PROMPT,
        prompt: JSON.stringify(descriptions),
        schema: z.object({
          categories: z.array(z.string()),
        }),
      });

      const categories = object.categories;

      if (categories.length !== descriptions.length) {
        this.logger.warn(
          `Category count mismatch: expected ${descriptions.length}, got ${categories.length}`,
        );
        return descriptions.map(() => null);
      }

      return categories.map((cat) => {
        if (typeof cat === 'string' && VALID_CATEGORIES.has(cat.toLowerCase())) {
          return cat.toLowerCase();
        }
        return null;
      });
    } catch (error) {
      this.logger.error(
        `Categorization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return descriptions.map(() => null);
    }
  }

  chatStream(params: {
    system: string;
    messages: ModelMessage[];
    tools?: ToolSet;
    stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[];
    onStepFinish?: (step: Record<string, unknown>) => void | Promise<void>;
  }): ReturnType<typeof streamText> {
    if (!this.aiModel) {
      throw new Error('Groq API key not configured');
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

  async decomposeQuery(
    message: string,
  ): Promise<
    Array<{ query: string; intent: 'sql_aggregate' | 'sql_filter' | 'vector_search' | 'hybrid' }>
  > {
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
}
