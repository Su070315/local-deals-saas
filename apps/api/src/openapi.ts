import 'reflect-metadata';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import ts from 'typescript';
import { enrichResponseSchemas } from './openapi-response';
import { configureApiVersioning } from './api-versioning';

type OpenApiSchema = { type?: string; format?: string; enum?: unknown[]; items?: OpenApiSchema; properties?: Record<string, OpenApiSchema>; required?: string[]; additionalProperties?: boolean; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; pattern?: string; oneOf?: OpenApiSchema[]; $ref?: string };

const STABLE_UNVERSIONED_PATHS = new Set(['/api/payments/webhooks/{provider}']);

/**
 * Runtime routes keep their unversioned compatibility aliases, but publishing
 * both aliases would duplicate every operation and destabilize generated type
 * names. The checked-in contract therefore describes v1 plus the deliberately
 * stable provider webhook surface. Legacy aliases remain protected by HTTP
 * integration tests until their announced sunset.
 */
function retainAuthoritativeContract(document: Record<string, unknown>): void {
  const source = (document.paths || {}) as Record<string, Record<string, { operationId?: string }>>;
  const paths: typeof source = {};
  for (const [path, pathItem] of Object.entries(source)) {
    if (!path.startsWith('/api/v1/') && !STABLE_UNVERSIONED_PATHS.has(path)) continue;
    for (const operation of Object.values(pathItem)) {
      if (operation?.operationId) operation.operationId = operation.operationId.replace(/\[0\]_v1$/, '');
    }
    paths[path] = pathItem;
  }
  document.paths = paths;
}

function decoratorName(decorator: ts.Decorator): string | null {
  const expression = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
  return ts.isIdentifier(expression) ? expression.text : null;
}

function decoratorCall(decorator: ts.Decorator): ts.CallExpression | null { return ts.isCallExpression(decorator.expression) ? decorator.expression : null; }

function numericDecoratorArgument(decorator: ts.Decorator): number | null {
  const argument = decoratorCall(decorator)?.arguments[0];
  return argument && ts.isNumericLiteral(argument) ? Number(argument.text) : null;
}

function identifierDecoratorArgument(decorator: ts.Decorator): string | null {
  const argument = decoratorCall(decorator)?.arguments[0];
  return argument && ts.isIdentifier(argument) ? argument.text : null;
}

function regularExpressionDecoratorArgument(decorator: ts.Decorator): string | null {
  const argument = decoratorCall(decorator)?.arguments[0];
  if (!argument || !ts.isRegularExpressionLiteral(argument)) return null;
  const literal = argument.text;
  const finalSlash = literal.lastIndexOf('/');
  return finalSlash > 0 ? literal.slice(1, finalSlash) : null;
}

function decoratorAppliesToEach(decorator: ts.Decorator): boolean {
  const options = decoratorCall(decorator)?.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  const each = options.properties.find((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'each');
  return Boolean(each && ts.isPropertyAssignment(each) && each.initializer.kind === ts.SyntaxKind.TrueKeyword);
}

function isNullishType(type: ts.TypeNode): boolean {
  return type.kind === ts.SyntaxKind.NullKeyword || type.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword);
}

function schemaForType(type: ts.TypeNode | undefined, enums: Record<string, unknown>): OpenApiSchema {
  if (!type) return { type: 'object' };
  if (type.kind === ts.SyntaxKind.StringKeyword) return { type: 'string' };
  if (type.kind === ts.SyntaxKind.NumberKeyword) return { type: 'number' };
  if (type.kind === ts.SyntaxKind.BooleanKeyword) return { type: 'boolean' };
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return { type: 'string', enum: [type.literal.text] };
  if (ts.isArrayTypeNode(type)) return { type: 'array', items: schemaForType(type.elementType, enums) };
  if (ts.isUnionTypeNode(type)) {
    const nonNull = type.types.filter((item) => !isNullishType(item));
    if (nonNull.every((item) => ts.isLiteralTypeNode(item) && ts.isStringLiteral(item.literal))) {
      return { type: 'string', enum: nonNull.map((item) => (item as ts.LiteralTypeNode).literal).map((literal) => (literal as ts.StringLiteral).text) };
    }
    return nonNull.length === 1 ? schemaForType(nonNull[0], enums) : { oneOf: nonNull.map((item) => schemaForType(item, enums)) } as OpenApiSchema;
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const name = type.typeName.text;
    if (name === 'Array' && type.typeArguments?.length === 1) return { type: 'array', items: schemaForType(type.typeArguments[0], enums) };
    if (name === 'Record') return { type: 'object', additionalProperties: true };
    if (enums[name] && typeof enums[name] === 'object') return { type: 'string', enum: Object.values(enums[name] as Record<string, unknown>) };
    return { $ref: `#/components/schemas/${name}` };
  }
  return { type: 'object' };
}

