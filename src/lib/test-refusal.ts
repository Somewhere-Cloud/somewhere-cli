import { classifyData } from './app-test.js';
import { scrub } from './test-diagnostics.js';
import type { DataRequest } from './test-session.js';

export interface RefusalResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface RefusalClient {
  endpoint(method: string, path: string, body: unknown): Promise<RefusalResponse>;
  data(table: string, request: DataRequest): Promise<RefusalResponse>;
}

const ENDPOINT = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;
async function bodyOf(response: RefusalResponse): Promise<{ code: string; message: string; json: Record<string, unknown> | null }> {
  let json: Record<string, unknown> | null = null;
  try { json = await response.json() as Record<string, unknown>; } catch { /* not JSON */ }
  const raw = typeof json?.error === 'string' ? json.error : '';
  return { code: /^[A-Z_]+$/.test(raw) ? raw : 'none', message: typeof json?.message === 'string' ? scrub(json.message).slice(0, 300) : '', json };
}
const INCONCLUSIVE = 'looks the same as an empty table, a missing row or a missing route, so it proves nothing on its own. Pass { allowed: <someone the same request succeeds for> } as the positive control.';
function seen(status: number, code: string, message: string): string {
  const kind = status === 400 ? 'a malformed request' : status === 409 ? 'a stale data contract' : `HTTP ${status}`;
  return `${kind} (${status} ${code}${message ? `: ${message}` : ''})`;
}
export async function assertRefused(
  client: RefusalClient, target: string, request: unknown, allowed?: RefusalClient,
): Promise<void> {
  const endpoint = ENDPOINT.exec(target);
  if (endpoint) {
    const [, method, path] = endpoint;
    const payload = method === 'GET' ? undefined : request;
    const response = await client.endpoint(method, path, payload);
    const status = response.status;
    const { code, message } = await bodyOf(response);
    const said = `${target} answered ${seen(status, code, message)}`;
    if (status < 400) throw new Error(`expectRefused: ${said}: this person could call the endpoint.`);
    if (status === 400 || status === 422) throw new Error(`expectRefused: ${said}: the endpoint rejected the input, which says nothing about who is asking. Send a body it accepts from someone who may.`);
    if (![401, 403, 404].includes(status)) throw new Error(`expectRefused: ${said}: a refusal is 401, 403 or 404.`);
    if (status === 404 && !allowed) throw new Error(`expectRefused: ${said}: a 404 ${INCONCLUSIVE}`);
    if (allowed) {
      const control = await allowed.endpoint(method, path, payload);
      const c = await bodyOf(control);
      if (control.status >= 300) throw new Error(`expectRefused: ${said}, but the allowed person got ${seen(control.status, c.code, c.message)} too, so the route or input is wrong and the refusal is not proven.`);
    }
    return;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) throw new Error(`expectRefused: "${target}" is neither a table name nor 'METHOD /path'.`);
  if (!request || typeof request !== 'object' || typeof (request as { operation?: unknown }).operation !== 'string') {
    throw new Error(`expectRefused: pass a data request for table ${target}, for example { operation: 'get', id }.`);
  }
  const operation = (request as { operation: string }).operation;
  const reading = operation === 'get' || operation === 'list' || operation === 'relation_list';
  const writing = operation === 'update' || operation === 'delete';
  const id = (request as { id?: string | number }).id;
  const rowOf = async (as: RefusalClient) => {
    const response = await as.data(target, { operation: 'get', id: id as string | number });
    const body = await bodyOf(response);
    if (response.status !== 200) throw new Error(`expectRefused: the allowed person could not read ${target} ${String(id)} (${seen(response.status, body.code, body.message)}), so choose a control that can read this row.`);
    return body.json?.data ?? null;
  };
  let before = '';
  if (writing && allowed) {
    const row = await rowOf(allowed);
    before = JSON.stringify(row);
    if (row === null) throw new Error(`expectRefused: ${target} ${String(id)} does not exist for the allowed person, so there is nothing to refuse. Create the row first.`);
  }
  const response = await client.data(target, request as DataRequest);
  const status = response.status;
  const { code, message, json } = await bodyOf(response);
  const said = `${operation} on ${target} answered ${seen(status, code, message)}`;
  const { kind } = classifyData(status, json, operation);
  if (kind === 'missing-contract' || kind === 'stale-contract' || kind === 'malformed') {
    throw new Error(`expectRefused: ${said}. Nothing ran, so this proves nothing about access.`);
  }
  const rows = json?.data;
  const empty = status === 200 && ((operation === 'get' && rows === null) || ((operation === 'list' || operation === 'relation_list') && Array.isArray(rows) && rows.length === 0));
  const missing = kind === 'missing-or-refused';
  if (status === 200 && !empty) {
    if (reading) throw new Error(`expectRefused: ${said}: this person read ${Array.isArray(rows) ? `${rows.length} row(s)` : 'the row'}.`);
    throw new Error(`expectRefused: ${said}: the ${operation} was allowed.`);
  }
  if (kind !== 'refused' && !empty && !missing) throw new Error(`expectRefused: ${said}: expected an access refusal.`);
  if ((empty || missing) && !allowed) throw new Error(`expectRefused: ${said}: ${empty ? 'an empty answer' : 'a 404'} ${INCONCLUSIVE}`);
  if (!allowed) return;
  if (reading) {
    const control = await allowed.data(target, request as DataRequest);
    const c = await bodyOf(control);
    const got = c.json?.data;
    const found = control.status === 200 && (operation === 'get' ? got !== null && got !== undefined : Array.isArray(got) && got.length > 0);
    if (!found) throw new Error(`expectRefused: ${said}, but the allowed person got ${control.status === 200 ? 'nothing' : seen(control.status, c.code, c.message)} for the same request, so there was nothing to refuse.`);
  } else if (writing) {
    const after = await rowOf(allowed);
    if (JSON.stringify(after) !== before) throw new Error(`expectRefused: ${said}, but ${target} ${String(id)} ${after === null ? 'is gone' : 'changed'} for the allowed person afterwards.`);
  }
}
