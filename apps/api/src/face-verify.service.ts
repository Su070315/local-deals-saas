import { BadGatewayException, BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createHmac, randomUUID } from 'crypto';

@Injectable()
export class FaceVerifyService {
  private readonly secretId: string;
  private readonly secretKey: string;
  private readonly endpoint = 'faceid.tencentcloudapi.com';
  private readonly region = 'ap-guangzhou';
  private readonly service = 'faceid';
  private readonly version = '2018-03-01';

  constructor() {
    this.secretId = (process.env.TENCENT_COS_SECRET_ID || '').trim();
    this.secretKey = (process.env.TENCENT_COS_SECRET_KEY || '').trim();
    if (!this.secretId || !this.secretKey) {
      // Don't throw here, throw when methods are called
    }
  }

  /** 生成人脸核验 BizToken，供小程序端调起腾讯云慧眼 */
  async createBizToken(name: string, idCardNumber: string): Promise<{ bizToken: string; requestId: string }> {
    this.assertConfigured();
    if (!name?.trim() || !/^\d{17}[\dXx]$/.test(idCardNumber)) {
      throw new BadRequestException('姓名和身份证号格式不正确');
    }

    const action = 'DetectAuth';
    const body: Record<string, unknown> = {
      RuleId: '0',
      IdCard: idCardNumber.trim(),
      Name: name.trim(),
    };

    const response = await this.callFaceid(action, body);
    return {
      bizToken: this.responseString(response, 'BizToken', 8, 128),
      requestId: this.responseString(response, 'RequestId', 8, 128),
    };
  }

  /** 查询人脸核验结果 */
  async getVerifyResult(bizToken: string): Promise<{ passed: boolean; message: string }> {
    this.assertConfigured();
    if (!bizToken || bizToken.length < 8) throw new BadRequestException('BizToken 格式不正确');

    const action = 'GetDetectInfo';
    const response = await this.callFaceid(action, {
      BizToken: bizToken,
      InfoType: '0', // 0 = 完整信息
    });

    const result = this.responseString(response, 'Result', 1, 16);
    const desc = this.responseString(response, 'Description', 0, 256);
    return {
      passed: result === '0',
      message: desc || (result === '0' ? '核验通过' : '核验未通过'),
    };
  }

  // ==========================================================================
  // 内部：腾讯云 API v3 签名调用
  // ==========================================================================

  private assertConfigured(): void {
    if (!this.secretId || !this.secretKey) {
      throw new ServiceUnavailableException('腾讯云人脸核验未配置访问凭据，请在 .env 中填入 TENCENT_COS_SECRET_ID 和 TENCENT_COS_SECRET_KEY');
    }
  }

  private async callFaceid(action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payload = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, '-');
    const signedHeaders = 'content-type;host';
    const canonicalHeaders = `content-type:application/json\nhost:${this.endpoint}\n`;
    const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${createHash('sha256').update(payload).digest('hex')}`;
    const algorithm = 'TC3-HMAC-SHA256';
    const credentialScope = `${date}/${this.service}/tc3_request`;
    const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`;

    const kDate = createHmac('sha256', `TC3${this.secretKey}`).update(date).digest();
    const kService = createHmac('sha256', kDate).update(this.service).digest();
    const kSigning = createHmac('sha256', kService).update('tc3_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const authorization = `${algorithm} Credential=${this.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    let response: Response;
    try {
      response = await fetch(`https://${this.endpoint}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Host': this.endpoint,
          'X-TC-Action': action,
          'X-TC-Version': this.version,
          'X-TC-Timestamp': String(timestamp),
          'X-TC-Region': this.region,
          'Authorization': authorization,
        },
        body: payload,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ServiceUnavailableException('暂时无法连接腾讯云人脸核验服务');
    }

    const text = await response.text();
    let value: { Response?: { Error?: { Code?: string; Message?: string }; [key: string]: unknown } };
    try { value = JSON.parse(text); } catch { throw new BadGatewayException('腾讯云人脸核验响应格式异常'); }

    if (!value.Response) throw new BadGatewayException('腾讯云人脸核验响应为空');
    if (value.Response.Error) {
      throw new BadGatewayException(`腾讯云人脸核验返回错误（${value.Response.Error.Code}）：${value.Response.Error.Message || '未知错误'}`);
    }

    return value.Response as Record<string, unknown>;
  }

  private responseString(value: Record<string, unknown>, field: string, minLen: number, maxLen: number): string {
    const result = value[field];
    if (typeof result !== 'string' || result.length < minLen || result.length > maxLen) {
      throw new BadGatewayException(`腾讯云人脸核验响应字段 ${field} 不合法`);
    }
    return result;
  }
}
