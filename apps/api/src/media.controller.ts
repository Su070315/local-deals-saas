import { BadRequestException, Controller, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { memoryStorage } from 'multer';
import { API_CONTROLLER_VERSION } from './api-versioning';
import { AuthGuard, CurrentUser, RoleGuard, Roles } from './auth';
import { PlatformAccessProfile, User, UserRole } from './domain/entities';
import { MerchantAccessService } from './merchant-access.service';

const MEDIA_ROOT = process.env.MEDIA_UPLOAD_DIR || '/home/ubuntu/saas-uploads';
const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 上传图片文件的运行时形态（multer 类型声明与全局 Express 命名空间不兼容，用局部最小类型） */
type UploadedImageFile = { buffer: Buffer; originalname: string; mimetype: string };

/** S1：图片魔数嗅探（文件头检测真实类型），扩展名与魔数不符时拒绝，防伪装内容 */
function detectImageMagic(buffer: Buffer): { ext: string; mime: string } | null {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return { ext: '.png', mime: 'image/png' };
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return { ext: '.gif', mime: 'image/gif' };
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return { ext: '.webp', mime: 'image/webp' };
  return null;
}

type CosSdk = {
  putObject: (params: unknown, callback: (err: Error | null, data?: unknown) => void) => void;
};

/**
 * 商户端/平台端通用图片上传：
 * - 优先转存腾讯云 COS（对象级 public-read，返回 COS 公网 HTTPS URL，供小程序/网页直接展示）
 * - COS 未配置时回退服务器磁盘（Caddy 以 /uploads 静态托管）
 * - 仅允许 jpg/png/webp/gif，单张 ≤ 5MB
 * - 权限：平台/代理/商户管理员，且必须属于该 merchantId
 */
@Controller({ path: 'media', version: API_CONTROLLER_VERSION })
@UseGuards(AuthGuard, RoleGuard)
export class MediaController {
  constructor(private readonly merchantAccess: MerchantAccessService) {}

  @Post('images')
  @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN)
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES },
    fileFilter: (_req, file, callback) => {
      const ext = extname(String(file.originalname || '')).toLowerCase();
      if (!ALLOWED_IMAGE_EXT.has(ext)) {
        callback(new BadRequestException('仅支持 jpg/png/webp/gif 格式的图片'), false);
        return;
      }
      callback(null, true);
    },
  }))
  async uploadImage(
    @CurrentUser() user: User,
    @Query('merchantId') merchantId: string,
    @Query('category') category?: string,
    @UploadedFile() file?: UploadedImageFile,
  ): Promise<{ url: string; filename: string }> {
    if (!merchantId) throw new BadRequestException('缺少 merchantId');
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.COMPLIANCE]);
    if (!file || !file.buffer || !file.buffer.length) throw new BadRequestException('未收到上传文件');
    // S1：魔数嗅探——按文件头判定真实图片类型，扩展名与魔数不符拒绝（防 .jpg 伪装 HTML 存储型 XSS）
    const detected = detectImageMagic(file.buffer);
    const ext = extname(String(file.originalname || '')).toLowerCase();
    if (!detected || !ALLOWED_IMAGE_EXT.has(ext) || detected.ext !== ext) {
      throw new BadRequestException(`图片内容与扩展名不符（${ext} vs ${detected?.ext || '未知'}），已拒绝`);
    }
    const contentType = detected.mime;
    // 私密类目（证件/人脸/资质）：桶私有 + 签名 URL，禁止公开读
    const normalizedCategory = String(category || '').trim().replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
    const isPrivate = ['license', 'face', 'idcard', 'qualification'].includes(normalizedCategory);
    const cos = this.cosSdk();
    if (cos) {
      const objectKey = [
        'merchant-assets', merchantId, isPrivate ? normalizedCategory : 'products',
        new Date().toISOString().slice(0, 7),
        `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`,
      ].join('/');
      await new Promise<void>((resolve, reject) => {
        cos.putObject({
          Bucket: this.cosBucket(),
          Region: this.cosRegion(),
          Key: objectKey,
          Body: file.buffer,
          // ContentType 按魔数嗅探结果强制，不信任客户端 mimetype
          ContentType: contentType,
          // 公开素材（products 等）对象级公开读；私密素材保持桶私有
          ...(isPrivate ? {} : { ACL: 'public-read' as const }),
        }, (err) => {
          if (err) reject(new BadRequestException(`图片上传到对象存储失败：${err.message}`));
          else resolve();
        });
      });
      if (isPrivate) {
        // 私密素材：签发 5 分钟时效的临时访问 URL，不暴露公网永久地址
        // （cos-nodejs-sdk-v5 类型声明缺失 getObjectUrl，运行时存在，此处做最小类型断言）
        const signedUrl = await new Promise<string>((resolve, reject) => {
          (cos as unknown as { getObjectUrl: (params: Record<string, unknown>, cb: (err: Error | null, data?: { Url?: string }) => void) => void }).getObjectUrl({
            Bucket: this.cosBucket(),
            Region: this.cosRegion(),
            Key: objectKey,
            Sign: true,
            Expires: 300,
          }, (err, data) => {
            if (err || !data?.Url) reject(new BadRequestException('私密素材签名 URL 生成失败'));
            else resolve(data.Url as string);
          });
        });
        return { url: signedUrl, filename: objectKey };
      }
      const host = `${this.cosBucket()}.cos.${this.cosRegion()}.myqcloud.com`;
      return { url: `https://${host}/${objectKey}`, filename: objectKey };
    }
    // 回退：存服务器磁盘（Caddy /uploads 托管）；ext 已在函数顶部声明（魔数嗅探），复用
    if (!existsSync(MEDIA_ROOT)) mkdirSync(MEDIA_ROOT, { recursive: true });
    const filename = `${randomUUID()}${ext}`;
    writeFileSync(`${MEDIA_ROOT}/${filename}`, file.buffer);
    const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || 'https://example.com';
    return { url: `${base}/uploads/${filename}`, filename };
  }

  /** COS 是否已配置（SecretId/SecretKey/Bucket/Region 齐全才启用，否则回退磁盘） */
  private cosSdk(): CosSdk | null {
    const secretId = String(process.env.TENCENT_COS_SECRET_ID || '').trim().replace(/^"|"$/g, '');
    const secretKey = String(process.env.TENCENT_COS_SECRET_KEY || '').trim().replace(/^"|"$/g, '');
    if (!secretId || !secretKey || !this.cosBucket() || !this.cosRegion()) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const COS = require('cos-nodejs-sdk-v5') as new (options: { SecretId: string; SecretKey: string }) => CosSdk;
    return new COS({ SecretId: secretId, SecretKey: secretKey });
  }

  private cosBucket(): string {
    return String(process.env.TENCENT_COS_BUCKET || '').trim().replace(/^"|"$/g, '');
  }

  private cosRegion(): string {
    return String(process.env.TENCENT_COS_REGION || 'ap-guangzhou').trim().replace(/^"|"$/g, '');
  }

  /** 健康自检用：确认上传目录可用（可选） */
  @Post('images/_probe')
  @Roles(UserRole.PLATFORM_ADMIN)
  probe() {
    return { root: MEDIA_ROOT, ready: existsSync(MEDIA_ROOT), cos: this.cosSdk() ? 'configured' : 'fallback-disk' };
  }
}
