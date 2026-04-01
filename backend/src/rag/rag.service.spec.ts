import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock external modules before importing the service
// ---------------------------------------------------------------------------

vi.mock('ai', () => ({
  streamText: vi.fn(),
  tool: vi.fn((config) => config),
  stepCountIs: vi.fn((n) => n),
  hasToolCall: vi.fn((name) => `hasToolCall:${name}`),
}));

vi.mock('./tools/vector-search.tool', () => ({
  createVectorSearchTool: vi.fn(() => 'mockVectorTool'),
}));

vi.mock('./tools/sql-query.tool', () => ({
  createSqlQueryTool: vi.fn(() => 'mockSqlTool'),
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

vi.mock('./tools/decompose-query.tool', () => ({
  createDecomposeQueryTool: vi.fn(() => 'mockDecomposeQueryTool'),
}));

import { RagService } from './rag.service';
import { createVectorSearchTool } from './tools/vector-search.tool';
import { createSqlQueryTool } from './tools/sql-query.tool';
import { createThinkTool } from './tools/think.tool';
import { createDoneTool } from './tools/done.tool';
import { createUpdateCategoryTool } from './tools/update-category.tool';
import { createChartDataTool } from './tools/chart-data.tool';
import { createDecomposeQueryTool } from './tools/decompose-query.tool';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockSessionRepo() {
  return {
    findOne: vi.fn(),
    create: vi.fn((data: Record<string, unknown>) => ({
      id: 'session-1',
      ...data,
    })),
    save: vi.fn((entity: Record<string, unknown>) =>
      Promise.resolve({ id: 'session-1', ...entity }),
    ),
    find: vi.fn(),
    delete: vi.fn(),
  };
}

function makeMockMessageRepo() {
  return {
    create: vi.fn((data: Record<string, unknown>) => ({
      id: 'msg-1',
      ...data,
    })),
    save: vi.fn((entity: Record<string, unknown>) => Promise.resolve(entity)),
    find: vi.fn(),
  };
}

function makeMockEmbeddingsService() {
  return {
    getQueryEmbedding: vi.fn(),
    similaritySearch: vi.fn(),
  };
}

function makeMockLlmService() {
  return {
    chatStream: vi.fn(),
  };
}

function makeMockDataSource() {
  return {};
}

function createService() {
  const sessionRepo = makeMockSessionRepo();
  const messageRepo = makeMockMessageRepo();
  const embeddingsService = makeMockEmbeddingsService();
  const llmService = makeMockLlmService();
  const dataSource = makeMockDataSource();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new (RagService as any)(
    sessionRepo,
    messageRepo,
    embeddingsService,
    llmService,
    dataSource,
  ) as RagService;

  return { service, sessionRepo, messageRepo, embeddingsService, llmService, dataSource };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RagService', () => {
  let service: RagService;
  let sessionRepo: ReturnType<typeof makeMockSessionRepo>;
  let messageRepo: ReturnType<typeof makeMockMessageRepo>;
  let embeddingsService: ReturnType<typeof makeMockEmbeddingsService>;
  let llmService: ReturnType<typeof makeMockLlmService>;
  let dataSource: ReturnType<typeof makeMockDataSource>;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ service, sessionRepo, messageRepo, embeddingsService, llmService, dataSource } =
      createService());

    // Default: chatStream returns a mock stream result
    llmService.chatStream.mockReturnValue({
      text: Promise.resolve('AI response text'),
      pipeUIMessageStreamToResponse: vi.fn(),
    });

    // Default: messageRepo.find returns empty history
    messageRepo.find.mockResolvedValue([]);
  });

  // -----------------------------------------------------------------
  // chat() — session management
  // -----------------------------------------------------------------
  describe('chat() — session management', () => {
    it('creates a new session when sessionId is null', async () => {
      const result = await service.chat(null, 'Hello');

      expect(sessionRepo.create).toHaveBeenCalledWith({ title: null });
      expect(sessionRepo.save).toHaveBeenCalled();
      expect(result.sessionId).toBe('session-1');
    });

    it('uses existing session when sessionId is provided', async () => {
      const existingSession = { id: 'existing-session', title: 'Old chat' };
      sessionRepo.findOne.mockResolvedValue(existingSession);

      const result = await service.chat('existing-session', 'Hello');

      expect(sessionRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'existing-session' },
      });
      expect(sessionRepo.create).not.toHaveBeenCalled();
      expect(result.sessionId).toBe('existing-session');
    });

    it('throws when session is not found', async () => {
      sessionRepo.findOne.mockResolvedValue(null);

      await expect(service.chat('nonexistent-id', 'Hello')).rejects.toThrow(
        'Session nonexistent-id not found',
      );
    });
  });

  // -----------------------------------------------------------------
  // chat() — message handling
  // -----------------------------------------------------------------
  describe('chat() — message handling', () => {
    it('saves user message to the database', async () => {
      await service.chat(null, 'What is my spending?');

      expect(messageRepo.create).toHaveBeenCalledWith({
        sessionId: 'session-1',
        role: 'user',
        content: 'What is my spending?',
        sources: null,
      });
      expect(messageRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          content: 'What is my spending?',
        }),
      );
    });

    it('loads conversation history (last 20 messages)', async () => {
      await service.chat(null, 'Hello');

      expect(messageRepo.find).toHaveBeenCalledWith({
        where: { sessionId: 'session-1' },
        order: { createdAt: 'ASC' },
        take: 20,
      });
    });

    it('maps history messages to ModelMessage format', async () => {
      messageRepo.find.mockResolvedValue([
        { role: 'user', content: 'Hi', createdAt: new Date() },
        { role: 'assistant', content: 'Hello!', createdAt: new Date() },
        { role: 'user', content: 'How much did I spend?', createdAt: new Date() },
      ]);

      await service.chat(null, 'How much did I spend?');

      expect(llmService.chatStream).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello!' },
            { role: 'user', content: 'How much did I spend?' },
          ],
        }),
      );
    });
  });

  // -----------------------------------------------------------------
  // chat() — tool creation
  // -----------------------------------------------------------------
  describe('chat() — tool creation', () => {
    it('creates all seven tools', async () => {
      await service.chat(null, 'Search something');

      expect(createThinkTool).toHaveBeenCalled();
      expect(createDoneTool).toHaveBeenCalled();
      expect(createVectorSearchTool).toHaveBeenCalledWith(embeddingsService);
      expect(createSqlQueryTool).toHaveBeenCalledWith(dataSource);
      expect(createUpdateCategoryTool).toHaveBeenCalledWith(dataSource);
      expect(createChartDataTool).toHaveBeenCalledWith(dataSource);
      expect(createDecomposeQueryTool).toHaveBeenCalledWith(llmService);
    });

    it('passes all tools to chatStream', async () => {
      await service.chat(null, 'Search something');

      expect(llmService.chatStream).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: {
            think: 'mockThinkTool',
            done: 'mockDoneTool',
            vector_search: 'mockVectorTool',
            sql_query: 'mockSqlTool',
            update_category: 'mockUpdateCategoryTool',
            chart_data: 'mockChartDataTool',
            decompose_query: 'mockDecomposeQueryTool',
          },
        }),
      );
    });

    it('passes decompose_query tool to chatStream', async () => {
      await service.chat(null, 'How much did I spend?', 'EUR');

      const callArgs = llmService.chatStream.mock.calls[0]![0]!;
      expect(callArgs.tools).toHaveProperty('decompose_query', 'mockDecomposeQueryTool');
      expect(createDecomposeQueryTool).toHaveBeenCalledWith(llmService);
    });
  });

  // -----------------------------------------------------------------
  // chat() — streaming and response
  // -----------------------------------------------------------------
  describe('chat() — streaming and response', () => {
    it('calls llmService.chatStream with stopWhen conditions', async () => {
      await service.chat(null, 'Hello');

      expect(llmService.chatStream).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining('agentic financial assistant'),
          stopWhen: ['hasToolCall:done', 10],
          onStepFinish: expect.any(Function),
        }),
      );
    });

    it('returns streamResult and sessionId', async () => {
      const mockStreamResult = {
        text: Promise.resolve('AI response'),
        pipeUIMessageStreamToResponse: vi.fn(),
      };
      llmService.chatStream.mockReturnValue(mockStreamResult);

      const result = await service.chat(null, 'Hello');

      expect(result.streamResult).toBe(mockStreamResult);
      expect(result.sessionId).toBe('session-1');
    });
  });

  // -----------------------------------------------------------------
  // chat() — system prompt and currency
  // -----------------------------------------------------------------
  describe('chat() — system prompt and currency', () => {
    it('includes currency in system prompt when provided', async () => {
      await service.chat(null, 'Hello', 'EUR');

      expect(llmService.chatStream).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining('EUR'),
        }),
      );
    });

    it('defaults currency to USD', async () => {
      await service.chat(null, 'Hello');

      expect(llmService.chatStream).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining('USD'),
        }),
      );
    });

    it('system prompt contains ReAct instructions', async () => {
      await service.chat(null, 'Hello');

      const call = llmService.chatStream.mock.calls[0][0];
      expect(call.system).toContain('think');
      expect(call.system).toContain('done');
      expect(call.system).toContain('THINK');
      expect(call.system).toContain('update_category');
      expect(call.system).toContain('chart_data');
    });
  });

  // -----------------------------------------------------------------
  // chat() — background save of assistant response
  // -----------------------------------------------------------------
  describe('chat() — background save', () => {
    it('saves assistant message after stream completes', async () => {
      let resolveText!: (value: string) => void;
      const textPromise = new Promise<string>((resolve) => {
        resolveText = resolve;
      });

      llmService.chatStream.mockReturnValue({
        text: textPromise,
        pipeUIMessageStreamToResponse: vi.fn(),
      });

      await service.chat(null, 'Hello');

      // Assistant message should not be saved yet
      const assistantSaves = messageRepo.create.mock.calls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).role === 'assistant',
      );
      expect(assistantSaves).toHaveLength(0);

      // Resolve the text promise
      resolveText('The AI answer');

      // Wait for the background async to complete
      await new Promise((r) => setTimeout(r, 10));

      expect(messageRepo.create).toHaveBeenCalledWith({
        sessionId: 'session-1',
        role: 'assistant',
        content: 'The AI answer',
        sources: null,
      });
    });

    it('sets session title for new sessions after stream completes', async () => {
      llmService.chatStream.mockReturnValue({
        text: Promise.resolve('AI response'),
        pipeUIMessageStreamToResponse: vi.fn(),
      });

      await service.chat(null, 'What is my total spending this month?');

      // Wait for background async
      await new Promise((r) => setTimeout(r, 10));

      // Session save should be called with title (substring of user message)
      const sessionSaveCalls = sessionRepo.save.mock.calls;
      const titleSave = sessionSaveCalls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>).title !== null,
      );
      expect(titleSave).toBeDefined();
      expect((titleSave![0] as Record<string, unknown>).title).toBe(
        'What is my total spending this month?'.substring(0, 50),
      );
    });

    it('does not update title for existing sessions', async () => {
      const existingSession = { id: 'existing-session', title: 'Old chat' };
      sessionRepo.findOne.mockResolvedValue(existingSession);

      llmService.chatStream.mockReturnValue({
        text: Promise.resolve('AI response'),
        pipeUIMessageStreamToResponse: vi.fn(),
      });

      await service.chat('existing-session', 'Hello');

      // Wait for background async
      await new Promise((r) => setTimeout(r, 10));

      // sessionRepo.save should NOT be called for title update (only initial save for new sessions)
      // For existing sessions, sessionRepo.save should not be called at all
      const sessionSaveCalls = sessionRepo.save.mock.calls;
      expect(sessionSaveCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------
  // getSessions()
  // -----------------------------------------------------------------
  describe('getSessions()', () => {
    it('returns sessions ordered by updatedAt DESC', async () => {
      const mockSessions = [
        { id: 's1', title: 'Recent', updatedAt: new Date() },
        { id: 's2', title: 'Old', updatedAt: new Date() },
      ];
      sessionRepo.find.mockResolvedValue(mockSessions);

      const result = await service.getSessions();

      expect(sessionRepo.find).toHaveBeenCalledWith({
        order: { updatedAt: 'DESC' },
      });
      expect(result).toEqual(mockSessions);
    });
  });

  // -----------------------------------------------------------------
  // getMessages()
  // -----------------------------------------------------------------
  describe('getMessages()', () => {
    it('returns messages for session ordered by createdAt ASC', async () => {
      const mockMessages = [
        { id: 'm1', role: 'user', content: 'Hi', createdAt: new Date() },
        { id: 'm2', role: 'assistant', content: 'Hello!', createdAt: new Date() },
      ];
      messageRepo.find.mockResolvedValue(mockMessages);

      const result = await service.getMessages('session-1');

      expect(messageRepo.find).toHaveBeenCalledWith({
        where: { sessionId: 'session-1' },
        order: { createdAt: 'ASC' },
      });
      expect(result).toEqual(mockMessages);
    });
  });

  // -----------------------------------------------------------------
  // deleteSession()
  // -----------------------------------------------------------------
  describe('deleteSession()', () => {
    it('calls sessionRepo.delete with sessionId', async () => {
      await service.deleteSession('session-to-delete');

      expect(sessionRepo.delete).toHaveBeenCalledWith('session-to-delete');
    });
  });
});
