export function extractRelativeJavaScriptDependencies(source) {
  const dependencies = [];
  const pattern = /(?:from\s*|import\s*(?:\(\s*)?)["']\.\/([^"']+\.js)["']/g;
  for (const match of source.matchAll(pattern)) dependencies.push(match[1]);
  return [...new Set(dependencies)];
}

export function extractRelativeStaticJavaScriptDependencies(source) {
  const dependencies = [];
  const pattern = /(?:from\s*|import\s*)["']\.\/([^"']+\.js)["']/g;
  for (const match of source.matchAll(pattern)) dependencies.push(match[1]);
  return [...new Set(dependencies)];
}

export function verifyWorkspaceLazyChunkGraph({
  role,
  workspaceAppSource,
  workspacePageContentSource,
  workspacePageContentAsset,
  featureAssets,
  operatorIssuePanelAsset,
}) {
  const failures = [];
  const appDependencies = new Set(extractRelativeJavaScriptDependencies(workspaceAppSource));
  const pageContentDependencies = new Set(extractRelativeJavaScriptDependencies(workspacePageContentSource));

  if (!appDependencies.has(workspacePageContentAsset)) {
    failures.push(`${role} 工作台未按需引用页面渲染模块`);
  }
  for (const [label, asset] of featureAssets) {
    if (!pageContentDependencies.has(asset)) failures.push(`${role} 页面渲染模块未按需引用${label}`);
  }
  if (!appDependencies.has(operatorIssuePanelAsset)) {
    failures.push(`${role} 工作台未按需引用问题诊断模块`);
  }
  return failures;
}
