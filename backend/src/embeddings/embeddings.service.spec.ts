import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the ollama module
// ---------------------------------------------------------------------------

const mockEmbed = vi.fn();
const mockList = vi.fn();

vi.mock('ollama', () => ({
  Ollama: vi.fn().mockImplementation(() => ({
    embed: mockEmbed,
    list: mockList,
  })),
}));

import { EmbeddingsService } from './embeddings.service.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockRepo() {
  return {
    create: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
      id: 'test-uuid',
      ...data,
    })),
    save: vi
      .fn()
      .mockImplementation((entity: Record<string, unknown>) =>
        Promise.resolve({ ...entity, id: entity.id || 'test-uuid' }),
      ),
    delete: vi.fn().mockResolvedValue({ affected: 1 }),
  };
}

function makeMockDataSource() {
  return {
    query: vi.fn().mockResolvedValue([]),
  };
}

function makeMockChunkerService() {
  return {
    chunk: vi.fn().mockReturnValue([
      { content: 'chunk one', chunkIndex: 0, tokenCount: 3 },
      { content: 'chunk two', chunkIndex: 1, tokenCount: 3 },
    ]),
  };
}

function makeOllamaEmbedResponse(count = 1) {
  return {
    embeddings: Array.from({ length: count }, () => new Array(1024).fill(0.1)),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmbeddingsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // By default, Ollama is available
    mockList.mockResolvedValue({ models: [] });
  });

  // Helper to instantiate the service with mocks
  function createService(overrides?: {
    repo?: ReturnType<typeof makeMockRepo>;
    chunker?: ReturnType<typeof makeMockChunkerService>;
    dataSource?: ReturnType<typeof makeMockDataSource>;
  }) {
    const repo = overrides?.repo ?? makeMockRepo();
    const chunker = overrides?.chunker ?? makeMockChunkerService();
    const dataSource = overrides?.dataSource ?? makeMockDataSource();

    // Use Object.create to bypass NestJS DI — call constructor directly
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bypass DI for unit test
    const service = new (EmbeddingsService as any)(repo, chunker, dataSource);
    return { service: service as EmbeddingsService, repo, chunker, dataSource };
  }

  // -----------------------------------------------------------------
  // embedStatement — Ollama not available
  // -----------------------------------------------------------------
  describe('embedStatement — Ollama not available', () => {
    it('logs warning and returns without calling embed', async () => {
      mockList.mockRejectedValue(new Error('Connection refused'));
      const { service, repo } = createService();

      await service.embedStatement('stmt-1', 'some text');

      expect(mockEmbed).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // embedStatement — empty text
  // -----------------------------------------------------------------
  describe('embedStatement — empty text', () => {
    it('returns early for empty string', async () => {
      const { service, repo } = createService();

      await service.embedStatement('stmt-1', '');

      expect(repo.save).not.toHaveBeenCalled();
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('returns early for null text', async () => {
      const { service, repo } = createService();

      await service.embedStatement('stmt-1', null as unknown as string);

      expect(repo.save).not.toHaveBeenCalled();
    });

    it('returns early for whitespace-only text', async () => {
      const { service, repo } = createService();

      await service.embedStatement('stmt-1', '   \n  ');

      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // embedStatement — happy path
  // -----------------------------------------------------------------
  describe('embedStatement — happy path', () => {
    it('chunks text, calls Ollama embed API, and saves to DB with raw SQL for vectors', async () => {
      mockEmbed.mockResolvedValue(makeOllamaEmbedResponse(2));

      const { service, repo, chunker, dataSource } = createService();

      await service.embedStatement('stmt-1', 'Some long text for embedding');

      // 1. Chunks the text
      expect(chunker.chunk).toHaveBeenCalledWith('Some long text for embedding');

      // 2. Calls Ollama embeddings API
      expect(mockEmbed).toHaveBeenCalledWith({
        model: 'nomic-embed-text',
        input: ['chunk one', 'chunk two'],
      });

      // 3. Saves each chunk to DB
      expect(repo.create).toHaveBeenCalledTimes(2);
      expect(repo.save).toHaveBeenCalledTimes(2);

      // 4. Updates vector via raw SQL for each chunk
      const vectorUpdateCalls = dataSource.query.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' && call[0].includes('UPDATE embeddings SET embedding'),
      );
      expect(vectorUpdateCalls).toHaveLength(2);
    });

    it('passes correct statementId and chunk data to repo.create', async () => {
      mockEmbed.mockResolvedValue(makeOllamaEmbedResponse(2));

      const { service, repo } = createService();

      await service.embedStatement('stmt-42', 'text');

      expect(repo.create).toHaveBeenCalledWith({
        statementId: 'stmt-42',
        chunkIndex: 0,
        content: 'chunk one',
        tokenCount: 3,
      });
      expect(repo.create).toHaveBeenCalledWith({
        statementId: 'stmt-42',
        chunkIndex: 1,
        content: 'chunk two',
        tokenCount: 3,
      });
    });
  });

  // -----------------------------------------------------------------
  // embedStatement — idempotency
  // -----------------------------------------------------------------
  describe('embedStatement — idempotency', () => {
    it('calls removeByStatement (deletes existing) before creating new embeddings', async () => {
      mockEmbed.mockResolvedValue(makeOllamaEmbedResponse(2));

      const { service, repo } = createService();

      await service.embedStatement('stmt-1', 'text');

      // delete called before save
      expect(repo.delete).toHaveBeenCalledWith({ statementId: 'stmt-1' });
      const deleteOrder = repo.delete.mock.invocationCallOrder[0];
      const saveOrder = repo.save.mock.invocationCallOrder[0];
      expect(deleteOrder).toBeLessThan(saveOrder!);
    });
  });

  // -----------------------------------------------------------------
  // embedStatement — Ollama API failure
  // -----------------------------------------------------------------
  describe('embedStatement — Ollama API failure', () => {
    it('handles API error gracefully without crashing', async () => {
      mockEmbed.mockRejectedValue(new Error('API rate limit'));

      const { service, repo } = createService();

      // Should not throw
      await expect(service.embedStatement('stmt-1', 'text')).resolves.toBeUndefined();

      // Should not attempt to save when embeddings failed
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // getEmbeddings
  // -----------------------------------------------------------------
  describe('getEmbeddings', () => {
    it('calls client.embed with correct model and input', async () => {
      mockEmbed.mockResolvedValue(makeOllamaEmbedResponse(2));

      const { service } = createService();

      await service.getEmbeddings(['hello', 'world']);

      expect(mockEmbed).toHaveBeenCalledWith({
        model: 'nomic-embed-text',
        input: ['hello', 'world'],
      });
    });

    it('returns vectors from the response', async () => {
      mockEmbed.mockResolvedValue({
        embeddings: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
      });

      const { service } = createService();
      const result = await service.getEmbeddings(['a', 'b']);

      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);
    });

    it('returns null when Ollama is not available', async () => {
      mockList.mockRejectedValue(new Error('Connection refused'));
      const { service } = createService();

      const result = await service.getEmbeddings(['hello']);

      expect(result).toBeNull();
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('returns null for empty inputs array', async () => {
      const { service } = createService();

      const result = await service.getEmbeddings([]);

      expect(result).toBeNull();
    });

    it('returns null on API error', async () => {
      mockEmbed.mockRejectedValue(new Error('Server error'));

      const { service } = createService();
      const result = await service.getEmbeddings(['hello']);

      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // getQueryEmbedding
  // -----------------------------------------------------------------
  describe('getQueryEmbedding', () => {
    it('returns the first vector from getEmbeddings result', async () => {
      mockEmbed.mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
      });

      const { service } = createService();
      const result = await service.getQueryEmbedding('search query');

      expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    it('returns null when getEmbeddings returns null', async () => {
      mockList.mockRejectedValue(new Error('Connection refused'));
      const { service } = createService();

      const result = await service.getQueryEmbedding('query');

      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // similaritySearch
  // -----------------------------------------------------------------
  describe('similaritySearch', () => {
    it('executes correct SQL with vector parameter and limit', async () => {
      const mockResults = [{ id: '1', content: 'match', statementId: 'stmt-1', distance: 0.1 }];
      const { service, dataSource } = createService();
      dataSource.query.mockResolvedValue(mockResults);

      const queryVector = [0.1, 0.2, 0.3];
      const result = await service.similaritySearch(queryVector, 3);

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('embedding <=> $1::vector'),
        ['[0.1,0.2,0.3]', 3],
      );
      expect(result).toEqual(mockResults);
    });

    it('uses default limit of 5', async () => {
      const { service, dataSource } = createService();

      await service.similaritySearch([0.1]);

      expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), ['[0.1]', 5]);
    });
  });
});
