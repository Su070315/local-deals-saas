import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * 顾客档案：保存微信顾客的手机号授权信息。
 * openid 用哈希索引标识，手机号完整值加密存储，只暴露掩码。
 */
@Entity('customer_profiles')
export class CustomerProfile {
  @PrimaryColumn({ type: 'varchar', length: 64 }) openidHash: string;
  /** 来源商家（多租户归属；可空=平台级/未归属，仅平台可读） */
  @Index() @Column({ type: 'uuid', nullable: true }) merchantId: string | null;
  /** 来源小程序 APPID（openid 按 appid 维度天然隔离，显式记录便于归属与审计） */
  @Index() @Column({ type: 'varchar', length: 32, default: '' }) appId: string;
  /** 原始 openid 加密存储：微信 JSAPI 支付需传给汇付定位付款人，不落明文 */
  @Column({ type: 'text', default: '' }) openidCiphertext: string;
  @Column({ type: 'text', default: '' }) phoneCiphertext: string;
  @Column({ type: 'varchar', length: 32, default: '' }) phoneMasked: string;
  @Column({ type: 'timestamptz', nullable: true }) phoneAuthorizedAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

export const customerProfileEntities = [CustomerProfile];
