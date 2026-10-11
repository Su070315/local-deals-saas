import { message } from 'antd';
import { useState } from 'react';
import { contractJson } from '../api-contract';
import type {
  Deal,
  MerchantTemplateConfig,
  MerchantTemplateConfigVersion,
  PackageVersion,
  Store,
  StoreVersion,
} from './workspace-model';

type WorkspaceRequest = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

export function useVersionHistoryOperations({ merchantId, request, refresh, setTemplatePackages }: {
  merchantId: string;
  request: WorkspaceRequest;
  refresh: () => Promise<void>;
  setTemplatePackages: (packages: Deal[]) => void;
}) {
  const [versionedPackage, setVersionedPackage] = useState<Deal | null>(null);
  const [packageVersions, setPackageVersions] = useState<PackageVersion[]>([]);
  const [versionedStore, setVersionedStore] = useState<Store | null>(null);
  const [storeVersions, setStoreVersions] = useState<StoreVersion[]>([]);
  const [templateVersions, setTemplateVersions] = useState<MerchantTemplateConfigVersion[]>([]);
  const [versionedTemplateConfig, setVersionedTemplateConfig] = useState<MerchantTemplateConfig | null>(null);

  async function openPackageVersions(record: Deal) {
    try {
      const versions = await request<PackageVersion[]>(`/merchants/${merchantId}/packages/${record.id}/versions`);
      setVersionedPackage(record);
      setPackageVersions(versions);
    } catch (error) { message.error((error as Error).message); }
  }

  async function restorePackageVersion(auditId: string) {
    if (!versionedPackage) return;
    try {
      await request(`/merchants/${merchantId}/packages/${versionedPackage.id}/versions/${auditId}/restore`, {
        method: 'POST',
        body: contractJson('AppController_restorePackageVersion', { expectedVersion: versionedPackage.version }),
      });
      message.success('套餐配置已恢复为新版本');
      closePackageVersions();
      await refresh();
    } catch (error) { message.error((error as Error).message); }
  }

  async function openStoreVersions(record: Store) {
    try {
      const versions = await request<StoreVersion[]>(`/merchants/${merchantId}/stores/${record.id}/versions`);
      setVersionedStore(record);
      setStoreVersions(versions);
    } catch (error) { message.error((error as Error).message); }
  }

  async function restoreStoreVersion(auditId: string) {
    if (!versionedStore) return;
    try {
      await request(`/merchants/${merchantId}/stores/${versionedStore.id}/versions/${auditId}/restore`, {
        method: 'POST', body: JSON.stringify({ expectedVersion: versionedStore.version }),
      });
      message.success('门店配置已恢复为新版本');
      closeStoreVersions();
      await refresh();
    } catch (error) { message.error((error as Error).message); }
  }

  async function openTemplateVersions(config: MerchantTemplateConfig) {
    try {
      const [versions, packages] = await Promise.all([
        request<MerchantTemplateConfigVersion[]>(`/merchants/${merchantId}/template-config/versions`),
        request<Deal[]>(`/merchants/${merchantId}/packages`),
      ]);
      setTemplatePackages(packages);
      setTemplateVersions(versions);
      setVersionedTemplateConfig(config);
    } catch (error) { message.error((error as Error).message); }
  }

  async function restoreTemplateVersion(auditId: string) {
    if (!versionedTemplateConfig) return;
    try {
      await request(`/merchants/${merchantId}/template-config/versions/${auditId}/restore`, {
        method: 'POST', body: JSON.stringify({ expectedVersion: versionedTemplateConfig.version }),
      });
      message.success('品牌主页已恢复为新版本');
      closeTemplateVersions();
      await refresh();
    } catch (error) { message.error((error as Error).message); }
  }

  function closePackageVersions() { setVersionedPackage(null); setPackageVersions([]); }
  function closeStoreVersions() { setVersionedStore(null); setStoreVersions([]); }
  function closeTemplateVersions() { setVersionedTemplateConfig(null); setTemplateVersions([]); setTemplatePackages([]); }

  return {
    versionedPackage, packageVersions, versionedStore, storeVersions, versionedTemplateConfig, templateVersions,
    openPackageVersions, restorePackageVersion, closePackageVersions,
    openStoreVersions, restoreStoreVersion, closeStoreVersions,
    openTemplateVersions, restoreTemplateVersion, closeTemplateVersions,
  };
}
