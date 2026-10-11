import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuthGuard, CurrentUser, RoleGuard, Roles } from './auth';
import { DemoFixtureService } from './demo-fixture.service';
import { DemoIdentityFixtureService } from './demo-identity-fixture.service';
import { User, UserRole } from './domain/entities';
import { API_CONTROLLER_VERSION } from './api-versioning';

class CreateDemoBillDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) period: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) verifiedAmountFen: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) serviceFeeFen: number;
}

class CreateDemoFinanceUserDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsEmail() @MaxLength(254) email: string;
  @IsString() @MinLength(10) @MaxLength(512) password: string;
}

@ApiExcludeController()
@Controller({ path: 'demo', version: API_CONTROLLER_VERSION })
@UseGuards(AuthGuard, RoleGuard)
export class DemoController {
  constructor(private readonly fixtures: DemoFixtureService, private readonly identities: DemoIdentityFixtureService) {}

  @Post('platform-finance-users')
  @Roles(UserRole.PLATFORM_ADMIN)
  createFinanceUser(@CurrentUser() user: User, @Body() body: CreateDemoFinanceUserDto) {
    return this.identities.createFinanceUser(user, body);
  }

  @Post('platform-operations-users')
  @Roles(UserRole.PLATFORM_ADMIN)
  createOperationsUser(@CurrentUser() user: User, @Body() body: CreateDemoFinanceUserDto) {
    return this.identities.createOperationsUser(user, body);
  }

  @Post('merchants/:merchantId/dispute-window-bills')
  @Roles(UserRole.PLATFORM_ADMIN)
  createDisputeWindowBill(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: CreateDemoBillDto) {
    return this.fixtures.createDisputeWindowBill(user, merchantId, body);
  }
}
