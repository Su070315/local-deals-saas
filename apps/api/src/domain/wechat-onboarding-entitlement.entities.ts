import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum WechatOnboardingEntitlementEventType {
  STARTED = 'ONBOARDING_STARTED',
  PUBLISHABLE = 'ONBOARDING_PUBLISHABLE',
  TERMINATED = 'ONBOARDING_TERMINATED',
}

@Entity('wechat_onboarding_entitlement_events')
@Index('UQ_wechat_onboarding_entitlement_merchant_event', ['merchantId', 'eventType'], { unique: true })
export class WechatOnboardingEntitlementEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'varchar', length: 64 }) eventType: WechatOnboardingEntitlementEventType;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) payload: Record<string, unknown>;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

export const wechatOnboardingEntitlementEntities = [WechatOnboardingEntitlementEvent];
