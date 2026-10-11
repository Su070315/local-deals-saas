import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

type Schema = {
  type?: string;
  format?: string;
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  nullable?: boolean;
  oneOf?: Schema[];
};

type Operation = {
  operationId?: string;
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: Schema }> }>;
};

function literalValue(type: ts.Type): string | number | boolean | undefined {
  if (type.flags & ts.TypeFlags.StringLiteral) return (type as ts.StringLiteralType).value;
  if (type.flags & ts.TypeFlags.NumberLiteral) return (type as ts.NumberLiteralType).value;
  if (type.flags & ts.TypeFlags.BooleanLiteral) return (type as { intrinsicName?: string }).intrinsicName === 'true';
  return undefined;
}

function firstTypeArgument(type: ts.Type, checker: ts.TypeChecker): ts.Type | undefined {
  if (!(type.flags & ts.TypeFlags.Object) || !((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference)) return undefined;
  return checker.getTypeArguments(type as ts.TypeReference)[0];
}

function unionSchema(type: ts.UnionType, checker: ts.TypeChecker, location: ts.Node, seen: Set<ts.Type>, depth: number): Schema | null {
  const nullable = type.types.some((item) => item.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined));
  const members = type.types.filter((item) => !(item.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
  const literals = members.map(literalValue);
  if (members.length && literals.every((value) => value !== undefined)) {
    const first = literals[0];
    return { type: typeof first, enum: literals as unknown[], ...(nullable ? { nullable: true } : {}) };
  }
  if (members.length === 1) {
    const schema = checkedTypeSchema(members[0], checker, location, seen, depth + 1);
    return schema ? { ...schema, ...(nullable ? { nullable: true } : {}) } : null;
  }
  const oneOf = members.map((member) => checkedTypeSchema(member, checker, location, new Set(seen), depth + 1)).filter((schema): schema is Schema => Boolean(schema));
  return oneOf.length ? { oneOf, ...(nullable ? { nullable: true } : {}) } : null;
}

function checkedTypeSchema(type: ts.Type, checker: ts.TypeChecker, location: ts.Node, seen = new Set<ts.Type>(), depth = 0): Schema | null {
  if (depth > 12 || type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.Undefined)) return null;
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
  if (type.flags & ts.TypeFlags.StringLike) return literalValue(type) === undefined ? { type: 'string' } : { type: 'string', enum: [literalValue(type)] };
  if (type.flags & ts.TypeFlags.NumberLike) return literalValue(type) === undefined ? { type: 'number' } : { type: 'number', enum: [literalValue(type)] };
  if (type.flags & ts.TypeFlags.BooleanLike) return literalValue(type) === undefined ? { type: 'boolean' } : { type: 'boolean', enum: [literalValue(type)] };
  if (type.flags & ts.TypeFlags.BigIntLike) return { type: 'integer', format: 'int64' };
  if (type.flags & ts.TypeFlags.Null) return { nullable: true };
  if (type.isUnion()) return unionSchema(type, checker, location, seen, depth);

  const symbolName = (type.aliasSymbol || type.getSymbol())?.getName();
  if (symbolName === 'Date') return { type: 'string', format: 'date-time' };
  if (symbolName === 'Buffer' || symbolName === 'Uint8Array') return { type: 'string', format: 'binary' };
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const element = firstTypeArgument(type, checker);
    return { type: 'array', items: element ? checkedTypeSchema(element, checker, location, new Set(seen), depth + 1) || {} : {} };
  }
  if (seen.has(type)) return { type: 'object' };
  seen.add(type);

  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration || property.declarations?.[0] || location;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    const schema = checkedTypeSchema(propertyType, checker, declaration, new Set(seen), depth + 1);
    if (!schema) continue;
    properties[property.getName()] = schema;
    if (!(property.flags & ts.SymbolFlags.Optional) && !(propertyType.flags & ts.TypeFlags.Undefined)) required.push(property.getName());
  }
  const indexType = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  if (Object.keys(properties).length) return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
  if (indexType) return { type: 'object', additionalProperties: checkedTypeSchema(indexType, checker, location, new Set(seen), depth + 1) || {} };
  return { type: 'object' };
}

async function controllerProgram(): Promise<{ checker: ts.TypeChecker; sources: ts.SourceFile[] }> {
  const configPath = resolve(__dirname, '../tsconfig.build.json');
  const config = ts.parseConfigFileTextToJson(configPath, await readFile(configPath, 'utf8'));
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(configPath, '..'));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const sourcePaths = ['app.controller.ts', 'merchant-operations.controller.ts', 'wechat-platform.controller.ts']
    .map((file) => resolve(__dirname, `../src/${file}`).replace(/\\/g, '/').toLowerCase());
  const sources = sourcePaths.map((sourcePath) => program.getSourceFiles().find((file) => file.fileName.replace(/\\/g, '/').toLowerCase() === sourcePath));
  if (sources.some((source) => !source)) throw new Error('无法加载控制器源码以生成响应契约');
  return { checker: program.getTypeChecker(), sources: sources as ts.SourceFile[] };
}

/** Adds JSON response schemas inferred from the controller's checked return types. */
export async function enrichResponseSchemas(document: Record<string, unknown>): Promise<void> {
  const { checker, sources } = await controllerProgram();
  const operations = new Map<string, Operation>();
  const paths = (document.paths || {}) as Record<string, Record<string, Operation>>;
  for (const path of Object.values(paths)) for (const operation of Object.values(path)) if (operation.operationId) operations.set(operation.operationId, operation);
  const components = ((document.components ||= {}) as { schemas?: Record<string, Schema> });
  components.schemas ||= {};

  for (const node of sources.flatMap((source) => [...source.statements])) {
    if (!ts.isClassDeclaration(node) || !node.name) continue;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
      const operationId: string = `${node.name.text}_${member.name.text}`;
      const operation = operations.get(operationId);
      const signature = operation && checker.getSignatureFromDeclaration(member);
      if (!operation || !signature) continue;
      let returnType = checker.getReturnTypeOfSignature(signature);
      if ((returnType.aliasSymbol || returnType.getSymbol())?.getName() === 'Promise') returnType = firstTypeArgument(returnType, checker) || returnType;
      const schema = checkedTypeSchema(returnType, checker, member);
      const responseCode = Object.keys(operation.responses || {}).find((code) => /^2\d\d$/.test(code));
      if (!schema || !responseCode || operation.responses?.[responseCode]?.content) continue;
      const componentName = `${operationId}Response`;
      components.schemas[componentName] = schema;
      operation.responses![responseCode].content = { 'application/json': { schema: { $ref: `#/components/schemas/${componentName}` } as Schema } };
    }
  }

  const download = operations.get('AppController_downloadExport');
  const responseCode = Object.keys(download?.responses || {}).find((code) => /^2\d\d$/.test(code));
  if (download && responseCode) download.responses![responseCode].content = { 'text/csv': { schema: { type: 'string' } } };
}
