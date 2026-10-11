import { message, type FormInstance } from 'antd';
import { useCallback, useRef, useState } from 'react';
import { contractJson, type RequestBody } from '../api-contract';
import type { Deal, EditorFormValues, ModalKind, Store, User } from './workspace-model';

type WorkspaceRequest = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

/** Keeps catalog and verifier-account mutations out of the workspace coordinator. */
export function useCatalogStaffOperations({ form, merchantId, user, request, refresh, setModal }: {
  form: FormInstance<EditorFormValues>;
  merchantId: string;
  user: User | null;
  request: WorkspaceRequest;
  refresh: () => Promise<void>;
  setModal: (kind: ModalKind) => void;
}) {
  const staffActiveRequestKeysRef = useRef(new Map<string, string>());
  const [editingPackageId, setEditingPackageId] = useState<string | null>(null);
  const [editingStoreId, setEditingStoreId] = useState<string | null>(null);
  const [editingStaffId, setEditingStaffId] = useState<string | null>(null);

  const resetCatalogStaffEditing = useCallback(() => {
    setEditingPackageId(null);
    setEditingStoreId(null);
    setEditingStaffId(null);
  }, []);

  const resetCatalogStaffOperations = useCallback(() => {
    staffActiveRequestKeysRef.current.clear();
    resetCatalogStaffEditing();
  }, [resetCatalogStaffEditing]);

  function editStore(record: Store) {
    form.resetFields();
    setEditingStoreId(record.id);
    form.setFieldsValue({
      id: record.id, expectedVersion: record.version, name: record.name, address: record.address,
      latitude: record.latitude, longitude: record.longitude, phone: record.phone, businessHours: record.businessHours,
      // FIX(2026-08-10)：编辑回填头像/简介（此前缺失导致编辑时头像不显示、保存可能覆盖丢失）
      logoUrl: record.logoUrl || '', description: record.description || '',
      openForSale: record.openForSale,
      ...(user?.role === 'PLATFORM_ADMIN' ? { openForVerification: record.openForVerification, initialOpenForVerification: record.openForVerification } : {}),
    });
    setModal('store');
  }

  async function changeStoreSale(record: Store, openForSale: boolean) {
    try {
      await request(`/merchants/${merchantId}/stores`, {
        method: 'POST',
        body: contractJson('AppController_saveStore', {
          id: record.id, expectedVersion: record.version, name: record.name, address: record.address,
          phone: record.phone, businessHours: record.businessHours, openForSale,
        }),
      });
      message.success(openForSale ? '门店已恢复新售' : '门店已暂停新售');
      void refresh();
    } catch (error) { message.error((error as Error).message); }
  }

  function editPackage(record: Deal) {
    form.resetFields();
    setEditingPackageId(record.id);
    form.setFieldsValue({
      id: record.id, expectedVersion: record.version, title: record.title, description: record.description,
      coverImageUrl: record.coverImageUrl || '', originalPriceYuan: record.originalPriceFen ? record.originalPriceFen / 100 : undefined,
      productType: record.productType || 'GROUP_BUY', skuCode: record.skuCode || '', barcode: record.barcode || '', recommendation: record.recommendation || '',
      memberPriceYuan: record.memberPriceFen ? record.memberPriceFen / 100 : undefined,
      purchasePriceYuan: record.purchasePriceFen ? record.purchasePriceFen / 100 : undefined,
      categoryName: record.categoryName || '', unit: record.unit || '份', minPurchaseQuantity: record.minPurchaseQuantity || 1,
      virtualSales: record.virtualSales || 0, galleryUrls: record.galleryUrls || [], videoUrl: record.videoUrl || '',
      tags: record.tags || [], purchaseNotes: record.purchaseNotes || '', usageRules: record.usageRules || '',
      fulfillmentMethods: record.fulfillmentMethods || ['STORE_PICKUP'], distributionEnabled: record.distributionEnabled === true,
      batchManaged: record.batchManaged === true, pointsEnabled: record.pointsEnabled !== false, inventoryEnabled: record.inventoryEnabled !== false,
      inventoryWarningThreshold: record.inventoryWarningThreshold || 0, salesChannels: record.salesChannels || ['ONLINE', 'OFFLINE'],
      guaranteeLabels: record.guaranteeLabels || [], parameterValues: record.parameterValues || [], detailContent: record.detailContent || '',
      priceYuan: record.priceFen / 100, saleLimit: record.saleLimit, perCustomerLimit: record.perCustomerLimit,
      storeIds: record.storeIds, validFrom: String(record.validFrom).slice(0, 10), validTo: String(record.validTo).slice(0, 10), validityMode: record.validityMode || 'ABSOLUTE', validityDurationDays: record.validityDurationDays ?? null, status: record.status,
    });
    setModal('package');
  }

  async function changePackageStatus(record: Deal, status: RequestBody<'AppController_packageStatus'>['status']) {
    try {
      await request(`/merchants/${merchantId}/packages/${record.id}/status`, {
        method: 'POST',
        body: contractJson('AppController_packageStatus', { status, expectedVersion: record.version }),
      });
      message.success('套餐状态已更新');
      void refresh();
    } catch (error) { message.error((error as Error).message); }
  }

  function editStaff(record: User) {
    form.resetFields();
    setEditingStaffId(record.id);
    form.setFieldsValue({ id: record.id, name: record.name, email: record.email, storeIds: record.storeIds || [] });
    setModal('staff');
  }

  async function changeStaffActive(id: string, active: boolean) {
    const intent = `${merchantId}:${id}:${active}`;
    const idempotencyKey = staffActiveRequestKeysRef.current.get(intent) || crypto.randomUUID().replaceAll('-', '');
    staffActiveRequestKeysRef.current.set(intent, idempotencyKey);
    try {
      await request(`/merchants/${merchantId}/staff/${id}/active`, {
        method: 'POST', headers: { 'Idempotency-Key': idempotencyKey },
        body: contractJson('AppController_staffActive', { active }),
      });
      staffActiveRequestKeysRef.current.delete(intent);
      message.success(active ? '员工已启用' : '员工已停用');
      void refresh();
    } catch (error) { message.error((error as Error).message); }
  }

  /** 核销员解绑：服务端 sessionVersion+1 使该核销员所有登录态立即失效（长期绑定解除，需重新扫码登录）。 */
  async function unbindVerifier(id: string) {
    try {
      await request(`/merchants/${merchantId}/staff/${id}/unbind`, { method: 'POST' });
      message.success('已解绑，该核销员需重新扫码登录');
      void refresh();
    } catch (error) { message.error((error as Error).message); }
  }

  /** 核销员微信绑定：生成一次性绑定令牌 + 顾客小程序绑定码图片，供商家端展示。 */
  async function createWechatBindToken(id: string): Promise<{ bindToken: string; expiresInSeconds: number; qrDataUrl?: string } | null> {
    try {
      return await request<{ bindToken: string; expiresInSeconds: number; qrDataUrl?: string }>(`/merchants/${merchantId}/staff/${id}/wechat-bind-token`, { method: 'POST' });
    } catch (error) {
      message.error((error as Error).message);
      return null;
    }
  }

  return {
    editingPackageId, editingStoreId, editingStaffId, resetCatalogStaffEditing, resetCatalogStaffOperations,
    editStore, changeStoreSale, editPackage, changePackageStatus, editStaff, changeStaffActive, unbindVerifier, createWechatBindToken,
  };
}
