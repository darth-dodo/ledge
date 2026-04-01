import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { Statement } from './entities/statement.entity';
import { CsvParser } from './parsers/csv.parser';
import { PdfParser } from './parsers/pdf.parser';
import { TransactionsModule } from '../transactions/transactions.module';
import { LlmModule } from '../llm/llm.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Statement]),
    TransactionsModule,
    LlmModule,
    EmbeddingsModule,
  ],
  controllers: [UploadController],
  providers: [
    UploadService,
    { provide: 'PARSERS', useFactory: () => [new CsvParser(), new PdfParser()] },
  ],
  exports: [UploadService],
})
export class UploadModule {}
