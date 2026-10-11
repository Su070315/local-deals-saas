import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataType, newDb } from 'pg-mem';
import { randomUUID } from 'crypto';
import { DataSource, DataSourceOptions, Repository } from 'typeorm';
import { AppController, AuthController, PaymentWebhookController, PublicController } from './app.controller';
import { MerchantOperationsController } from './merchant-operations.controller';
import { WechatPlatformController } from './wechat-platform.controller';
import { WechatCallbackController } from './wechat-callback.controller';
import { MediaController } from './media.controller';
import { AuthGuard, CustomerAuthGuard, RoleGuard, StepUpAuthGuard } from './auth';
import { AuthService } from './auth.service';
import { CustomerAuthService } from './customer-auth.service';
import { entities } from './domain/entities';
import { SeedService } from './seed.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MockPaymentProvider, PAYMENT_PROVIDER, UnavailablePaymentProvider } from './payments/payment-provider';
import { HuifuPaymentProvider } from './payments/huifu-payment-provider';
import { TianquePaymentProvider } from './payments/tianque-payment-provider';
import { WechatDirectPaymentProvider } from './payments/wechat-direct-payment-provider';
import { RoutingPaymentProvider } from './payments/routing-payment-provider';
import { Order, MerchantPaymentProfile } from './domain/entities';
import { LifecycleService } from './lifecycle.service';
import { AuditContextMiddleware, AuditContextService } from './audit-context';
import { HealthService } from './health.service';
import { SecurityHeadersMiddleware } from './security-headers.middleware';
import { migrations } from './migrations';
import { RequestThrottleService } from './request-throttle.service';
import { SensitiveDataService } from './sensitive-data.service';
import { AuditChainService } from './audit-chain.service';
import { AuditOutboxService } from './audit-outbox.service';
import { isLocalOrTestEnvironment, postgresPoolOptions, usesEmbeddedDatabase } from './runtime-config';
import { RetryAfterExceptionFilter } from './retry-after.exception-filter';
import { REGISTRATION_PROVIDER, UnavailableRegistrationProvider } from './registration/registration-provider';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';
import { PackageService } from './package.service';
import { SupportTicketService } from './support-ticket.service';
import { AccountingAdjustmentService } from './accounting-adjustment.service';
import { BillingService } from './billing.service';
import { BillPaymentConfirmationService } from './bill-payment-confirmation.service';
import { BatchOperationService } from './batch-operation.service';
import { BatchOperationProcessorService } from './batch-operation-processor.service';
import { StaffBatchOperationService } from './staff-batch-operation.service';
import { VoucherBatchOperationService } from './voucher-batch-operation.service';
import { RefundBatchOperationService } from './refund-batch-operation.service';
import { MerchantImportService } from './merchant-import.service';
import { MerchantAdminInviteService } from './merchant-admin-invite.service';
import { ReportingService } from './reporting.service';
import { ExportService } from './export.service';
import { RefundService } from './refund.service';
import { VerificationService } from './verification.service';
import { PaymentProcessingService } from './payment-processing.service';
import { StoreService } from './store.service';
import { BannerService } from './banner.service';
import { ReservationService } from './reservation.service';
import { StaffService } from './staff.service';
import { CustomerCommerceService } from './customer-commerce.service';
import { MerchantExitService } from './merchant-exit.service';
import { MerchantTemplateService } from './merchant-template.service';
import { RegistrationWorkflowService } from './registration-workflow.service';
import { TenantAdministrationService } from './tenant-administration.service';
import { MerchantPaymentProfileService } from './merchant-payment-profile.service';
import { CommissionRateService } from './commission-rate.service';
import { PlatformWorkQueueService } from './platform-work-queue.service';
import { TransactionReadService } from './transaction-read.service';
import { AuditReadService } from './audit-read.service';
import { LifecycleOrchestrationService } from './lifecycle-orchestration.service';
import { DelayedSettlementService } from './delayed-settlement.service';
import { MerchantOverviewService } from './merchant-overview.service';
import { VoucherFulfillmentService } from './voucher-fulfillment.service';
import { DemoController } from './demo.controller';
import { DemoFixtureService } from './demo-fixture.service';
import { DemoIdentityFixtureService } from './demo-identity-fixture.service';
import { NotificationOutboxService } from './notifications/notification-outbox.service';
import { NotificationAudienceService } from './notifications/notification-audience.service';
import { NotificationOperationsService } from './notifications/notification-operations.service';
import { MockNotificationProvider, NOTIFICATION_PROVIDER, UnavailableNotificationProvider } from './notifications/notification-provider';
import { PlatformRuntimeControlService } from './platform-runtime-control.service';
import { MerchantQueryScopeService } from './merchant-query-scope.service';
import { AgencyCooperationService } from './agency-cooperation.service';
import { MerchantOperationsService } from './merchant-operations.service';
import { WechatPlatformService } from './wechat-platform.service';
import { FaceVerifyService } from './face-verify.service';
import { AppConfigService } from './app-config.service';

const useEmbeddedDatabase = usesEmbeddedDatabase();
const localOnlyControllers = isLocalOrTestEnvironment() ? [DemoController] : [];
const localOnlyProviders = isLocalOrTestEnvironment() ? [DemoFixtureService, DemoIdentityFixtureService] : [];

