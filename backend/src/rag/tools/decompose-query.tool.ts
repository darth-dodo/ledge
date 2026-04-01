import { tool } from 'ai';
import { z } from 'zod';
import type { LlmService } from '../../llm/llm.service';

export function createDecomposeQueryTool(llmService: LlmService) {
  return tool({
    description:
      'Decompose the user message into structured sub-queries with intent tags. Call this first on every message to plan your approach.',
    inputSchema: z.object({
      message: z.string().describe('The original user message to decompose into sub-queries'),
    }),
    execute: async ({ message }: { message: string }) => {
      const subQueries = await llmService.decomposeQuery(message);
      return { subQueries };
    },
  });
}
