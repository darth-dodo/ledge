import { MigrationInterface, QueryRunner } from 'typeorm';

export class ChangeEmbeddingDimension1709700000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the old ivfflat index (requires matching dimension)
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_embeddings_vector"');

    // Truncate existing embeddings (they need re-embedding with new model)
    await queryRunner.query('TRUNCATE TABLE "embeddings"');

    // Alter column dimension from 1024 to 768 (nomic-embed-text)
    await queryRunner.query('ALTER TABLE "embeddings" ALTER COLUMN "embedding" TYPE vector(768)');

    // Recreate the index
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_embeddings_vector"
        ON "embeddings" USING ivfflat ("embedding" vector_cosine_ops)
        WITH (lists = 100)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_embeddings_vector"');
    await queryRunner.query('TRUNCATE TABLE "embeddings"');
    await queryRunner.query(
      'ALTER TABLE "embeddings" ALTER COLUMN "embedding" TYPE vector(1024)',
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_embeddings_vector"
        ON "embeddings" USING ivfflat ("embedding" vector_cosine_ops)
        WITH (lists = 100)
    `);
  }
}
