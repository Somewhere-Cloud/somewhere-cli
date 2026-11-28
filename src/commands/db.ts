import { cliInvocation } from '../lib/cli-invocation.js';
import { createWriteStream, writeFileSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { registerDbImport } from './db-import.js';
import { registerDbRows } from './db-rows.js';
import { Command } from 'commander';
import ora from '../lib/spinner.js';
import { ApiClient, CliApiError } from '../lib/client.js';

/** A background export (POST /v1/db/exports) as the platform reports it. */
interface DbExport { id: string; state: string; plane?: string; size_bytes: number; tables: number; rows: number; exact: boolean | null; detail: string | null; consistency: string | null }
const sizeText = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`;

/** A database too large for one dump response: export it in the background, wait, then stream the file.
 * False when the platform does not offer background exports for this project (404): the caller then
 * reports the dump's own refusal, as before. */
async function backgroundExport(client: ApiClient, projectId: string, plane: string | undefined, output: string | undefined, json: boolean, spinner: ReturnType<typeof ora> | null): Promise<boolean> {
  // One machine-readable result: with --json the file goes to --output, never mixed with JSON on stdout.
  if (json && !output) throw new Error('This database is exported in the background as a file: pass --output <file> with --json.');
  const wanted = plane ?? 'raw';
  if (spinner) spinner.text = 'The database is larger than one dump response; exporting it in the background…';
  let current: DbExport;
  try {
    current = (await client.call<{ export: DbExport }>('POST', '/db/exports', { project_id: projectId, ...(plane ? { plane } : {}) })).export;
  } catch (err) {
    if (err instanceof CliApiError && err.statusCode === 404 && err.code === 'NOT_FOUND') return false;
    throw err;
  }
  while (current.state === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    current = (await client.call<{ export: DbExport }>('GET', `/db/exports/${encodeURIComponent(current.id)}`, undefined, { project_id: projectId })).export;
    if (spinner) spinner.text = `Exporting in the background: ${current.rows.toLocaleString()} rows, ${sizeText(current.size_bytes)} so far…`;
  }
  if (current.state !== 'ready') throw new Error(current.detail ?? `The export ended ${current.state}.`);
  // Checked before any byte is written: never save one plane's tables as the other's.
  if ((current.plane ?? 'raw') !== wanted) throw new Error(`The platform returned an export of the ${current.plane} tables, not the ${wanted} ones. Nothing was written.`);
  const response = await client.callStream('GET', `/db/exports/${encodeURIComponent(current.id)}/sql?project_id=${encodeURIComponent(projectId)}`, undefined, { timeoutMs: 4 * 60 * 60_000 });
  if (!response.ok || !response.body) throw new Error(`Downloading the export failed (HTTP ${response.status}).`);
  const body = Readable.fromWeb(response.body as never);
  if (output) {
    // Private like the data it holds (0600), written beside the target and renamed over it only when complete.
    const temp = join(dirname(output), `.${basename(output)}.${randomUUID()}.tmp`);
    try {
      await pipeline(body, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      await rename(temp, output);
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      throw err;
    }
  } else {
    spinner?.stop();
    await pipeline(body, process.stdout, { end: false });
  }
  const summary = `${current.tables} tables, ${current.rows} rows, ${sizeText(current.size_bytes)}${current.consistency ? `. ${current.consistency}` : ''}`;
  if (json) printJson({ export: current, output });
  else if (output) spinner?.succeed(`Wrote ${output} (${summary})`);
  else process.stderr.write(dim(summary) + '\n');
  return true;
}
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, printJson, success, table, teal, yellow } from '../lib/output.js';
import { unlinkedFolderHint } from '../lib/link-hint.js';

// Fields consumed by the human-readable adapter. --json preserves the complete
// canonical response, including count/last_row_id and transport metadata.
interface QueryResult {
  data: Array<Record<string, unknown>>;
  changes: number;
  duration_ms?: number;
}

export function registerDb(program: Command) {
  const db = program.command('db').description('Inspect managed production rows or run SQL against your raw database');
  registerDbRows(db);
  registerDbImport(db);

  db
    .command('query <sql>')
    .description('Run a SQL query against the project database')
    .option('--project <id>', 'Project ID (defaults to .somewhere.json)')
    .option('--json', 'Print raw JSON instead of a table')
    .action(async (sql: string, opts) => {
      const client = new ApiClient(getToken());

      let projectId: string | undefined = opts.project;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project specified and no .somewhere.json found. Pass --project <id>.' + unlinkedFolderHint());
          process.exit(1);
        }
        projectId = config.project_id;
      }

      // --json must emit ONLY the JSON envelope on stdout — no spinner noise
      // (the "Running query..." line broke scripting; audit #6). Skip the
      // spinner entirely in --json mode rather than relying on the stream.
      const spinner = opts.json ? null : ora('Running query...').start();
      try {
        const r = await client.call<QueryResult>('POST', '/db/query', {
          project_id: projectId,
          sql,
        });
        spinner?.stop();

        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }

        if (!r || !Array.isArray(r.data) || typeof r.changes !== 'number') {
          throw new Error('Invalid database query response: expected canonical data and changes.');
        }
        if (r.data.length === 0) {
          const affected = r.changes;
          if (typeof affected === 'number' && affected > 0) {
            success(`${affected} row${affected === 1 ? '' : 's'} affected${r.duration_ms != null ? dim(` (${r.duration_ms}ms)`) : ''}`);
          } else {
            // Explicit SUCCESS, not a warning — an agent seeing "No rows
            // returned." after CREATE/INSERT couldn't tell success from a
            // silent failure. Failures error loudly above.
            success('OK — no rows returned (normal for DDL and zero-row writes; failures error loudly).');
          }
          return;
        }

        const headers = Object.keys(r.data[0]);
        const stringify = (v: unknown): string => {
          if (v === null || v === undefined) return dim('null');
          if (typeof v === 'object') return JSON.stringify(v);
          return String(v);
        };
        const tableRows = r.data.map((row) => headers.map((h) => stringify(row[h])));
        table(headers, tableRows);
        console.log('');
        info(dim(`${r.data.length} row${r.data.length === 1 ? '' : 's'}${r.duration_ms != null ? ` · ${r.duration_ms}ms` : ''}`));
      } catch (err) {
        spinner?.fail('Query failed');
        error(err instanceof Error ? err.message : String(err), err);
        process.exit(1);
      }
    });

  db
    .command('apply-schema [path]', { hidden: true })
    .description(`Schema changes ship with deploy: edit db/schema.ts and run ${cliInvocation()} deploy`)
    .option('--project <id>', 'Project ID')
    .option('--json', 'Print the error as JSON')
    .action((_schemaPath: string | undefined, opts: { json?: boolean }) => {
      const message = `Schema changes ship with deploy: edit db/schema.ts, then run ${cliInvocation()} deploy from the app root with the complete app source (or create a preview). That release applies the schema. Nothing was changed.`;
      if (opts.json) printJson({ ok: false, error: 'SCHEMA_APPLY_RETIRED', message });
      else error(`SCHEMA_APPLY_RETIRED: ${message}`);
      process.exitCode = 1;
    });

  db
    .command('dump')
    .description(`Export the database as SQL (schema + every row). Pipe to a file: ${cliInvocation()} db dump > backup.sql. Tables declared in db/schema.ts: --plane managed (project owner only); what each plane holds: --manifest`)
    .option('--project <id>', 'Project ID (defaults to .somewhere.json)')
    .option('--plane <plane>', 'raw (SQL tables, default) or managed (tables declared in db/schema.ts; owner only)')
    .option('--manifest', 'Print the export manifest (tables per plane, name collisions, schema and access) as JSON')
    .option('-o, --output <file>', 'Write to file instead of stdout')
    .option('--json', 'Print the dump response as JSON')
    .action(async (opts) => {
      if (opts.plane !== undefined && opts.plane !== 'raw' && opts.plane !== 'managed') {
        error('--plane must be raw or managed.');
        process.exit(1);
      }
      if (opts.manifest && opts.plane !== undefined) {
        error('--manifest describes both planes; it takes no --plane.');
        process.exit(1);
      }
      let projectId: string | undefined = opts.project;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project specified and no .somewhere.json found. Pass --project <id>.' + unlinkedFolderHint());
          process.exit(1);
        }
        projectId = config.project_id;
      }

      const client = new ApiClient(getToken());
      const spinner = opts.json || opts.manifest ? null : ora('Dumping database…').start();
      try {
        const res = await client.callRaw('POST', '/db/dump', {
          project_id: projectId,
          ...(opts.manifest ? { format: 'manifest' } : {}),
          ...(opts.plane ? { plane: opts.plane } : {}),
        });

        if (!res.ok) {
          type Refusal = { error?: string; data?: { background_export?: unknown } };
          let refused: Refusal | null = null;
          try { refused = JSON.parse(res.body) as Refusal; } catch { refused = null; }
          // Too large for one response, in either plane: the background export copies it, but only when the
          // refusal itself says this project and credential can start one. Otherwise it is reported as sent.
          if (res.status === 413 && refused?.data?.background_export === true && !opts.manifest
            && ['DUMP_SIZE_LIMIT_EXCEEDED', 'DUMP_ROW_LIMIT_EXCEEDED', 'EXPORT_SIZE_LIMIT_EXCEEDED', 'EXPORT_ROW_LIMIT_EXCEEDED'].includes(refused.error ?? '')) {
            if (await backgroundExport(client, projectId!, opts.plane, opts.output, Boolean(opts.json), spinner)) return;
          }
          spinner?.fail('Dump failed');
          try {
            const json = JSON.parse(res.body) as { error?: string; message?: string };
            error(`${json.error ?? 'ERROR'}: ${json.message ?? res.body.slice(0, 200)}`);
          } catch {
            error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
          }
          process.exit(1);
        }

        // Checked before any file is created or any byte reaches stdout. An API that
        // predates managed export ignores plane/format and answers 200 with the RAW
        // SQL dump, which must never be saved as the managed tables or as a manifest.
        if (opts.manifest) {
          let manifest: { ok?: unknown; data?: { version?: unknown; planes?: unknown } } | null = null;
          try { manifest = JSON.parse(res.body); } catch { manifest = null; }
          if (!manifest || typeof manifest !== 'object' || typeof manifest.data?.version !== 'number' || !manifest.data.planes) {
            error('The API did not return an export manifest (it predates managed export). Nothing was written.');
            process.exit(1);
          }
          if (opts.output) writeFileSync(opts.output, res.body, { mode: 0o600 });
          else process.stdout.write(res.body + '\n');
          return;
        }
        if (opts.plane === 'managed' && res.headers['x-dump-plane'] !== 'managed') {
          spinner?.fail('Dump failed');
          error('The API did not return the managed tables (it predates managed export). Nothing was written.');
          process.exit(1);
        }

        const sql = res.body;
        const tables = res.headers['x-tables'] ?? '?';
        const rows = res.headers['x-rows'] ?? '?';
        const truncated = res.headers['x-truncated-tables'];
        const dumpResult = {
          sql,
          tables,
          rows,
          truncated_tables: truncated ?? null,
        };

        if (opts.output) {
          writeFileSync(opts.output, sql, { mode: 0o600 });
          if (opts.json) {
            printJson(dumpResult);
          } else {
            spinner?.succeed(`Wrote ${opts.output} (${tables} tables, ${rows} rows)`);
          }
        } else {
          spinner?.stop();
          if (opts.json) {
            printJson(dumpResult);
          } else {
            process.stdout.write(sql);
            // Summary to STDERR — stdout must stay pure SQL for `db dump > backup.sql`.
            process.stderr.write(dim(`${tables} tables, ${rows} rows`) + '\n');
          }
        }
        if (truncated && !opts.json) {
          // stderr for the same reason (applies to the piped-dump path).
          process.stderr.write(
            yellow(`⚠ Per-table row cap hit on: ${truncated} — contact support for a streaming dump if needed.`) + '\n',
          );
        }
      } catch (err) {
        spinner?.fail('Dump failed');
        error(err instanceof Error ? err.message : String(err), err);
        process.exit(1);
      }
    });

  db
    .command('restore-points')
    .description('List database restore points (project owner only)')
    .option('--project <id>', 'Project ID (defaults to .somewhere.json)')
    .option('--take', 'Take a restore point now')
    .option('--delete <id>', 'Delete one restore point now')
    .option('--restore <id>', 'Inspect or restore a database history point')
    .option('--confirm-app <name>', 'Confirm the exact app name. Members, groups and roles return to the saved moment.')
    .option('--json', 'Print the API response as JSON')
    .action(async (opts) => {
      if ([opts.take, opts.delete, opts.restore].filter(Boolean).length > 1 || (opts.confirmApp && !opts.restore)) {
        error('Choose one action. --confirm-app requires --restore.');
        process.exit(1);
      }
      let projectId: string | undefined = opts.project;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project specified and no .somewhere.json found. Pass --project <id>.' + unlinkedFolderHint());
          process.exit(1);
        }
        projectId = config.project_id;
      }
      type Point = { id: string; kind?: 'backup' | 'history'; reason: string; state: string; taken_at: string; expires_at: string; size_bytes: number; tables: number; rows: number; exact: boolean | null; detail: string | null; consistency?: string | null; validation?: string | null };
      const size = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`;
      const client = new ApiClient(getToken());
      try {
        if (opts.restore) {
          type Restore = { confirmed: false; app: string; point_id: string; expires_at: string; moments: Array<{ plane: string; at: string }>; warning: string }
            | { confirmed: true; undo_point_id: string };
          if (opts.confirmApp && !opts.json) {
            info('Restoring returns the app’s members, groups and roles to the recorded moment. People removed since then will have access again; remove them again after the restore. Completion can take a minute while cached sign-ins expire.');
          }
          const result = await client.call<Restore>('POST', `/db/restore-points/${encodeURIComponent(opts.restore)}/restore`, {
            project_id: projectId,
            ...(opts.confirmApp ? { confirm: { app: opts.confirmApp, point: opts.restore } } : {}),
          }, undefined, opts.confirmApp ? { timeoutMs: 240_000 } : undefined);
          if (opts.json) { printJson(result); return; }
          if (result.confirmed) { success(`Database restored. Undo point: ${result.undo_point_id}.`); return; }
          info(result.warning);
          for (const moment of result.moments) info(`${moment.plane}: ${moment.at}`);
          info(`Confirm app "${result.app}" and point ${result.point_id} before ${result.expires_at}. Repeat with --confirm-app and the exact app name to restore.`);
          return;
        }
        if (opts.take) {
          const spinner = opts.json ? null : ora('Taking a restore point…').start();
          // Taken in the background: wait for it to finish (or fail) and say which.
          let point = (await client.call<{ restore_point: Point }>('POST', '/db/restore-points', { project_id: projectId })).restore_point;
          for (let waited = 0; point.state === 'running' && waited < 30 * 60_000; waited += 3000) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const listed = await client.call<{ restore_points: Point[] }>('GET', '/db/restore-points', undefined, { project_id: projectId });
            point = listed.restore_points.find((p) => p.id === point.id) ?? { ...point, state: 'failed', detail: 'It is no longer listed.' };
            if (spinner && point.rows) spinner.text = `Taking a restore point… ${point.rows.toLocaleString()} rows so far`;
          }
          if (opts.json) { printJson({ restore_point: point }); if (point.state !== 'ready') process.exitCode = 1; return; }
          if (point.state === 'running') { spinner?.succeed(`Restore point ${point.id} is still being taken; \`${cliInvocation()} db restore-points\` shows when it is ready.`); return; }
          if (point.state !== 'ready') { spinner?.fail(`No restore point was taken: ${point.detail ?? point.state}`); process.exitCode = 1; return; }
          if (point.kind === 'history') spinner?.succeed(`Database history point ${point.id} recorded. It expires at ${point.expires_at}.`);
          else spinner?.succeed(`Restore point ${point.id} taken (${size(point.size_bytes)}, ${point.tables} tables, ${point.rows} rows); kept until ${point.expires_at}.`);
          // How it was read and what was checked, as the platform states them.
          for (const line of [point.consistency, point.validation]) if (line) info(dim(line));
          return;
        }
        if (opts.delete) {
          const r = await client.call<{ deleted: string }>('DELETE', `/db/restore-points/${encodeURIComponent(opts.delete)}`, undefined, { project_id: projectId });
          if (opts.json) { printJson(r); return; }
          success(`Deleted restore point ${r.deleted}.`);
          return;
        }
        const r = await client.call<{ restore_points: Point[]; restore?: { point_id: string; message: string } | null }>('GET', '/db/restore-points', undefined, { project_id: projectId });
        if (opts.json) { printJson(r); return; }
        if (r.restore) info(`${r.restore.point_id}: ${r.restore.message}`);
        if (!r.restore_points.length) {
          info(dim(`No restore points yet. Take one now with \`${cliInvocation()} db restore-points --take\`; the platform also takes them before deploys that change the database (when it can finish within the deploy's wait) and daily when the data changed.`));
          return;
        }
        table(
          ['Restore point', 'Taken', 'Why', 'State', 'Size', 'Expires'],
          r.restore_points.map((p) => [teal(p.id), p.taken_at, p.reason, p.state === 'ready' ? (p.exact === false ? 'ready (read while running)' : 'ready') : `${p.state}${p.detail ? `: ${p.detail}` : ''}`, p.state === 'ready' && p.kind !== 'history' ? size(p.size_bytes) : dim('—'), p.expires_at]),
        );
        // Qualifications beyond a single exact read (for example a project with two databases, read at two moments).
        for (const p of r.restore_points) if ((p.state === 'ready' || p.kind === 'history') && p.consistency && p.consistency !== 'Read in one moment: an exact copy.') info(dim(`${p.id}: ${p.consistency}`));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err), err);
        process.exit(1);
      }
    });

  db
    .command('tables')
    .description('List tables in the project database')
    .option('--project <id>', 'Project ID (defaults to .somewhere.json)')
    .option('--json', 'Print the raw tables response as JSON')
    .action(async (opts) => {
      const client = new ApiClient(getToken());

      let projectId: string | undefined = opts.project;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          error('No project specified and no .somewhere.json found. Pass --project <id>.' + unlinkedFolderHint());
          process.exit(1);
        }
        projectId = config.project_id;
      }

      try {
        const r = await client.call<{ tables: Array<string | { name: string; row_count?: number }>; hint?: string }>(
          'GET',
          '/db/tables',
          undefined,
          { project_id: projectId },
        );
        if (opts.json) {
          printJson(r);
          return;
        }
        // The API returns tables as an array of NAME STRINGS. (The old CLI read
        // them as { name, row_count } objects, so every name came back empty and
        // every row count printed "?" — audit #5.) Normalize defensively so a
        // future object shape still works.
        const rows = (r.tables ?? []).map((t) => (typeof t === 'string' ? { name: t } : t));
        if (rows.length) {
          table(
            ['Table', 'Rows'],
            rows.map((t) => [teal(t.name), t.row_count != null ? String(t.row_count) : dim('—')]),
          );
        } else {
          info(dim('No tables yet.'));
        }
        const hint = r.hint ?? (rows.length ? undefined : 'To add declared tables, define them in db/schema.ts and deploy.');
        if (hint) info(dim(hint));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err), err);
        process.exit(1);
      }
    });
}
