import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock variables (available inside vi.mock factories)
// ---------------------------------------------------------------------------

const { mockStreamText, mockStepCountIs, mockCreateGroq, mockGenerateText } = vi.hoisted(() => ({
  mockStreamText: vi.fn(),
  mockStepCountIs: vi.fn(),
  mockCreateGroq: vi.fn(),
  mockGenerateText: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock @ai-sdk/groq and ai modules
// ---------------------------------------------------------------------------

vi.mock('@ai-sdk/groq', () => ({
  createGroq: (...args: unknown[]) => {
    mockCreateGroq(...args);
    return () => 'mock-model';
  },
}));

vi.mock('ai', () => ({
  streamText: mockStreamText,
  stepCountIs: mockStepCountIs,
  generateText: mockGenerateText,
  Output: { object: (opts: unknown) => opts },
}));

import { LlmService } from './llm.service.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LlmService', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.GROQ_API_KEY;
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore the env var
    if (originalApiKey !== undefined) {
      process.env.GROQ_API_KEY = originalApiKey;
    } else {
      delete process.env.GROQ_API_KEY;
    }
  });

  // ---------------------------------------------------------------
  // No API key
  // ---------------------------------------------------------------
  describe('when GROQ_API_KEY is not set', () => {
    it('returns nulls for all descriptions', async () => {
      delete process.env.GROQ_API_KEY;
      const service = new LlmService();

      const result = await service.categorize(['Coffee', 'Rent', 'Netflix']);

      expect(result).toEqual([null, null, null]);
      expect(mockGenerateText).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // With API key
  // ---------------------------------------------------------------
  describe('when GROQ_API_KEY is set', () => {
    let service: LlmService;

    beforeEach(() => {
      process.env.GROQ_API_KEY = 'test-api-key';
      service = new LlmService();
    });

    it('returns empty array for empty input', async () => {
      const result = await service.categorize([]);

      expect(result).toEqual([]);
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it('parses valid category response from generateText', async () => {
      mockGenerateText.mockResolvedValue({
        output: { categories: ['groceries', 'dining', 'transport'] },
      });

      const result = await service.categorize(['WALMART GROCERY', 'PIZZA HUT', 'UBER TRIP']);

      expect(result).toEqual(['groceries', 'dining', 'transport']);
    });

    it('returns nulls when response count mismatches input count', async () => {
      mockGenerateText.mockResolvedValue({
        output: { categories: ['groceries', 'dining'] },
      });

      // Sending 3 descriptions but response only has 2
      const result = await service.categorize(['WALMART', 'PIZZA HUT', 'GAS STATION']);

      expect(result).toEqual([null, null, null]);
    });

    it('returns nulls on error', async () => {
      mockGenerateText.mockRejectedValue(new Error('Network timeout'));

      const result = await service.categorize(['WALMART', 'UBER']);

      expect(result).toEqual([null, null]);
    });

    it('validates categories against the allowed set', async () => {
      mockGenerateText.mockResolvedValue({
        output: { categories: ['groceries', 'INVALID_CATEGORY', 'dining'] },
      });

      const result = await service.categorize(['WALMART', 'UNKNOWN', 'PIZZA HUT']);

      expect(result).toEqual(['groceries', null, 'dining']);
    });

    it('normalizes category casing to lowercase', async () => {
      mockGenerateText.mockResolvedValue({
        output: { categories: ['Groceries', 'DINING', 'Transport'] },
      });

      const result = await service.categorize(['WALMART', 'PIZZA HUT', 'UBER']);

      expect(result).toEqual(['groceries', 'dining', 'transport']);
    });

    it('sends the correct output schema and prompt to generateText', async () => {
      mockGenerateText.mockResolvedValue({
        output: { categories: ['groceries'] },
      });

      await service.categorize(['WALMART']);

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'mock-model',
          system: expect.stringContaining('bank transaction categorizer'),
          prompt: '["WALMART"]',
          output: expect.anything(),
        }),
      );
    });

    it('handles all valid category values', async () => {
      const allCategories = [
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
      ];

      mockGenerateText.mockResolvedValue({
        output: { categories: allCategories },
      });

      const descriptions = allCategories.map((c) => `desc-for-${c}`);
      const result = await service.categorize(descriptions);

      expect(result).toEqual(allCategories);
    });
  });

  // ---------------------------------------------------------------
  // chatStream
  // ---------------------------------------------------------------
  describe('chatStream', () => {
    it('throws error when API key not configured', () => {
      delete process.env.GROQ_API_KEY;
      const service = new LlmService();

      expect(() =>
        service.chatStream({
          system: 'You are a helper',
          messages: [{ role: 'user', content: 'hello' }] as unknown[],
        }),
      ).toThrow('Groq API key not configured');
    });

    it('passes stopWhen directly to streamText', () => {
      process.env.GROQ_API_KEY = 'test-api-key';
      mockStreamText.mockReturnValue('stream-result');

      const service = new LlmService();
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
      process.env.GROQ_API_KEY = 'test-api-key';
      mockStepCountIs.mockReturnValue('stop-default');
      mockStreamText.mockReturnValue('stream-result');

      const service = new LlmService();

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
      process.env.GROQ_API_KEY = 'test-api-key';
      mockStreamText.mockReturnValue('stream-result');

      const service = new LlmService();
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
});

describe('decomposeQuery', () => {
  let service: LlmService;

  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key';
    service = new LlmService();
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    delete process.env.GROQ_API_KEY;
  });

  it('returns a single sub-query for a simple message', async () => {
    mockGenerateText.mockResolvedValue({
      output: {
        subQueries: [{ query: 'total spend last month', intent: 'sql_aggregate' }],
      },
    });

    const result = await service.decomposeQuery('How much did I spend last month?');

    expect(result).toEqual([{ query: 'total spend last month', intent: 'sql_aggregate' }]);
  });

  it('returns multiple sub-queries for a compound message', async () => {
    mockGenerateText.mockResolvedValue({
      output: {
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

  it('falls back to hybrid intent when generateText throws', async () => {
    mockGenerateText.mockRejectedValue(new Error('API error'));

    const message = 'What are my biggest expenses?';
    const result = await service.decomposeQuery(message);

    expect(result).toEqual([{ query: message, intent: 'hybrid' }]);
  });

  it('returns hybrid fallback when API key is not set', async () => {
    delete process.env.GROQ_API_KEY;
    const noKeyService = new LlmService();

    const message = 'Show me my transactions';
    const result = await noKeyService.decomposeQuery(message);

    expect(result).toEqual([{ query: message, intent: 'hybrid' }]);
  });
});
