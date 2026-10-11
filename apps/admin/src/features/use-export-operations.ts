import dayjs from 'dayjs';
import { useCallback, useState } from 'react';
import type { MutableRefObject } from 'react';
import { message } from 'antd';
import type { ExportJob } from './workspace-model';
import { API } from './workspace-runtime';
import { httpOperatorIssue, networkOperatorIssue, OperatorRequestError } from './operator-issue';
import type { OperatorIssue } from './operator-issue';

type WorkspaceRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function useExportOperations({
  request, token, merchantId, requestKeysRef, onRequireStepUp, onIssue,
}: {
  request: WorkspaceRequest;
  token: string;
  merchantId: string;
  requestKeysRef: MutableRefObject<Map<string, string>>;
  onRequireStepUp: () => void;
  onIssue: (issue: OperatorIssue) => void;
}) {
  const [exportRange, setExportRange] = useState<[string, string]>([dayjs().subtract(30, 'day').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')]);
  const [exporting, setExporting] = useState(false);
  const [downloadingExportId, setDownloadingExportId] = useState<string | null>(null);
  const [exportJobs, setExportJobs] = useState<ExportJob[]>([]);
  const [exportJobsOpen, setExportJobsOpen] = useState(false);
  const resetExportState = useCallback(() => {
    setExporting(false);
    setDownloadingExportId(null);
    setExportJobs([]);
    setExportJobsOpen(false);
  }, []);

  const refreshExportJobs = useCallback(async () => {
    setExportJobs(await request<ExportJob[]>('/exports'));
  }, [request]);

  const openExportJobs = useCallback(async () => {
    try { await refreshExportJobs(); setExportJobsOpen(true); }
    catch (error) { message.error((error as Error).message); }
  }, [refreshExportJobs]);

  const revokeExportJob = useCallback(async (exportJobId: string) => {
    try { await request(`/exports/${exportJobId}/revoke`, { method: 'POST', body: '{}' }); message.success('导出文件已撤回并清除'); await refreshExportJobs(); }
    catch (error) { message.error((error as Error).message); }
  }, [refreshExportJobs, request]);

  const downloadExportJob = useCallback(async (job: ExportJob) => {
    if (job.status !== 'READY' || downloadingExportId) return;
    try {
      setDownloadingExportId(job.id);
      let response: Response;
      try { response = await fetch(`${API}/exports/${job.id}/download`, { headers: { Authorization: `Bearer ${token}` } }); }
      catch { const issue = networkOperatorIssue(`/exports/${job.id}/download`, 'GET'); onIssue(issue); throw new OperatorRequestError(issue); }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const issue = httpOperatorIssue(response, body, `/exports/${job.id}/download`, 'GET');
        onIssue(issue);
        throw new OperatorRequestError(issue);
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${job.kind}-${job.fromDay.replaceAll('-', '')}-${job.toDay.replaceAll('-', '')}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      await refreshExportJobs();
      message.success('导出文件已开始下载');
    } catch (error) {
      const exportError = error as Error;
      if (exportError.message.includes('此敏感操作需要重新验证当前密码')) {
        message.warning('导出包含经营明细，请先完成身份确认后下载。');
        onRequireStepUp();
      } else message.error(exportError.message);
    } finally { setDownloadingExportId(null); }
  }, [downloadingExportId, onIssue, onRequireStepUp, refreshExportJobs, token]);

  const exportData = useCallback(async (kind: 'orders' | 'verifications') => {
    if (exporting) return;
    try {
      if (dayjs(exportRange[1]).diff(dayjs(exportRange[0]), 'day') > 91) throw new Error('单次导出时间范围不能超过 92 天');
      setExporting(true);
      message.loading({ content: '正在生成受保护导出文件…', key: 'export' });
      const intent = JSON.stringify({ kind, merchantId: merchantId || null, from: exportRange[0], to: exportRange[1] });
      const idempotencyKey = requestKeysRef.current.get(intent) || crypto.randomUUID().replaceAll('-', '');
      requestKeysRef.current.set(intent, idempotencyKey);
      const job = await request<ExportJob>('/exports', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ kind, from: exportRange[0], to: exportRange[1], ...(merchantId ? { merchantId } : {}) }) });
      requestKeysRef.current.delete(intent);
      let current = job;
      for (let attempt = 0; attempt < 30 && ['PENDING', 'PROCESSING'].includes(current.status); attempt += 1) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
        current = await request<ExportJob>(`/exports/${job.id}`);
      }
      if (current.status === 'FAILED') throw new Error(current.failureReason || '导出生成失败');
      if (current.status !== 'READY') {
        await refreshExportJobs();
        setExportJobsOpen(true);
        message.info({ content: '导出任务已排队，完成后可在导出记录下载。', key: 'export', duration: 5 });
        return;
      }
      await downloadExportJob(current);
    } catch (error) {
      const exportError = error as Error;
      if (exportError.message.includes('此敏感操作需要重新验证当前密码')) {
        message.warning({ content: '导出包含经营明细，请先完成身份确认后重新发起。', key: 'export' });
        onRequireStepUp();
      } else message.error({ content: exportError.message, key: 'export' });
    } finally { setExporting(false); }
  }, [downloadExportJob, exportRange, exporting, merchantId, onRequireStepUp, refreshExportJobs, request, requestKeysRef]);

  return {
    exportRange, setExportRange, exporting, downloadingExportId, exportJobs, exportJobsOpen,
    closeExportJobs: () => setExportJobsOpen(false), resetExportState, refreshExportJobs, openExportJobs, revokeExportJob, downloadExportJob, exportData,
  };
}