async function createDataSource(options?: DataSourceOptions) {
  if (!options) throw new Error('数据库配置缺失');
  if (!useEmbeddedDatabase) return new DataSource(options).initialize();
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({ name: 'version', returns: DataType.text, implementation: () => 'PostgreSQL 16.0 (embedded demo)' });
  database.public.registerFunction({ name: 'current_database', returns: DataType.text, implementation: () => 'local_deals_demo' });
  database.public.registerFunction({
    name: 'to_char',
    args: [DataType.timestamp, DataType.text],
    returns: DataType.text,
    implementation: (value: Date, format: string) => {
      if (format !== 'YYYY-MM-DD') throw new Error(`embedded to_char format is not supported: ${format}`);
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    },
  });
  // 内嵌演示库不提供 advisory lock：按真实 Postgres 语义补齐（同进程内重复加锁返回 false），
  // 否则 RefundService.recoverStale / PaymentProcessingService 等"锁保护"路径会因函数缺失直接抛错，
  // 被各自的 catch 静默吞掉 → 本地与测试环境整批退款补偿/支付查单永不执行（表现为 recovered=0）。
  const advisoryLocks = new Set<number>();
  database.public.registerFunction({
    name: 'pg_try_advisory_lock',
    args: [DataType.integer],
    returns: DataType.bool,
    implementation: (lockId: number) => {
      if (advisoryLocks.has(lockId)) return false;
      advisoryLocks.add(lockId);
      return true;
    },
    impure: true,
  });
  database.public.registerFunction({
    name: 'pg_advisory_unlock',
    args: [DataType.integer],
    returns: DataType.bool,
    implementation: (lockId: number) => advisoryLocks.delete(lockId),
    impure: true,
  });
  database.registerExtension('uuid-ossp', (schema) => {
    schema.registerFunction({ name: 'uuid_generate_v4', returns: DataType.uuid, implementation: randomUUID, impure: true });
  });
  return database.adapters.createTypeormDataSource(options).initialize();
}

@Module({
  imports: [TypeOrmModule.forRootAsync({
    useFactory: () => ({
      type: 'postgres' as const,
      ...(useEmbeddedDatabase ? {} : { url: process.env.DATABASE_URL, extra: postgresPoolOptions() }),
      entities,
      migrations,
      // A real database changes schema only through the explicit migration runner.
      synchronize: useEmbeddedDatabase,
      migrationsRun: false,
      migrationsTransactionMode: 'all',
      logging: false,
    }),
    dataSourceFactory: createDataSource,
  }), TypeOrmModule.forFeature(entities)],
  controllers: [PublicController, PaymentWebhookController, AuthController, AppController, MerchantOperationsController, WechatPlatformController, WechatCallbackController, MediaController, ...localOnlyControllers],
  providers: [
    CustomerCommerceService, MerchantExitService, MerchantTemplateService, RegistrationWorkflowService, TenantAdministrationService, MerchantPaymentProfileService, AgencyCooperationService, MerchantOperationsService, WechatPlatformService, FaceVerifyService, AppConfigService, MerchantImportService, MerchantAdminInviteService, CommissionRateService, PlatformWorkQueueService, PlatformRuntimeControlService, MerchantQueryScopeService, TransactionReadService, AuditReadService, LifecycleOrchestrationService, DelayedSettlementService, MerchantOverviewService, VoucherFulfillmentService, VoucherBatchOperationService, RefundBatchOperationService, PackageService, StoreService, BannerService, ReservationService, StaffService, StaffBatchOperationService, SupportTicketService, AccountingAdjustmentService, BillingService, BillPaymentConfirmationService, BatchOperationProcessorService, BatchOperationService, ReportingService, ExportService, RefundService, VerificationService, PaymentProcessingService, AuthService, CustomerAuthService, RequestThrottleService, SensitiveDataService, AuditChainService, AuditOutboxService, AuditWriterService, MerchantAccessService, HealthService, AuditContextService,
    AuditContextMiddleware, SecurityHeadersMiddleware, AuthGuard, CustomerAuthGuard, RoleGuard, StepUpAuthGuard, SeedService, LifecycleService, MockPaymentProvider, UnavailablePaymentProvider, HuifuPaymentProvider, UnavailableRegistrationProvider, MockNotificationProvider, UnavailableNotificationProvider, NotificationOutboxService, NotificationAudienceService, NotificationOperationsService, ...localOnlyProviders,
    { provide: APP_FILTER, useClass: RetryAfterExceptionFilter },
    {
      provide: PAYMENT_PROVIDER,
      inject: [MockPaymentProvider, UnavailablePaymentProvider, getRepositoryToken(Order), DataSource, SensitiveDataService],
      useFactory: (mock: MockPaymentProvider, unavailable: UnavailablePaymentProvider, orders: Repository<Order>, dataSource: DataSource, sensitiveData: SensitiveDataService) => {
        if (isLocalOrTestEnvironment()) return mock;
        try {
          // 多渠道路由：按商家支付档案在微信直连 / 汇付 / 天阙之间分发；任一渠道配置不全会回退单渠道
          // 汇付/天阙/微信直连均支持多租户直连：按商户档案解析各自凭据（Repository 查询 + 加密解密）
          const profileRepo = dataSource.getRepository(MerchantPaymentProfile);
          return new RoutingPaymentProvider(
            new TianquePaymentProvider(orders, profileRepo, sensitiveData),
            new WechatDirectPaymentProvider(orders, profileRepo, sensitiveData),
            new HuifuPaymentProvider(profileRepo, sensitiveData),
          );
        } catch { return unavailable; }
      },
    },
    { provide: REGISTRATION_PROVIDER, useExisting: UnavailableRegistrationProvider },
    {
      provide: NOTIFICATION_PROVIDER,
      inject: [MockNotificationProvider, UnavailableNotificationProvider],
      useFactory: (mock: MockNotificationProvider, unavailable: UnavailableNotificationProvider) => isLocalOrTestEnvironment() ? mock : unavailable,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SecurityHeadersMiddleware, AuditContextMiddleware).forRoutes('{*path}');
  }
}
