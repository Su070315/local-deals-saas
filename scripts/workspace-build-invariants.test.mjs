import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractRelativeJavaScriptDependencies,
  extractRelativeStaticJavaScriptDependencies,
  verifyWorkspaceLazyChunkGraph,
} from './workspace-build-invariants.mjs';

const role = 'MERCHANT_ADMIN';
const pageContentAsset = 'workspace-page-content-content123.js';
const featureAssets = [
  ['概览模块', 'overview-page-overview123.js'],
  ['账户安全模块', 'account-security-page-security123.js'],
  ['财务复核模块', 'finance-review-page-finance123.js'],
  ['月结账单模块', 'billing-page-billing123.js'],
  ['运营列表入口', 'workspace-data-page-data123.js'],
  ['全局销售控制页面', 'runtime-controls-page-controls123.js'],
];
const operatorIssueAsset = 'operator-issue-panel-issue123.js';

test('extracts static and dynamic relative JavaScript imports', () => {
  const source = 'import x from "./static.js"; const y = import("./dynamic.js");';
  assert.deepEqual(extractRelativeJavaScriptDependencies(source), ['static.js', 'dynamic.js']);
  assert.deepEqual(extractRelativeStaticJavaScriptDependencies(source), ['static.js']);
});

test('accepts the two-level workspace lazy chunk graph', () => {
  const failures = verifyWorkspaceLazyChunkGraph({
    role,
    workspaceAppSource: `const page = import("./${pageContentAsset}"); const issue = import("./${operatorIssueAsset}");`,
    workspacePageContentSource: featureAssets.map(([, asset]) => `import("./${asset}")`).join(';'),
    workspacePageContentAsset: pageContentAsset,
    featureAssets,
    operatorIssuePanelAsset: operatorIssueAsset,
  });
  assert.deepEqual(failures, []);
});

test('rejects a graph that only leaves feature names in an asset map', () => {
  const failures = verifyWorkspaceLazyChunkGraph({
    role,
    workspaceAppSource: `const page = import("./${pageContentAsset}"); const issue = import("./${operatorIssueAsset}");`,
    workspacePageContentSource: featureAssets.map(([, asset]) => `"assets/${asset}"`).join(','),
    workspacePageContentAsset: pageContentAsset,
    featureAssets,
    operatorIssuePanelAsset: operatorIssueAsset,
  });
  assert.equal(failures.length, featureAssets.length);
  assert.match(failures[0], /页面渲染模块未按需引用概览模块/);
});
