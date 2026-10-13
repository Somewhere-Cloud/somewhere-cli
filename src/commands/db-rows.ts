import type { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { error, table, info } from '../lib/output.js';

interface RowsOptions { project?: string; where: string[]; limit: string; offset: string; json?: boolean }
interface RowsResult {
  plane: 'managed'; rows: Array<Record<string, unknown>>; columns: string[];
  total: number; limit: number; offset: number;
}
const integer = (raw: string, min: number, max: number, name: string): number => {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return Number(raw);
};

export function registerDbRows(db: Command): void {
  db.command('rows <table>')
    .description('Read declared managed rows from production data (read-only; developer access required)')
    .option('--project <id>', 'Project ID (defaults to the linked project)')
    .option('--where <column=value>', 'Equality filter; value is text unless a JSON number or null; repeat for AND',
      (value: string, previous: string[]) => [...previous, value], [])
    .option('--limit <number>', 'Maximum rows, 1–500', '50')
    .option('--offset <number>', 'Rows to skip', '0')
    .option('--json', 'Print the complete managed inspection response as JSON')
    .action(async (tableName: string, opts: RowsOptions) => {
      try {
        const projectId = opts.project ?? loadProjectConfig()?.project_id;
        if (!projectId) throw new Error('No project. Pass --project <id> or run from a linked directory.');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) throw new Error('table must be a declared table name.');
        if (opts.where.length > 32) throw new Error('--where accepts at most 32 filters.');
        const filters = opts.where.map(entry => {
          const split = entry.indexOf('=');
          const column = entry.slice(0, split);
          if (split < 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) throw new Error('--where must be column=value.');
          const raw = entry.slice(split + 1);
          let value: string | number | null = raw;
          try { const parsed: unknown = JSON.parse(raw); if (parsed === null || (typeof parsed === 'number' && Number.isFinite(parsed))) value = parsed; } catch { /* Plain text equality. */ }
          return { column, op: 'eq', value };
        });
        const limit = integer(opts.limit, 1, 500, 'limit');
        const offset = integer(opts.offset, 0, Number.MAX_SAFE_INTEGER, 'offset');
        const result = await new ApiClient(getToken()).call<RowsResult>('POST', '/db/rows', {
          project_id: projectId, plane: 'managed', table: tableName, filters, limit, offset,
        });
        if (!result || result.plane !== 'managed')
          throw new Error('The server did not confirm the managed database plane. Nothing is displayed; update the platform before retrying.');
        if (!Array.isArray(result.rows) || !Array.isArray(result.columns) || result.columns.some(column => typeof column !== 'string')
          || !Number.isSafeInteger(result.total) || result.total < 0 || result.limit !== limit || result.offset !== offset)
          throw new Error('Invalid managed row inspection response.');
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        table(result.columns, result.rows.map(row => result.columns.map(column => JSON.stringify(row[column]) ?? 'null')));
        info(`${result.rows.length} of ${result.total} rows · production managed data`);
      } catch (cause) { error(cause instanceof Error ? cause.message : String(cause), cause); process.exit(1); }
    });
}