async function enrichDtoSchemas(document: Record<string, unknown>, enumValues: Record<string, unknown>): Promise<void> {
  const sourcePaths = [resolve(__dirname, '../src/request.dto.ts'), resolve(__dirname, '../src/merchant-operations.dto.ts')];
  const classes = new Map<string, ts.ClassDeclaration>();
  for (const sourcePath of sourcePaths) {
    const source = await readFile(sourcePath, 'utf8');
    const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    file.forEachChild((node) => { if (ts.isClassDeclaration(node) && node.name) classes.set(node.name.text, node); });
  }
  const schemas = ((document.components as { schemas?: Record<string, OpenApiSchema> } | undefined)?.schemas || {}) as Record<string, OpenApiSchema>;

  const buildSchema = (name: string, seen = new Set<string>()): OpenApiSchema => {
    if (seen.has(name)) return { type: 'object' };
    const declaration = classes.get(name);
    if (!declaration) return schemas[name] || { type: 'object' };
    const nextSeen = new Set(seen).add(name);
    const schema: OpenApiSchema = { type: 'object', properties: {}, required: [], additionalProperties: false };
    if (declaration.heritageClauses) {
      for (const clause of declaration.heritageClauses) for (const type of clause.types) if (ts.isIdentifier(type.expression)) {
        const parent = buildSchema(type.expression.text, nextSeen);
        Object.assign(schema.properties!, parent.properties || {});
        schema.required?.push(...(parent.required || []));
      }
    }
    for (const member of declaration.members) {
      if (!ts.isPropertyDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
      const decorators = ts.getDecorators(member) || [];
      const field = schemaForType(member.type, enumValues);
      for (const decorator of decorators) {
        const nameOfDecorator = decoratorName(decorator);
        if (nameOfDecorator === 'IsInt') field.type = 'integer';
        if (nameOfDecorator === 'IsUUID') (field.type === 'array' ? field.items ||= { type: 'string' } : field).format = 'uuid';
        if (nameOfDecorator === 'IsEmail') field.format = 'email';
        if (nameOfDecorator === 'IsDateString' || nameOfDecorator === 'IsISO8601') field.format = 'date-time';
        if (nameOfDecorator === 'IsArray') { field.type = 'array'; field.items ||= { type: 'string' }; }
        if (nameOfDecorator === 'IsEnum') {
          const enumName = identifierDecoratorArgument(decorator);
          if (enumName && enumValues[enumName] && typeof enumValues[enumName] === 'object') { field.type = 'string'; field.enum = Object.values(enumValues[enumName] as Record<string, unknown>); }
        }
        if (nameOfDecorator === 'MinLength') (decoratorAppliesToEach(decorator) && field.items ? field.items : field).minLength = numericDecoratorArgument(decorator) ?? undefined;
        if (nameOfDecorator === 'MaxLength') (decoratorAppliesToEach(decorator) && field.items ? field.items : field).maxLength = numericDecoratorArgument(decorator) ?? undefined;
        if (nameOfDecorator === 'Min') (decoratorAppliesToEach(decorator) && field.items ? field.items : field).minimum = numericDecoratorArgument(decorator) ?? undefined;
        if (nameOfDecorator === 'Max') (decoratorAppliesToEach(decorator) && field.items ? field.items : field).maximum = numericDecoratorArgument(decorator) ?? undefined;
        if (nameOfDecorator === 'Matches') field.pattern = regularExpressionDecoratorArgument(decorator) ?? undefined;
        if (nameOfDecorator === 'ArrayNotEmpty') field.minItems = 1;
        if (nameOfDecorator === 'ArrayMinSize') field.minItems = numericDecoratorArgument(decorator) ?? undefined;
        if (nameOfDecorator === 'ArrayMaxSize') field.maxItems = numericDecoratorArgument(decorator) ?? undefined;
        if (nameOfDecorator === 'IsOptional' || nameOfDecorator === 'ValidateIf') field.required = undefined;
      }
      schema.properties![member.name.text] = field;
      const optional = member.questionToken || decorators.some((decorator) => ['IsOptional', 'ValidateIf'].includes(decoratorName(decorator) || ''));
      if (!optional) schema.required!.push(member.name.text);
    }
    if (!schema.required?.length) delete schema.required;
    return schema;
  };

  for (const name of classes.keys()) schemas[name] = buildSchema(name);
  if (!document.components) document.components = {};
  (document.components as { schemas: Record<string, OpenApiSchema> }).schemas = schemas;
}

async function enrichQueryParameters(document: Record<string, unknown>): Promise<void> {
  const sourcePath = resolve(__dirname, '../src/app.controller.ts');
  const source = await readFile(sourcePath, 'utf8');
  const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const schemas = ((document.components as { schemas?: Record<string, OpenApiSchema> } | undefined)?.schemas || {}) as Record<string, OpenApiSchema>;
  const operations = new Map<string, { parameters?: Array<Record<string, unknown>> }>();
  const paths = (document.paths || {}) as Record<string, Record<string, { operationId?: string; parameters?: Array<Record<string, unknown>> }>>;
  for (const path of Object.values(paths)) for (const operation of Object.values(path)) if (operation?.operationId) operations.set(operation.operationId, operation);

  for (const node of file.statements) {
    if (!ts.isClassDeclaration(node) || !node.name) continue;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
      const operation = operations.get(`${node.name.text}_${member.name.text}`);
      if (!operation) continue;
      for (const parameter of member.parameters) {
        const query = (ts.getDecorators(parameter) || []).find((decorator) => decoratorName(decorator) === 'Query' && decoratorCall(decorator)?.arguments.length === 0);
        if (!query || !parameter.type || !ts.isTypeReferenceNode(parameter.type) || !ts.isIdentifier(parameter.type.typeName)) continue;
        const schema = schemas[parameter.type.typeName.text];
        if (!schema?.properties) continue;
        const required = new Set(schema.required || []);
        operation.parameters ||= [];
        for (const [name, property] of Object.entries(schema.properties)) {
          if (operation.parameters.some((item) => item.in === 'query' && item.name === name)) continue;
          operation.parameters.push({ name, in: 'query', required: required.has(name), schema: property });
        }
      }
    }
  }
}

