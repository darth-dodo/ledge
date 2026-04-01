import { describe, it, expect, vi } from 'vitest';

vi.mock('ai', () => ({
  tool: vi.fn((config) => config),
}));

import { createDecomposeQueryTool } from './decompose-query.tool';

describe('createDecomposeQueryTool', () => {
  const mockLlmService = {
    decomposeQuery: vi.fn(),
  };

  it('calls decomposeQuery with the input message', async () => {
    const subQueries = [{ query: 'total spend', intent: 'sql_aggregate' as const }];
    mockLlmService.decomposeQuery.mockResolvedValue(subQueries);

    const tool = createDecomposeQueryTool(mockLlmService as never);
    const result = await tool.execute({ message: 'How much did I spend?' }, {} as never);

    expect(mockLlmService.decomposeQuery).toHaveBeenCalledWith('How much did I spend?');
    expect(result).toEqual({ subQueries });
  });

  it('returns correctly shaped subQueries array', async () => {
    const subQueries = [
      { query: 'groceries total', intent: 'sql_aggregate' as const },
      { query: 'Uber charges', intent: 'vector_search' as const },
    ];
    mockLlmService.decomposeQuery.mockResolvedValue(subQueries);

    const tool = createDecomposeQueryTool(mockLlmService as never);
    const result = await tool.execute({ message: 'groceries and Uber?' }, {} as never);

    expect(result).toEqual({ subQueries });
    expect(result.subQueries).toHaveLength(2);
  });

  it('propagates errors from decomposeQuery', async () => {
    mockLlmService.decomposeQuery.mockRejectedValue(new Error('fail'));

    const tool = createDecomposeQueryTool(mockLlmService as never);

    await expect(tool.execute({ message: 'test' }, {} as never)).rejects.toThrow('fail');
  });
});
