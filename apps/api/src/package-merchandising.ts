import { BadRequestException } from '@nestjs/common';

export type PackageMerchandisingFields = {
  productType: 'STANDARD' | 'GROUP_BUY' | 'WEIGHED' | 'MULTI_SPEC';
  skuCode: string;
  barcode: string;
  recommendation: string;
  coverImageUrl: string | null;
  galleryUrls: string[];
  videoUrl: string | null;
  originalPriceFen: number | null;
  memberPriceFen: number | null;
  purchasePriceFen: number | null;
  categoryName: string;
  /** 所属商品分类（关联 merchant-operations settings type=PRODUCT_CATEGORY 的 id 列表，多对多；删除分类仅解除关联） */
  categoryIds: string[];
  unit: string;
  minPurchaseQuantity: number;
  virtualSales: number;
  tags: string[];
  fulfillmentMethods: Array<'STORE_PICKUP' | 'LOCAL_DELIVERY' | 'EXPRESS'>;
  distributionEnabled: boolean;
  batchManaged: boolean;
  pointsEnabled: boolean;
  inventoryEnabled: boolean;
  inventoryWarningThreshold: number;
  salesChannels: Array<'ONLINE' | 'OFFLINE'>;
  guaranteeLabels: string[];
  parameterValues: string[];
  purchaseNotes: string;
  usageRules: string;
  detailContent: string;
};

type PackageMerchandisingInput = Partial<PackageMerchandisingFields>;

