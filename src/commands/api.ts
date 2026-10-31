import { Command } from 'commander';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { ApiClient, CliApiError, incompleteResponseFailure, LONG_CALL_TIMEOUT_MS } from '../lib/client.js';
import { getToken } from '../lib/config.js';
import { operationLabel } from '../lib/repro-packet.js';
import { error, noteFailure, platformErrorEnvelope, printJson, printSupportPacketRecovery } from '../lib/output.js';

interface ApiCommandOptions {
  data?: string;
  dataFile?: string;
  contentType?: string;
  raw?: boolean;
  json?: boolean;
}

interface ApiEnvelope {
  ok?: boolean;
  data?: unknown;
  error?: string;
  message?: string;
  retry?: unknown;
  retry_after_ms?: unknown;
}

export function registerApi(program: Command) {
  program
    .command('api <method> <path>')
    .description('Make a raw API call (adds auth automatically)')
    .option('-d, --data <json>', 'JSON body')
    .option('--data-file <path>', 'Stream the request body from a file; use - for stdin')
    .option('--content-type <type>', 'Content type for --data-file (defaults to JSON for .json/stdin, otherwise octet-stream)')
    .option('--raw', 'Print the response body as-is without JSON-parsing — for non-JSON endpoints (e.g. a SQL db dump); a 200 non-JSON body is not treated as an error')
    .option('--json', 'Print parsed JSON (the default; accepted for automation consistency)')
    .action(async (method: string, path: string, opts: ApiCommandOptions) => {
      if (opts.raw && opts.json) {
        error('--raw and --json cannot be used together.');
        process.exit(1);
      }
      if (opts.data !== undefined && opts.dataFile !== undefined) {
        error('--data and --data-file cannot be used together.');
        process.exit(1);
      }
      const client = new ApiClient(getToken());
      let body: unknown;
      if (opts.data) {
        try {
          body = JSON.parse(opts.data);
        } catch {
          error('--data must be valid JSON');
          process.exit(1);
        }
      }

      const normalized = normalizeApiPath(path);
      if ('error' in normalized) {
        error(normalized.error);
        process.exit(1);
      }
      const apiPath = normalized.path;
      const withOperation = (cause: unknown): unknown => {
        if (cause instanceof CliApiError && !('operation' in cause)) {
          Object.defineProperty(cause, 'operation', { value: operationLabel(method, apiPath), enumerable: false });
        }
        return cause;
      };
      const capture = (cause: unknown): void => {
        noteFailure(withOperation(cause));
        printSupportPacketRecovery(cause);
      };
      const responseFailure = (status: number, header: (name: string) => string | null | undefined, payload?: ApiEnvelope): CliApiError =>
        withOperation(new CliApiError(
          typeof payload?.error === 'string' ? payload.error : 'HTTP_ERROR', '', status,
          undefined, undefined, {
            requestId: header('x-request-id') ?? undefined,
            traceId: header('x-trace-id') ?? undefined,
            ...(typeof payload?.retry === 'boolean' ? { retry: payload.retry } : {}),
            ...(typeof payload?.retry_after_ms === 'number' ? { retryAfterMs: payload.retry_after_ms } : {}),
          },
        )) as CliApiError;

      if (opts.dataFile !== undefined) {
        let responseCapture: CliApiError | undefined;
        try {
          const stdin = opts.dataFile === '-';
          const source = stdin ? undefined : resolve(opts.dataFile);
          const file = source ? await stat(source) : undefined;
          if (file && !file.isFile()) throw new Error(`${opts.dataFile} is not a file.`);
          const headers: Record<string, string> = {
            'Content-Type': opts.contentType ?? dataFileContentType(opts.dataFile),
          };
          if (file) headers['Content-Length'] = String(file.size);
          const response = await client.callStream(
            method.toUpperCase(),
            apiPath,
            () => source ? createReadStream(source) : process.stdin,
            {
              headers,
              timeoutMs: LONG_CALL_TIMEOUT_MS,
              replayableBody: Boolean(source),
            },
          );

          if (opts.raw) {
            if (response.body) {
              try { for await (const chunk of response.body) process.stdout.write(chunk); }
              catch (cause) {
                responseCapture = incompleteResponseFailure(cause, response.status, name => response.headers.get(name));
                throw cause;
              }
            }
            if (!response.ok) {
              capture(responseFailure(response.status, name => response.headers.get(name)));
              process.exitCode = 1;
            }
            return;
          }

          let payload: ApiEnvelope;
          try {
            let text: string;
            try { text = await response.text(); }
            catch (cause) {
              responseCapture = incompleteResponseFailure(cause, response.status, name => response.headers.get(name));
              throw cause;
            }
            payload = JSON.parse(text) as ApiEnvelope;
          } catch {
            responseCapture ??= new CliApiError('INVALID_RESPONSE', '', response.status, undefined, undefined, {
              requestId: response.headers.get('x-request-id') ?? undefined,
              traceId: response.headers.get('x-trace-id') ?? undefined,
            });
            throw new CliApiError(
              'INVALID_RESPONSE',
              `Non-JSON response (${response.status}). Use --raw to print it.`,
              response.status,
            );
          }
          if (response.ok && payload.ok === true) {
            printJson(payload.data);
            return;
          }
          printJson({
            ok: false,
            error: payload.error ?? 'UNKNOWN',
            message: payload.message ?? 'Unknown error',
            status: response.status,
          });
          capture(responseFailure(response.status, name => response.headers.get(name), payload));
          process.exit(1);
        } catch (err) {
          const captured = withOperation(responseCapture ?? err);
          error(err instanceof Error ? err.message : String(err), err, captured);
          printSupportPacketRecovery(captured);
          process.exit(1);
        }
      }

      // Raw mode: stream the response body verbatim. A 200 with a non-JSON body
      // (e.g. /v1/db/dump returns SQL) must NOT be an error (audit #14).
      if (opts.raw) {
        try {
          const r = await client.callRaw(method.toUpperCase(), apiPath, body, { captureIncompleteBody: true });
          process.stdout.write(r.body.endsWith('\n') ? r.body : r.body + '\n');
          if (!r.ok) capture(responseFailure(r.status, name => r.headers[name]));
          if (!r.ok) process.exitCode = 1;
        } catch (err) {
          const captured = withOperation(err);
          const displayed = err instanceof CliApiError && err.meta.responseBodyIncomplete ? err.originalCause : err;
          error(String(displayed), displayed, captured);
          printSupportPacketRecovery(captured);
          process.exit(1);
        }
        return;
      }

      try {
        const result = await client.call(method.toUpperCase(), apiPath, body);
        printJson(result);
      } catch (err) {
        if (err instanceof Error && 'code' in err) {
          capture(err);
          const apiErr = err as Error & { code: string; statusCode: number };
          const platform = platformErrorEnvelope(err);
          printJson({
            ok: false,
            error: apiErr.code,
            message: platform?.message ?? apiErr.message,
            status: apiErr.statusCode,
            ...(platform?.extra ?? {}),
          });
        } else {
          error(String(err), withOperation(err));
          printSupportPacketRecovery(err);
        }
        process.exit(1);
      }
    });
}

