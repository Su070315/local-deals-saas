import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CustomerAuthService } from './customer-auth.service';
import { SensitiveDataService } from './sensitive-data.service';
import { WechatPlatformService } from './wechat-platform.service';
import { CustomerProfile } from './domain/customer-profile.entities';

describe('CustomerAuthService', () => {
  function createService() {
    return new CustomerAuthService(
      {} as Repository<CustomerProfile>,
      {} as SensitiveDataService,
      {} as WechatPlatformService,
    );
  }

  const originalEnvironment = process.env.NODE_ENV;
  const originalDemoAuth = process.env.ENABLE_DEMO_CUSTOMER_AUTH;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalAllowDemoMode = process.env.ALLOW_DEMO_MODE;

  afterEach(() => {
    if (originalEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment;
    if (originalDemoAuth === undefined) delete process.env.ENABLE_DEMO_CUSTOMER_AUTH;
    else process.env.ENABLE_DEMO_CUSTOMER_AUTH = originalDemoAuth;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalAllowDemoMode === undefined) delete process.env.ALLOW_DEMO_MODE;
    else process.env.ALLOW_DEMO_MODE = originalAllowDemoMode;
  });

  it('allows a demo customer session only in local or test environments', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    delete process.env.ENABLE_DEMO_CUSTOMER_AUTH;
    delete process.env.ALLOW_DEMO_MODE;
    expect(createService().createDemoSession().token).toBeTruthy();

    process.env.NODE_ENV = 'staging';
    expect(() => createService().createDemoSession()).toThrow(ForbiddenException);

    delete process.env.NODE_ENV;
    process.env.DATABASE_URL = 'postgres://could-be-shared';
    expect(() => createService().createDemoSession()).toThrow(ForbiddenException);

    process.env.NODE_ENV = 'development';
    expect(() => createService().createDemoSession()).toThrow(ForbiddenException);
    process.env.ALLOW_DEMO_MODE = 'true';
    expect(createService().createDemoSession().token).toBeTruthy();
  });

  it('honors an explicit local switch to disable demo customer sessions', () => {
    process.env.NODE_ENV = 'development';
    process.env.ENABLE_DEMO_CUSTOMER_AUTH = 'false';
    expect(() => createService().createDemoSession()).toThrow('演示顾客登录仅允许本地或测试环境');
  });
});
