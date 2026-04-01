import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Statement } from './entities/statement.entity';
import type { ParserInterface, ParsedTransaction } from './parsers/parser.interface.js';
import { TransactionsService } from '../transactions/transactions.service';
import { LlmService } from '../llm/llm.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import * as fs from 'fs/promises';
import * as path from 'path';

@Injectable()
export class UploadService {
  constructor(
    @InjectRepository(Statement)
    private readonly statementRepo: Repository<Statement>,
    @Inject('PARSERS')
    private readonly parsers: ParserInterface[],
    @Inject(TransactionsService)
    private readonly transactionsService: TransactionsService,
    @Inject(LlmService)
    private readonly llmService: LlmService,
    @Inject(EmbeddingsService)
    private readonly embeddingsService: EmbeddingsService,
  ) {}

  async createStatement(file: Express.Multer.File, uploadDir?: string): Promise<Statement> {
    const statement = this.statementRepo.create({
      filename: file.originalname,
      fileType: this.extractFileType(file.originalname),
      filePath: file.filename,
      fileSize: file.size,
    });

    const saved = await this.statementRepo.save(statement);

    if (uploadDir) {
      try {
        await this.processFile(saved, uploadDir);
      } catch {
        // Parsing/categorization failure should not block the upload
      }
    }

    return saved;
  }

  async processFile(statement: Statement, uploadDir: string): Promise<void> {
    const parsed = await this.parseFile(statement, uploadDir);
    if (parsed.length === 0) return;

    await this.statementRepo.save(statement);

    const descriptions = parsed.map((t) => t.description);
    const categories = await this.llmService.categorize(descriptions);

    // Delete existing transactions for idempotency (re-upload)
    await this.transactionsService.removeByStatement(statement.id);

    const transactionsData = parsed.map((t, i) => ({
      date: t.date,
      description: t.description,
      amount: t.amount,
      type: t.type,
      category: categories[i] ?? undefined,
    }));

    await this.transactionsService.createMany(statement.id, transactionsData);

    // Chunk and embed the raw text for RAG search
    if (statement.rawText) {
      try {
        await this.embeddingsService.embedStatement(statement.id, statement.rawText);
      } catch {
        // Embedding failure should not block the upload
      }
    }
  }

  async parseFile(statement: Statement, uploadDir: string): Promise<ParsedTransaction[]> {
    const filePath = path.join(uploadDir, statement.filePath);
    const buffer = await fs.readFile(filePath);

    const parser = this.parsers.find((p) => p.canParse(buffer, statement.filename));

    if (!parser) {
      return [];
    }

    const transactions = await parser.parse(buffer);
    statement.rawText = buffer.toString('utf-8');

    return transactions;
  }

  async findAll(): Promise<Statement[]> {
    return this.statementRepo.find({
      order: { uploadedAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Statement> {
    const statement = await this.statementRepo.findOne({ where: { id } });
    if (!statement) {
      throw new NotFoundException(`Statement ${id} not found`);
    }
    return statement;
  }

  async remove(id: string, uploadDir: string): Promise<void> {
    const statement = await this.findOne(id);

    const filePath = path.join(uploadDir, statement.filePath);
    try {
      await fs.unlink(filePath);
    } catch {
      // File may already be deleted — proceed with DB cleanup
    }

    await this.statementRepo.remove(statement);
  }

  async purgeAll(uploadDir: string): Promise<void> {
    // Delete all files from disk
    const statements = await this.statementRepo.find();
    for (const statement of statements) {
      const filePath = path.join(uploadDir, statement.filePath);
      try {
        await fs.unlink(filePath);
      } catch {
        // File may already be deleted
      }
    }

    // Clear all tables in dependency order
    await this.statementRepo.query(
      'TRUNCATE transactions, embeddings, chat_messages, chat_sessions, statements CASCADE',
    );
  }

  private extractFileType(filename: string): string {
    const ext = path.extname(filename).toLowerCase().slice(1);
    return ext === 'pdf' ? 'pdf' : 'csv';
  }
}