/**
 * Keep a raw API call inside the configured API origin and its /v1 prefix
 * (pfb_8cef4606e9a3). A full URL, a protocol-relative or backslash path, a
 * fragment, or any `.`/`..` segment (percent-encoded too) is refused before a
 * request carries the token anywhere. A leading /v1 is accepted and dropped,
 * a missing leading slash is added, and the query string is kept.
 */
export function normalizeApiPath(input: string): { path: string } | { error: string } {
  const refuse = (why: string) => ({ error: `Not sent: ${why}. Give a path under the API, such as /projects or /projects?limit=5.` });
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return refuse('`somewhere api` takes a path, not a full URL');
  if (input.startsWith('//') || input.includes('\\')) return refuse('the path must not start with // or contain a backslash');
  if (input.includes('#')) return refuse('the path must not contain a fragment (#)');
  const queryAt = input.indexOf('?');
  const rawPath = queryAt === -1 ? input : input.slice(0, queryAt);
  const query = queryAt === -1 ? '' : input.slice(queryAt);
  const segments = rawPath.split('/').filter((segment, i) => !(i === 0 && segment === ''));
  for (const segment of segments) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { return refuse('the path has an invalid percent-encoding'); }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      return refuse('the path must not contain . or .. segments or encoded slashes');
    }
  }
  const withoutPrefix = segments[0] === 'v1' ? segments.slice(1) : segments;
  return { path: `/${withoutPrefix.join('/')}${query}` };
}

function dataFileContentType(path: string): string {
  if (path === '-' || extname(path).toLowerCase() === '.json') return 'application/json';
  return 'application/octet-stream';
}
