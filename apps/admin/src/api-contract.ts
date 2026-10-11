import type { operations } from '@local-deals/api-contract';

type JsonRequestBody<Operation> = Operation extends { requestBody: { content: { 'application/json': infer Body } } } ? Body : never;
type OperationQuery<Operation> = Operation extends { parameters: { query?: infer Query } } ? Exclude<Query, undefined> : never;
type JsonResponse<Response> = Response extends { content: { 'application/json': infer Body } } ? Body : never;
type OperationResponse<Operation> = Operation extends { responses: infer Responses }
  ? { [Status in keyof Responses]: JsonResponse<Responses[Status]> }[keyof Responses]
  : never;

/** Compile-time bridge from an operation id to its generated request body. */
export type RequestBody<Operation extends keyof operations> = JsonRequestBody<operations[Operation]>;
export type QueryParams<Operation extends keyof operations> = OperationQuery<operations[Operation]>;
export type ResponseBody<Operation extends keyof operations> = OperationResponse<operations[Operation]>;
export type ResponseItem<Operation extends keyof operations> = ResponseBody<Operation> extends ReadonlyArray<infer Item>
  ? Item
  : ResponseBody<Operation> extends { items: ReadonlyArray<infer Item> } ? Item : never;

export function contractJson<Operation extends keyof operations>(operation: Operation, body: RequestBody<Operation>): string {
  void operation;
  return JSON.stringify(body);
}

export function contractQuery<Operation extends keyof operations>(operation: Operation, query: QueryParams<Operation>): string {
  void operation;
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) for (const item of value) parameters.append(name, String(item));
    else parameters.set(name, String(value));
  }
  return parameters.toString();
}
