import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Ollama } from 'ollama';
import { Embedding } from './entities/embedding.entity';
import { ChunkerService } from './chunker.service';

const EMBEDDING_MODEL = 'nomic-embed-text';

@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);
  private readonly client: Ollama;
  private ollamaAvailable: boolean | null = null;

  constructor(
    @InjectRepository(Embedding)
    private readonly embeddingRepo: Repository<Embedding>,
    @Inject(ChunkerService)
    private readonly chunkerService: ChunkerService,
    @Inject(DataSource)
    private readonly dataSource: DataSource,
  ) {
    const host = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.client = new Ollama({ host });
  }

  private async checkAvailability(): Promise<boolean> {
    if (this.ollamaAvailable !== null) return this.ollamaAvailable;

    try {
      await this.client.list();
      this.ollamaAvailable = true;
      this.logger.log('Ollama connection established');
    } catch {
      this.ollamaAvailable = false;
      this.logger.warn('Ollama not available — embeddings will be disabled');
    }
    return this.ollamaAvailable;
  }

  async embedStatement(statementId: string, rawText: string): Promise<void> {
    const available = await this.checkAvailability();
    if (!available) {
      this.logger.warn('Skipping embedding — Ollama not available');
      return;
    }

    if (!rawText || rawText.trim().length === 0) {
      this.logger.warn(`Statement ${statementId} has no text to embed`);
      return;
    }

    // Delete existing embeddings for idempotency
    await this.removeByStatement(statementId);

    // Chunk the text
    const chunks = this.chunkerService.chunk(rawText);
    if (chunks.length === 0) return;

    // Get embeddings from Ollama
    const vectors = await this.getEmbeddings(chunks.map((c) => c.content));
    if (!vectors) return;

    // Persist chunks + embeddings
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const embedding = this.embeddingRepo.create({
        statementId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
      });
      const saved = await this.embeddingRepo.save(embedding);

      // Update the vector column via raw SQL (TypeORM cannot handle pgvector type)
      const vector = vectors[i];
      if (vector) {
        const vectorStr = `[${vector.join(',')}]`;
        await this.dataSource.query('UPDATE embeddings SET embedding = $1::vector WHERE id = $2', [
          vectorStr,
          saved.id,
        ]);
      }
    }

    this.logger.log(`Embedded ${chunks.length} chunks for statement ${statementId}`);
  }

  async removeByStatement(statementId: string): Promise<void> {
    await this.embeddingRepo.delete({ statementId });
  }

  async similaritySearch(
    queryVector: number[],
    limit = 5,
  ): Promise<
    Array<{
      id: string;
      content: string;
      statementId: string;
      distance: number;
    }>
  > {
    const vectorStr = `[${queryVector.join(',')}]`;
    const results = await this.dataSource.query(
      `SELECT id, content, statement_id as "statementId",
              embedding <=> $1::vector as distance
       FROM embeddings
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vectorStr, limit],
    );
    return results;
  }

  async getEmbeddings(texts: string[]): Promise<number[][] | null> {
    const available = await this.checkAvailability();
    if (!available || texts.length === 0) return null;

    try {
      const response = await this.client.embed({
        model: EMBEDDING_MODEL,
        input: texts,
      });

      return response.embeddings;
    } catch (error) {
      this.logger.error(
        `Embedding failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async getQueryEmbedding(query: string): Promise<number[] | null> {
    const result = await this.getEmbeddings([query]);
    return result?.[0] ?? null;
  }
}