/** Builds the checked-in API contract without starting an HTTP listener. */
export async function buildOpenApiDocument(): Promise<Record<string, unknown>> {
  const { AppModule } = await import('./app.module');
  const domainEntities = await import('./domain/entities');
  const merchantOperationEntities = await import('./domain/merchant-operations.entities');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  configureApiVersioning(app);
  const config = new DocumentBuilder()
    .setTitle('Local Deals SaaS API')
    .setDescription('Versioned contract for operator workspaces, customer mini-programs and the verifier assistant.')
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'operator')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'customer')
    .build();
  try {
    const document = SwaggerModule.createDocument(app, config, { deepScanRoutes: true }) as unknown as Record<string, unknown>;
    retainAuthoritativeContract(document);
    await enrichDtoSchemas(document, { ...domainEntities, ...merchantOperationEntities } as unknown as Record<string, unknown>);
    await enrichQueryParameters(document);
    await enrichResponseSchemas(document);
    return document;
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  process.env.NODE_ENV = 'test';
  process.env.USE_PG_MEM = 'true';
  const output = resolve(process.env.OPENAPI_OUTPUT || resolve(__dirname, '../../../packages/api-contract/openapi.json'));
  const document = await buildOpenApiDocument();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log(`OpenAPI contract written to ${output}`);
}

if (require.main === module) void main();
