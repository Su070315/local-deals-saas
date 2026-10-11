import { DeleteOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { Button, Checkbox, Col, Divider, Form, Input, InputNumber, message, Radio, Row, Select, Space, Switch, Typography, Upload } from 'antd';
import type { ReactNode } from 'react';
import type { ModalKind, Store } from './workspace-model';
import { PackagePreview } from './workspace-widgets';

const fullWidth = { width: '100%' };
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function PackageEditorFields({ kind, stores, merchantId, request }: { kind: ModalKind; stores: Store[]; merchantId?: string; request?: Request }) {
  if (kind !== 'package') return null;

  /** 通用上传：拿到 URL 后由调用方决定写入哪个字段 */
  const uploadImage = (onSuccess: (url: string) => void) => async (options: { file?: unknown }) => {
    if (!merchantId || !request) { message.warning('当前环境不支持本地上传，请填写图片地址'); return; }
    const file = options.file as File | undefined;
    if (!file) { message.warning('无法读取本地文件'); return; }
    if (file.size > MAX_IMAGE_BYTES) { message.error('图片大小不能超过 5MB'); return; }
    const formData = new FormData();
    formData.append('file', file);
    try {
      const result = await request<{ url: string }>(`/media/images?merchantId=${merchantId}`, { method: 'POST', body: formData });
      onSuccess(result.url);
      message.success('图片上传成功');
    } catch (error) {
      message.error((error as Error).message || '图片上传失败');
    }
  };

  return <div className="product-archive-form">
    <Form.Item name="id" hidden><Input /></Form.Item>
    <Form.Item name="expectedVersion" hidden><Input /></Form.Item>

    <ArchiveSection title="商品类型" description="商品类型保存后仍可调整；称重与多规格商品可继续配置库存和规格。">
      <Form.Item name="productType" rules={[{ required: true }]}>
        <Radio.Group buttonStyle="solid" className="product-type-selector">
          <Radio.Button value="STANDARD">普通商品</Radio.Button>
          <Radio.Button value="GROUP_BUY">团购商品 / 到店核销</Radio.Button>
          <Radio.Button value="WEIGHED">称重商品</Radio.Button>
          <Radio.Button value="MULTI_SPEC">多规格商品</Radio.Button>
        </Radio.Group>
      </Form.Item>
    </ArchiveSection>

    <ArchiveSection title="基础信息" description="用于商品库、顾客端列表、搜索和核销快照。">
      <Row gutter={18}>
        <Col xs={24} lg={12}><Form.Item name="skuCode" label="货号" rules={[{ max: 64 }]}><Input placeholder="请输入货号或使用系统生成" /></Form.Item></Col>
        <Col xs={24} lg={12}><Form.Item noStyle shouldUpdate>{({ setFieldValue }) => <Form.Item label="快速生成"><Button icon={<PlusOutlined />} onClick={() => setFieldValue('skuCode', `SP${Date.now()}`)}>生成货号</Button></Form.Item>}</Form.Item></Col>
        <Col xs={24} lg={12}><Form.Item name="barcode" label="商品条码" rules={[{ max: 64 }]}><Input placeholder="可扫码录入或手动填写" /></Form.Item></Col>
        <Col xs={24} lg={12}><Form.Item name="categoryName" label="商品分类"><Input placeholder="例如：团购套餐 / 餐饮美食" /></Form.Item></Col>
        <Col span={24}><Form.Item name="title" label="商品名称" rules={[{ required: true, message: '请输入商品名称' }, { max: 100 }]}><Input placeholder="请输入商品名称" /></Form.Item></Col>
        {/* FIX(2026-08-10)：商品简介字段已下线（顾客端仅展示"商品详情"富文本，避免双介绍重复；description 字段保留兼容历史数据） */}
        <Col span={24}><Form.Item name="recommendation" label="商品推荐语"><Input.TextArea rows={2} maxLength={500} showCount placeholder="突出卖点、服务特色或适用人群" /></Form.Item></Col>
      </Row>
    </ArchiveSection>

    <ArchiveSection title="价格与销售" description="所有金额均以人民币元录入，服务端按分保存并校验。">
      <Row gutter={18}>
        <Col xs={12} lg={6}><Form.Item name="priceYuan" label="零售价（元）" rules={[{ required: true, message: '请输入零售价' }]}><InputNumber min={0.01} precision={2} style={fullWidth} /></Form.Item></Col>
        <Col xs={12} lg={6}><Form.Item name="memberPriceYuan" label="会员价（元）"><InputNumber min={0.01} precision={2} style={fullWidth} /></Form.Item></Col>
        <Col xs={12} lg={6}><Form.Item name="purchasePriceYuan" label="参考进货价（元）"><InputNumber min={0.01} precision={2} style={fullWidth} /></Form.Item></Col>
        <Col xs={12} lg={6}><Form.Item name="originalPriceYuan" label="划线价（元）"><InputNumber min={0.01} precision={2} style={fullWidth} /></Form.Item></Col>
        <Col xs={12} lg={6}><Form.Item name="unit" label="单位" rules={[{ required: true }]}><Select options={['份', '件', '个', '套', '盒', '斤', '千克'].map((value) => ({ value }))} /></Form.Item></Col>
        <Col xs={12} lg={6}><Form.Item name="minPurchaseQuantity" label="起购数量"><InputNumber min={1} max={9999} style={fullWidth} /></Form.Item></Col>
        <Col xs={12} lg={6}><Form.Item name="virtualSales" label="虚拟销量"><InputNumber min={0} max={10_000_000} style={fullWidth} /></Form.Item></Col>
        <Col xs={12} lg={6}><Form.Item name="perCustomerLimit" label="每人限购"><InputNumber min={0} max={10_000} style={fullWidth} placeholder="0 为不限" /></Form.Item></Col>
        <Col span={24}><Form.Item name="tags" label="商品标签" extra="例如：品质团购、官方推荐、到店优先；最多 8 个。"><Select mode="tags" tokenSeparators={[',', '，']} maxTagCount={8} /></Form.Item></Col>
      </Row>
    </ArchiveSection>

    <ArchiveSection title="门店与履约" description="决定顾客下单后可选择的门店和交付方式。">
      <Form.Item name="storeIds" label="上架门店" rules={[{ required: true, message: '请至少选择一家上架门店' }]}><Select mode="multiple" placeholder="全部或部分门店" options={stores.map((store) => ({ value: store.id, label: store.name }))} /></Form.Item>
      <Form.Item name="fulfillmentMethods" label="履约方式" rules={[{ required: true }]}>
        <Checkbox.Group options={[{ value: 'STORE_PICKUP', label: '到店自提 / 核销' }, { value: 'LOCAL_DELIVERY', label: '同城配送' }, { value: 'EXPRESS', label: '快递发货' }]} />
      </Form.Item>
      <Form.Item name="salesChannels" label="销售场景" rules={[{ required: true }]}>
        <Checkbox.Group options={[{ value: 'OFFLINE', label: '线下收银' }, { value: 'ONLINE', label: '线上商城' }]} />
      </Form.Item>
      <Row gutter={18}>
        <Col xs={24} lg={8}><SwitchField name="distributionEnabled" label="参与一级分销" extra="只计算直接推广关系，不建立二级分销链路。" /></Col>
        <Col xs={24} lg={8}><SwitchField name="pointsEnabled" label="赠送会员积分" /></Col>
        <Col xs={24} lg={8}><SwitchField name="batchManaged" label="启用批次管理" /></Col>
      </Row>
    </ArchiveSection>

    <ArchiveSection title="库存与有效期" description="商品库存会和采购、入库、出库、报损、盘点及调拨单据联动。">
      <Row gutter={18} align="middle">
        <Col xs={24} lg={6}><SwitchField name="inventoryEnabled" label="启用库存" /></Col>
        <Col xs={12} lg={6}><Form.Item name="saleLimit" label="销售库存"><InputNumber min={0} max={10_000_000} style={fullWidth} placeholder="0 为不限" /></Form.Item></Col>
        <Col xs={12} lg={6}><Form.Item name="inventoryWarningThreshold" label="库存预警值"><InputNumber min={0} max={10_000_000} style={fullWidth} /></Form.Item></Col>
        <Col xs={24} lg={8}><Form.Item name="validityMode" label="券有效期模式" rules={[{ required: true }]}><Select options={[{ value: 'ABSOLUTE', label: '固定日期（兼容旧套餐）' }, { value: 'PURCHASE_RELATIVE', label: '购买日起算' }]} /></Form.Item></Col>
        <Col xs={12} lg={4}><Form.Item name="validityDurationDays" label="有效天数" dependencies={['validityMode']} rules={[({ getFieldValue }) => ({ validator(_, value) { if (getFieldValue('validityMode') === 'PURCHASE_RELATIVE' && (!Number.isInteger(value) || value < 1 || value > 3650)) return Promise.reject(new Error('购买日起算需填写 1 至 3650 天')); return Promise.resolve(); } })]}><InputNumber min={1} max={3650} precision={0} style={fullWidth} placeholder="例如 30" /></Form.Item></Col>
        <Col xs={12} lg={6}><Form.Item name="validFrom" label="生效日" rules={[{ required: true }]}><Input type="date" /></Form.Item></Col>
        <Col xs={12} lg={6}><Form.Item name="validTo" label="失效日" rules={[{ required: true }]}><Input type="date" /></Form.Item></Col>
      </Row>
    </ArchiveSection>

    <ArchiveSection title="保障与参数" description="保障标签直接展示给顾客；参数采用“名称：内容”的形式录入。">
      <Form.Item name="guaranteeLabels" label="商品保障"><Select mode="tags" maxTagCount={8} tokenSeparators={[',', '，']} placeholder="随时退、过期退、品质保障、官方推荐" /></Form.Item>
      <Form.Item name="parameterValues" label="商品参数"><Select mode="tags" maxTagCount={10} tokenSeparators={[',', '，']} placeholder="例如：适用人数：2 人" /></Form.Item>
    </ArchiveSection>

    <ArchiveSection title="图片、视频与详情" description="主图建议 800 x 800，图集最多 5 张；支持本地上传（jpg/png/webp/gif，≤5MB），也支持填写 HTTPS 地址。">
      <Form.Item name="coverImageUrl" label="商品主图" extra="可本地上传，或直接填写对象存储/CDN 的 HTTPS 地址。">
        <Space.Compact style={fullWidth}>
          <Input maxLength={1000} placeholder="https://对象存储地址/cover.jpg" />
          <Form.Item noStyle shouldUpdate>{({ setFieldValue }) => (
            <Upload showUploadList={false} accept="image/*" customRequest={uploadImage((url) => setFieldValue('coverImageUrl', url))}>
              <Button icon={<UploadOutlined />}>本地上传</Button>
            </Upload>
          )}</Form.Item>
        </Space.Compact>
      </Form.Item>
      <Form.List name="galleryUrls">{(fields, { add, remove }) => <Form.Item label="商品图集"><Space direction="vertical" style={fullWidth}>{fields.map((field, index) => <Space.Compact key={field.key} style={fullWidth}><Form.Item {...field} noStyle rules={[{ type: 'url', warningOnly: true }]}><Input aria-label={`商品图 ${index + 1}`} placeholder={`商品图 ${index + 1} 的 HTTPS 地址`} /></Form.Item><Button aria-label={`删除商品图 ${index + 1}`} icon={<DeleteOutlined />} onClick={() => remove(field.name)} /></Space.Compact>)}<Space wrap><Button disabled={fields.length >= 5} icon={<PlusOutlined />} onClick={() => add('')}>添加商品图</Button><Form.Item noStyle shouldUpdate>{({ getFieldValue }) => (
          <Upload showUploadList={false} accept="image/*" customRequest={uploadImage((url) => { if (getFieldValue('galleryUrls')?.length >= 5) { message.warning('图集最多 5 张'); return; } add(url); })}>
            <Button disabled={fields.length >= 5} icon={<UploadOutlined />}>本地上传</Button>
          </Upload>
        )}</Form.Item></Space></Space></Form.Item>}</Form.List>
      <Form.Item name="videoUrl" label="商品视频"><Input maxLength={1000} placeholder="https://对象存储地址/product.mp4" /></Form.Item>
      <Form.Item name="detailContent" label="商品详情"><Input.TextArea rows={8} maxLength={100_000} showCount placeholder="填写商品详情、服务内容、使用说明和图文素材说明" /></Form.Item>
      <Form.Item name="purchaseNotes" label="购买须知"><Input.TextArea rows={3} maxLength={2000} placeholder="预约、退款、发票及特殊限制" /></Form.Item>
      <Form.Item name="usageRules" label="使用规则"><Input.TextArea rows={3} maxLength={3000} placeholder="核销方式、可用时段、叠加规则和门店限制" /></Form.Item>
    </ArchiveSection>

    <ArchiveSection title="发布设置" description="草稿不会出现在顾客端；下架只停止新订单，不影响已售券履约。">
      <Form.Item name="status" label="发布状态"><Select options={[{ value: 'DRAFT', label: '保存为草稿' }, { value: 'ON_SALE', label: '立即上架' }, { value: 'OFF_SALE', label: '下架' }]} /></Form.Item>
      <Form.Item noStyle shouldUpdate>{({ getFieldsValue }) => <PackagePreview values={getFieldsValue()} />}</Form.Item>
    </ArchiveSection>
  </div>;
}

function ArchiveSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="product-archive-section"><div className="product-archive-heading"><Typography.Title level={5}>{title}</Typography.Title><Typography.Text type="secondary">{description}</Typography.Text></div><Divider />{children}</section>;
}

function SwitchField({ name, label, extra }: { name: string; label: string; extra?: string }) {
  return <Form.Item name={name} label={label} valuePropName="checked" extra={extra}><Switch checkedChildren="开" unCheckedChildren="关" /></Form.Item>;
}