function text(value: unknown, label: string, maxLength: number): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符`);
  return normalized;
}

function safeCoverImageUrl(value: string): string | null {
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const parsed = new URL(value);
    const localHttp = ['localhost', '127.0.0.1'].includes(parsed.hostname) && parsed.protocol === 'http:';
    return parsed.protocol === 'https:' || localHttp ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function optionalAmount(value: unknown, label: string, maximum: number): number | null {
  if (value === null || value === undefined || value === '' || value === 0) return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > maximum) throw new BadRequestException(`${label}必须是有效金额`);
  return amount;
}

function integer(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new BadRequestException(`${label}必须为 ${minimum} 至 ${maximum} 的整数`);
  return number;
}

function stringList(value: unknown, label: string, maximum: number, itemLength: number): string[] {
  const values = [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean))];
  if (values.length > maximum || values.some((item) => item.length > itemLength)) throw new BadRequestException(`${label}最多 ${maximum} 项且每项不超过 ${itemLength} 个字符`);
  return values;
}

function enumList<T extends string>(value: unknown, allowed: readonly T[], fallback: readonly T[], label: string): T[] {
  const values = [...new Set(Array.isArray(value) ? value.map(String) : fallback)] as T[];
  if (!values.length || values.some((item) => !allowed.includes(item))) throw new BadRequestException(`${label}不正确`);
  return values;
}

export function normalizePackageMerchandising(input: PackageMerchandisingInput, priceFen: number): PackageMerchandisingFields {
  const productTypes = ['STANDARD', 'GROUP_BUY', 'WEIGHED', 'MULTI_SPEC'] as const;
  if (input.productType !== undefined && !productTypes.includes(input.productType)) throw new BadRequestException('商品类型不正确');
  const productType = productTypes.includes(input.productType as typeof productTypes[number]) ? input.productType as typeof productTypes[number] : 'GROUP_BUY';
  const rawCoverImageUrl = text(input.coverImageUrl, '套餐封面地址', 1000);
  const coverImageUrl = rawCoverImageUrl ? safeCoverImageUrl(rawCoverImageUrl) : null;
  if (rawCoverImageUrl && !coverImageUrl) throw new BadRequestException('套餐封面地址必须使用 HTTPS 或本地相对路径');
  const originalPriceFen = optionalAmount(input.originalPriceFen, '商品划线价', 100_000_000);
  if (originalPriceFen !== null && (!Number.isSafeInteger(originalPriceFen) || originalPriceFen < priceFen || originalPriceFen > 100_000_000)) throw new BadRequestException('套餐原价不能低于售价且必须是有效金额');
  const memberPriceFen = optionalAmount(input.memberPriceFen, '会员价', 100_000_000);
  if (memberPriceFen !== null && memberPriceFen > priceFen) throw new BadRequestException('会员价不能高于零售价');
  const galleryUrls = stringList(input.galleryUrls, '商品图集', 5, 1000).map((value) => {
    const safe = safeCoverImageUrl(value);
    if (!safe) throw new BadRequestException('商品图集地址必须使用 HTTPS 或本地相对路径');
    return safe;
  });
  const rawVideoUrl = text(input.videoUrl, '商品视频地址', 1000);
  const videoUrl = rawVideoUrl ? safeCoverImageUrl(rawVideoUrl) : null;
  if (rawVideoUrl && !videoUrl) throw new BadRequestException('商品视频地址必须使用 HTTPS 或本地相对路径');
  return {
    productType,
    skuCode: text(input.skuCode, '货号', 64),
    barcode: text(input.barcode, '条码', 64),
    recommendation: text(input.recommendation, '推荐语', 500),
    coverImageUrl,
    galleryUrls,
    videoUrl,
    originalPriceFen,
    memberPriceFen,
    purchasePriceFen: optionalAmount(input.purchasePriceFen, '参考进货价', 100_000_000),
    categoryName: text(input.categoryName, '商品分类', 120),
    categoryIds: uuidList(input.categoryIds, 50),
    unit: text(input.unit, '商品单位', 20) || '份',
    minPurchaseQuantity: integer(input.minPurchaseQuantity, '起购数量', 1, 9999, 1),
    virtualSales: integer(input.virtualSales, '虚拟销量', 0, 10_000_000, 0),
    tags: stringList(input.tags, '套餐标签', 8, 20),
    fulfillmentMethods: enumList(input.fulfillmentMethods, ['STORE_PICKUP', 'LOCAL_DELIVERY', 'EXPRESS'] as const, ['STORE_PICKUP'], '履约方式'),
    distributionEnabled: input.distributionEnabled === true,
    batchManaged: input.batchManaged === true,
    pointsEnabled: input.pointsEnabled !== false,
    inventoryEnabled: input.inventoryEnabled !== false,
    inventoryWarningThreshold: integer(input.inventoryWarningThreshold, '库存预警值', 0, 10_000_000, 0),
    salesChannels: enumList(input.salesChannels, ['ONLINE', 'OFFLINE'] as const, ['ONLINE', 'OFFLINE'], '销售场景'),
    guaranteeLabels: stringList(input.guaranteeLabels, '商品保障', 8, 20),
    parameterValues: stringList(input.parameterValues, '商品参数', 20, 80),
    purchaseNotes: text(input.purchaseNotes, '购买须知', 2000),
    usageRules: text(input.usageRules, '使用规则', 3000),
    detailContent: text(input.detailContent, '商品详情', 100_000),
  };
}

export function packageMerchandisingFromSnapshot(snapshot: Partial<PackageMerchandisingFields>): PackageMerchandisingFields {
  return {
    productType: ['STANDARD', 'GROUP_BUY', 'WEIGHED', 'MULTI_SPEC'].includes(String(snapshot.productType)) ? snapshot.productType! : 'GROUP_BUY',
    skuCode: typeof snapshot.skuCode === 'string' ? snapshot.skuCode : '',
    barcode: typeof snapshot.barcode === 'string' ? snapshot.barcode : '',
    recommendation: typeof snapshot.recommendation === 'string' ? snapshot.recommendation : '',
    coverImageUrl: typeof snapshot.coverImageUrl === 'string' ? safeCoverImageUrl(snapshot.coverImageUrl.trim()) : null,
    galleryUrls: Array.isArray(snapshot.galleryUrls) ? snapshot.galleryUrls.filter((value): value is string => typeof value === 'string').map((value) => safeCoverImageUrl(value)).filter((value): value is string => Boolean(value)).slice(0, 5) : [],
    videoUrl: typeof snapshot.videoUrl === 'string' ? safeCoverImageUrl(snapshot.videoUrl.trim()) : null,
    originalPriceFen: snapshot.originalPriceFen === null || snapshot.originalPriceFen === undefined ? null : snapshot.originalPriceFen,
    memberPriceFen: snapshot.memberPriceFen === null || snapshot.memberPriceFen === undefined ? null : snapshot.memberPriceFen,
    purchasePriceFen: snapshot.purchasePriceFen === null || snapshot.purchasePriceFen === undefined ? null : snapshot.purchasePriceFen,
    categoryName: typeof snapshot.categoryName === 'string' ? snapshot.categoryName : '',
    categoryIds: uuidList(snapshot.categoryIds, 50),
    unit: typeof snapshot.unit === 'string' && snapshot.unit ? snapshot.unit : '份',
    minPurchaseQuantity: Number.isInteger(snapshot.minPurchaseQuantity) ? snapshot.minPurchaseQuantity! : 1,
    virtualSales: Number.isInteger(snapshot.virtualSales) ? snapshot.virtualSales! : 0,
    tags: Array.isArray(snapshot.tags) ? snapshot.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8) : [],
    fulfillmentMethods: Array.isArray(snapshot.fulfillmentMethods) && snapshot.fulfillmentMethods.length ? snapshot.fulfillmentMethods.filter((value): value is 'STORE_PICKUP' | 'LOCAL_DELIVERY' | 'EXPRESS' => ['STORE_PICKUP', 'LOCAL_DELIVERY', 'EXPRESS'].includes(value)) : ['STORE_PICKUP'],
    distributionEnabled: snapshot.distributionEnabled === true,
    batchManaged: snapshot.batchManaged === true,
    pointsEnabled: snapshot.pointsEnabled !== false,
    inventoryEnabled: snapshot.inventoryEnabled !== false,
    inventoryWarningThreshold: Number.isInteger(snapshot.inventoryWarningThreshold) ? snapshot.inventoryWarningThreshold! : 0,
    salesChannels: Array.isArray(snapshot.salesChannels) && snapshot.salesChannels.length ? snapshot.salesChannels.filter((value): value is 'ONLINE' | 'OFFLINE' => ['ONLINE', 'OFFLINE'].includes(value)) : ['ONLINE', 'OFFLINE'],
    guaranteeLabels: Array.isArray(snapshot.guaranteeLabels) ? snapshot.guaranteeLabels.filter((value): value is string => typeof value === 'string').slice(0, 8) : [],
    parameterValues: Array.isArray(snapshot.parameterValues) ? snapshot.parameterValues.filter((value): value is string => typeof value === 'string').slice(0, 20) : [],
    purchaseNotes: typeof snapshot.purchaseNotes === 'string' ? snapshot.purchaseNotes : '',
    usageRules: typeof snapshot.usageRules === 'string' ? snapshot.usageRules : '',
    detailContent: typeof snapshot.detailContent === 'string' ? snapshot.detailContent : '',
  };
}

/** 分类 id 列表校验：仅保留合法 UUID、去重、限长（商品可归属多个分类） */
function uuidList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item)) continue;
    if (seen.size >= max) break;
    seen.add(item);
  }
  return Array.from(seen);
}
