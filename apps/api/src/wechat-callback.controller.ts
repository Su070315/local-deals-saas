import { BadRequestException, Controller, Get, HttpCode, Param, Post, Query, Req, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { createDecipheriv, createHash } from 'crypto';
import { text } from 'express';
import type { Request, Response } from 'express';
import { WechatPlatformService } from './wechat-platform.service';

@Controller({ path: 'wechat', version: VERSION_NEUTRAL })
export class WechatCallbackController {
  constructor(private readonly wechat: WechatPlatformService) {}

  /** 微信 URL 验证：收到 GET 请求时解密 echostr 并返回原文字符串 */
  @Get('callback')
  async verifyCallbackUrl(@Req() request: Request, @Res() response: Response) {
    const q = request.query as Record<string, string | undefined>;
    const sig = q.msg_signature || q.signature;
    const ts = q.timestamp;
    const nc = q.nonce;
    const echo = q.echostr;

    console.log('[WECHAT_VERIFY]', JSON.stringify({ sig: !!sig, ts: !!ts, nc: !!nc, echo: !!echo }));

    if (!sig || !ts || !nc || !echo) {
      response.type('text/plain').send(echo || 'ok');
      return;
    }

    const token = this.requiredEnv('WECHAT_COMPONENT_TOKEN');
    const aesKey = this.requiredEnv('WECHAT_COMPONENT_ENCODING_AES_KEY');
    try {
      const decrypted = this.decryptEchostr(echo, aesKey);
      this.verifyCallbackSignature(token, ts, nc, echo, sig);
      response.type('text/plain').send(decrypted);
    } catch (e) {
      console.log('[WECHAT_VERIFY] error:', (e as Error).message);
      response.type('text/plain').send(echo);
    }
  }

  @Get('authorization/callback')
  async authorizationCallback(@Query('auth_code') authCode: string | undefined, @Query('state') state: string | undefined, @Res() response: Response) {
    console.log('[WECHAT_AUTH_CALLBACK] auth_code=', JSON.stringify(authCode), 'len=', String(authCode || '').length, 'state=', JSON.stringify(state), 'stateLen=', String(state || '').length);
    const result = await this.wechat.completeAuthorization(this.required(authCode), this.required(state));
    response.redirect(303, result.redirectUrl);
  }

  @Post('callback') @HttpCode(200)
  async componentCallback(@Req() request: Request, @Res() response: Response) {
    text({ type: 'text/xml', limit: '1mb' })(request, response, async () => {
      const q = request.query as Record<string, string | undefined>;
      const rawBody = typeof request.body === 'string' ? Buffer.from(request.body, 'utf8') : Buffer.alloc(0);
      console.log('[WECHAT_POST] bodyLen:', rawBody.length);
      try {
        await this.wechat.receiveCallback(rawBody, q.msg_signature || q.signature || '', q.timestamp || '', q.nonce || '');
        response.status(200).send('success');
      } catch (e) {
        console.log('[WECHAT_POST] FAIL - returning fail to WeChat so it retries:', (e as Error).message);
        response.status(200).send('fail');
      }
    });
  }

  @Post(':appId/callback') @HttpCode(200)
  async authorizerCallback(@Req() request: Request, @Res() response: Response, @Param('appId') appId: string) {
    text({ type: 'text/xml', limit: '1mb' })(request, response, async () => {
      const q = request.query as Record<string, string | undefined>;
      const rawBody = typeof request.body === 'string' ? Buffer.from(request.body, 'utf8') : Buffer.alloc(0);
      try {
        await this.wechat.receiveCallback(rawBody, q.msg_signature || q.signature || '', q.timestamp || '', q.nonce || '', appId);
        response.status(200).send('success');
      } catch (e) {
        console.log('[WECHAT_POST] FAIL - returning fail to WeChat so it retries:', (e as Error).message);
        response.status(200).send('fail');
      }
    });
  }

  private required(value?: string, name = '参数') { if (!value) throw new BadRequestException(`微信回调${name}缺失`); return value; }
  private requiredEnv(name: string) { const v = (process.env[name] || '').trim(); if (!v) throw new BadRequestException(`微信${name}尚未配置`); return v; }

  private decryptEchostr(encrypted: string, encodingAesKey: string): string {
    const key = Buffer.from(`${encodingAesKey}=`, 'base64');
    if (key.length !== 32) throw new BadRequestException('微信消息加解密 Key 配置错误');
    try {
      const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
      decipher.setAutoPadding(false);
      const padded = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
      const padding = padded[padded.length - 1];
      if (!padding || padding > 32 || padding > padded.length) throw new Error('invalid');
      for (let i = padded.length - padding; i < padded.length; i++) if (padded[i] !== padding) throw new Error('invalid');
      const value = padded.subarray(0, padded.length - padding);
      if (value.length < 24) throw new Error('invalid');
      const msgLen = value.readUInt32BE(16);
      if (msgLen < 1 || msgLen > value.length - 20) throw new Error('invalid');
      return value.subarray(20, 20 + msgLen).toString('utf8');
    } catch { throw new BadRequestException('微信回调解密失败'); }
  }

  private verifyCallbackSignature(token: string, timestamp: string, nonce: string, encrypted: string, signature: string) {
    if (!/^[a-fA-F0-9]{40}$/.test(signature)) throw new BadRequestException('微信回调签名格式错误');
    const expected = createHash('sha1').update([token, timestamp, nonce, encrypted].sort().join('')).digest('hex');
    // P0-3：签名必须匹配，不匹配直接拒绝（修复"allow through for now"放行导致的验签形同虚设）
    if (!expected || expected.toLowerCase() !== signature.toLowerCase()) {
      throw new BadRequestException('微信回调签名校验失败');
    }
  }
}
