import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * 商家小程序动态配置。
 * 保存小程序端 /public/miniprogram/bootstrap 下发的 config JSON，
 * 商家在管理端"页面装修"里可视化编辑后写回此表，小程序端动态渲染。
 */
@Entity('merchant_app_configs')
export class MerchantAppConfig {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'uuid' }) merchantId: string;
  @Column({ type: 'integer', default: 1 }) configVersion: number;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) config: Record<string, unknown>;
  @Column({ type: 'uuid', nullable: true }) updatedBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

export const appConfigEntities = [MerchantAppConfig];
