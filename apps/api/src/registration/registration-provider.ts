import { Injectable } from '@nestjs/common';

export type RegistrationSubmission = {
  merchantId: string;
  legalSubjectReference: string;
  idempotencyKey: string;
};

export type RegistrationProviderStatus = {
  providerCaseId: string;
  status: 'SUBMITTED' | 'PENDING_CONFIRMATION' | 'UNDER_REVIEW' | 'OPENED' | 'FAILED';
  failureReason?: string;
  updatedAt: Date;
};

export interface RegistrationProvider {
  readonly providerName: string;
  readonly enabled: boolean;
  submit(input: RegistrationSubmission): Promise<RegistrationProviderStatus>;
  query(providerCaseId: string): Promise<RegistrationProviderStatus>;
}

@Injectable()
export class UnavailableRegistrationProvider implements RegistrationProvider {
  readonly providerName = 'unconfigured';
  readonly enabled = false;

  private unavailable(): never { throw new Error('商家进件与小程序注册通道尚未签约并启用'); }
  async submit(_input: RegistrationSubmission): Promise<RegistrationProviderStatus> { return this.unavailable(); }
  async query(_providerCaseId: string): Promise<RegistrationProviderStatus> { return this.unavailable(); }
}

export const REGISTRATION_PROVIDER = Symbol('REGISTRATION_PROVIDER');
