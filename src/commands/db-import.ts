import { readFile, stat } from 'node:fs/promises';
import type { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken } from '../lib/config.js';
import { error, printJson } from '../lib/output.js';
import { resolveProjectRef } from '../lib/platform-command.js';

interface ImportOptions {
  project?: string;
  source?: string;
  all?: boolean;
  orderBy?: string;
  resume?: boolean;
  job?: string;
}

export function registerDbImport(db: Command) {
  db.command('import [tables...]')
    .description('Generate a table declaration or import Supabase tables or app users')
    .option('--source <source>', 'Import from supabase or import users from a CSV file')
    .option('--project <id>', 'Project ID (defaults to the linked project)')
    .option('--all', 'Copy all exposed Supabase tables')
    .option('--order-by <column>', 'Stable unique column for a table without a single supported primary key')
    .option('--resume', 'Skip existing destination primary keys')
    .option('--job <id>', 'Read the progress and receipt of a Supabase import job')
    .action(async (tables: string[], options: ImportOptions) => {
      if (options.source !== undefined && options.source !== 'supabase' && options.source !== 'users') {
        error('--source must be supabase or users when provided.');
        process.exitCode = 1;
        return;
      }
      if (options.source === 'users') {
        if (tables.length !== 1 || tables[0] === '-' || options.all || options.orderBy || options.resume || options.job) {
          error('Use somewhere db import --source users users.csv with one CSV file.');
          process.exitCode = 1;
          return;
        }
        let csv: string;
        try {
          const file = await stat(tables[0]);
          if (!file.isFile() || file.size > 5 * 1024 * 1024) {
            error('Send a user CSV file up to 5 MB.');
            process.exitCode = 1;
            return;
          }
          csv = await readFile(tables[0], 'utf8');
        } catch {
          error('Could not read the user CSV file.');
          process.exitCode = 1;
          return;
        }
        const project = resolveProjectRef(options.project);
        const client = new ApiClient(getToken());
        printJson(await client.call('POST', '/auth/import', { project_id: project, csv }, undefined, { timeoutMs: 90_000 }));
        return;
      }
      const supabase = options.source === 'supabase';
      if (!supabase && (tables.length !== 1 || options.all || options.orderBy || options.resume || options.job)) {
        error('Name one table to generate its declaration, or use --source supabase.');
        process.exitCode = 1;
        return;
      }
      if (options.all && tables.length || options.job && (options.all || tables.length || options.orderBy || options.resume)) {
        error('Choose one import operation: name tables, use --all, or read --job.');
        process.exitCode = 1;
        return;
      }
      const project = resolveProjectRef(options.project);
      const body = supabase ? {
        source: 'supabase',
        tables: options.all ? 'all' : tables.length ? tables : undefined,
        order_by: options.orderBy,
        resume: options.resume,
        job_id: options.job,
      } : { table: tables[0] };
      const client = new ApiClient(getToken());
      printJson(await client.call('POST', '/db/import', { project_id: project, ...body }, undefined, { timeoutMs: 90_000 }));
    });
}
