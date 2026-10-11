import 'reflect-metadata';
import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { HealthService } from './health.service';
import { SensitiveDataService } from './sensitive-data.service';
import { SeedService } from './seed.service';
import { allowedCorsOrigins, assertSharedRuntimeConfiguration, shouldSeedDemoData, trustedProxyHops } from './runtime-config';
import { configureApiVersioning } from './api-versioning';

async function bootstrap() {
  assertSharedRuntimeConfiguration();
  if (process.env.NODE_ENV === 'production' && process.env.USE_PG_MEM === 'true') throw new Error('生产环境禁止使用内嵌演示数据库');
  // Payment signatures cover the exact bytes sent by the provider. Nest keeps
  // that immutable body separately from the parsed DTO body for the webhook.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // 基本资料/备案等接口会传 base64 图片数据（后端限制单图 ≤2MB，base64 后约 2.7MB），
  // 默认 100kb 会 413 request entity too large，这里放宽到 10mb
  app.useBodyParser('json', { limit: '10mb' });
  const proxyHops = trustedProxyHops();
  if (proxyHops) app.set('trust proxy', proxyHops);
  app.get(SensitiveDataService).assertConfigured();
  const health = app.get(HealthService);
  const beginDraining = () => health.markDraining();
  process.once('SIGTERM', beginDraining);
  process.once('SIGINT', beginDraining);
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  app.enableCors({ origin: allowedCorsOrigins(), credentials: false, exposedHeaders: ['Retry-After', 'X-Request-Id', 'X-Release-Id', 'Deprecation', 'Sunset', 'Link'] });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api');
  configureApiVersioning(app);
  if (shouldSeedDemoData()) await app.get(SeedService).seed();
  await app.listen(Number(process.env.PORT || 3001));
}
bootstrap();
