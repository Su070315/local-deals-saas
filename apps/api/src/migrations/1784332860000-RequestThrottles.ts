import { MigrationInterface, QueryRunner } from 'typeorm';

export class RequestThrottles1784332860000 implements MigrationInterface {
  name = 'RequestThrottles1784332860000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE TABLE IF NOT EXISTS "request_throttles" ("throttleKey" character varying(64) NOT NULL, "hitCount" integer NOT NULL DEFAULT \'0\', "resetAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_853fd3f8599d8c7f167b49f5371" PRIMARY KEY ("throttleKey"))');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_8d649e459e780ac27e27201809" ON "request_throttles" ("resetAt")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "request_throttles"');
  }
}
