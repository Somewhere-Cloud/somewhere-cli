import { cliInvocation } from '../lib/cli-invocation.js';
import { Command } from 'commander';
import { callPlatformTool } from '../lib/platform-tools.js';
import {
  compactRecord,
  isRecord,
  parseCommaList,
  resolveProjectRef,
  truncateText,
  unwrapPlatformData,
} from '../lib/platform-command.js';
import { dim, error, printJson, table, teal, timeAgo } from '../lib/output.js';

interface ProjectOptions {
  project?: string;
  json?: boolean;
}

interface TaskListOptions extends ProjectOptions {
  status?: string;
  type?: string;
  assignee?: string;
  label?: string;
  area?: string;
  parent?: string;
  query?: string;
  active?: boolean;
  stale?: boolean;
  staleDays?: string;
  sort?: string;
  full?: boolean;
  limit?: string;
  offset?: string;
  cursor?: string;
}

interface TaskReadOptions extends ProjectOptions {
  view?: string;
  kind?: string;
  field?: string;
  eventId?: string;
  cursor?: string;
  offset?: string;
  limit?: string;
}

interface TaskWriteOptions extends ProjectOptions {
  description?: string;
  status?: string;
  priority?: string;
  type?: string;
  assignee?: string;
  labels?: string;
  area?: string;
  parent?: string;
  dueAt?: string;
  statusNote?: string;
  waitingOn?: string;
  author?: string;
  supersedes?: string;
  supersededBy?: string;
  health?: string;
  comment?: string;
  resolutionNote?: string;
  shippedIn?: string;
  deploymentProject?: string;
  deploymentVersion?: string;
}

function numberOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, received "${value}".`);
  return parsed;
}

function taskRows(value: unknown): string[][] {
  const data = unwrapPlatformData(value);
  if (!Array.isArray(data)) throw new Error('tasks_list returned an unexpected response.');
  return data.map((task) => {
    if (!isRecord(task)) return ['—', '—', '—', '—', '—'];
    const updated = typeof task.updated_at === 'number'
      ? timeAgo(new Date(task.updated_at).toISOString())
      : '—';
    return [
      typeof task.id === 'string' ? task.id : '—',
      truncateText(task.title, 56),
      typeof task.status === 'string' ? task.status : '—',
      typeof task.priority === 'string' ? task.priority : '—',
      updated,
    ];
  });
}

function printTaskMutation(value: unknown): void {
  const data = unwrapPlatformData(value);
  if (!isRecord(data)) {
    printJson(value);
    return;
  }
  const id = typeof data.id === 'string' ? data.id : null;
  const title = typeof data.title === 'string' ? data.title : null;
  const status = typeof data.status === 'string' ? data.status : null;
  console.log(`${teal(id ?? 'Task updated')}${title ? `  ${title}` : ''}${status ? `  ${dim(status)}` : ''}`);
  if (id) console.log(dim(`Next: ${cliInvocation()} tasks get ${id}`));
}

async function runTaskTool(
  name: string,
  args: Record<string, unknown>,
  json: boolean | undefined,
  printer: (value: unknown) => void,
): Promise<void> {
  try {
    const value = await callPlatformTool(name, args, { allTools: true });
    if (json) printJson(value);
    else printer(value);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err), err);
    process.exitCode = 1;
  }
}

/** What is waiting for the person, as the platform lists it: each item with its steps, reason, who asked and how to answer. */
function printWaiting(value: unknown): void {
  const data = unwrapPlatformData(value);
  const items = isRecord(data) && Array.isArray(data.items) ? data.items.filter(isRecord) : null;
  if (!items) { printJson(value); return; }
  if (items.length === 0) console.log('Nothing is waiting for you' + (isRecord(data) && data.next_cursor ? ' on the apps checked so far.' : '.'));
  for (const item of items) {
    const asked = isRecord(item.asked_by) ? item.asked_by : {};
    const via = isRecord(asked.via) ? asked.via : {};
    const who = [typeof asked.name === 'string' ? asked.name : null, typeof via.name === 'string' ? via.name : typeof via.kind === 'string' ? via.kind : null].filter(Boolean).join(' via ');
    const when = typeof item.asked_at === 'string' ? timeAgo(item.asked_at) : null;
    console.log(`${teal(String(item.id))}  ${String(item.title ?? '')}`);
    console.log(dim(`  ${[who || null, when, typeof item.project_name === 'string' ? item.project_name : null, item.kind === 'product_decision' ? 'a decision' : null].filter(Boolean).join(' · ')}`));
    const steps = Array.isArray(item.step_list) ? item.step_list.filter((step): step is string => typeof step === 'string') : [];
    const lines = Array.isArray(item.sentences) ? item.sentences.filter((line): line is string => typeof line === 'string') : [];
    for (const line of lines) console.log(`  ${line}`);
    steps.forEach((step, at) => console.log(`  ${at + 1}. ${step}`));
    if (steps.length === 0 && lines.length === 0 && typeof item.steps === 'string') console.log(`  ${item.steps.split('\n').join('\n  ')}`);
    if (typeof item.replaces === 'string' && item.replaces) console.log(dim(`  Replaces an earlier request: ${item.replaces}`));
    if (typeof item.why === 'string' && item.why) console.log(dim(`  Why: ${item.why}`));
    console.log(dim(`  Answer: ${cliInvocation()} tasks answer ${String(item.id)} -p ${String(item.project_id)} --done   (or --cannot, or --not-needed, with --note "...")`));
    console.log('');
  }
  // Answered and not yet picked up by the agent that asked: which answer, and the credential that gave it, as the platform recorded it.
  const answered = isRecord(data) && Array.isArray(data.answered) ? data.answered.filter(isRecord) : [];
  if (answered.length > 0) console.log(dim('Answered:'));
  for (const item of answered) {
    const by = isRecord(item.answered_by) ? item.answered_by : {};
    const via = isRecord(by.via) ? by.via : {};
    const kind = typeof via.kind === 'string' ? via.kind : 'unknown';
    const who = kind === 'dashboard' ? (by.you === true ? 'you, in the dashboard' : 'someone on the team, in the dashboard')
      : `${{ connector: 'connector', agent: 'connected agent', terminal: 'terminal', key: 'API key', app: 'the app' }[kind] ?? kind}${typeof via.name === 'string' ? ` ${via.name}` : ''}`;
    const when = typeof by.at === 'string' ? timeAgo(by.at) : null;
    console.log(`${teal(String(item.id))}  ${String(item.title ?? '')}`);
    console.log(dim(`  ${by.answer === 'cannot' ? 'Marked "can\'t do this"' : by.answer === 'not_needed' ? 'Marked as no longer needed' : 'Marked done'} by ${who}${when ? ` · ${when}` : ''}${typeof item.project_name === 'string' ? ` · ${item.project_name}` : ''}`));
    if (typeof item.note === 'string' && item.note) console.log(`  ${item.note}`);
  }
  if (isRecord(data) && typeof data.next_cursor === 'string') {
    const checked = typeof data.projects_checked === 'number' && typeof data.projects_total === 'number' ? `Checked ${data.projects_checked} of ${data.projects_total} apps. ` : '';
    console.log(dim(`${checked}Show the rest: ${cliInvocation()} tasks waiting --cursor ${data.next_cursor}`));
  }
}

function resolveTaskProject(project: string | undefined): string {
  return resolveProjectRef(project, ' Use -p default for the shared organization board if you have access.');
}

export function registerTasks(program: Command): void {
  const tasks = program
    .command('tasks')
    .description('List, read, create, update, answer, delete, and restore platform tasks')
    .addHelpText('after', `\nShared organization board (requires access): ${cliInvocation()} tasks list -p default`);

  tasks
    .command('list')
    .description('List tasks')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--status <status>', 'Filter by status')
    .option('--type <type>', 'Filter by type, or a comma-separated list (e.g. decision, directive)')
    .option('--assignee <assignee>', 'Filter by assignee')
    .option('--label <label>', 'Match an exact label')
    .option('--area <area>', 'Filter by area')
    .option('--parent <task-id>', 'Filter by parent task; use "null" for top-level tasks')
    .option('-q, --query <text>', 'Search task titles and descriptions')
    .option('--active', 'Only open and in-progress tasks')
    .option('--stale', 'Only stale in-progress tasks')
    .option('--stale-days <days>', 'Staleness threshold')
    .option('--sort <sort>', 'Sort by priority, updated, or created')
    .option('--full', 'Return complete descriptions')
    .option('--limit <n>', 'Maximum rows')
    .option('--offset <n>', 'Fresh row offset; prefer cursor for continuation')
    .option('--cursor <cursor>', 'next_cursor from the previous page; repeat filters')
    .option('--json', 'Print the complete response as JSON')
    .action(async (opts: TaskListOptions) => {
      const args = compactRecord([
        ['project_id', resolveTaskProject(opts.project)],
        ['status', opts.status],
        ['type', opts.type],
        ['assignee', opts.assignee],
        ['label', opts.label],
        ['area', opts.area],
        ['parent_id', opts.parent],
        ['q', opts.query],
        ['active', opts.active],
        ['stale', opts.stale],
        ['stale_days', numberOption(opts.staleDays)],
        ['sort', opts.sort],
        ['detail', opts.full ? 'full' : undefined],
        ['limit', numberOption(opts.limit)],
        ['offset', numberOption(opts.offset)],
        ['cursor', opts.cursor],
      ]);
      await runTaskTool('tasks_list', args, opts.json, (value) => {
        const rows = taskRows(value);
        if (rows.length === 0) console.log(dim('No matching tasks.'));
        else table(['ID', 'Title', 'Status', 'Priority', 'Updated'], rows);
        if (isRecord(value) && isRecord(value.page)) {
          const page = value.page;
          console.log(dim(`Showing ${page.count} of ${page.total}. Order: ${page.order ?? 'unspecified'}`));
          if (page.candidate_note) console.log(dim(String(page.candidate_note)));
          if (page.consistency) console.log(dim(String(page.consistency)));
          if (page.next_cursor) console.log(`Next page: repeat this command's filters with --cursor '${page.next_cursor}'`);
        }
        const data = unwrapPlatformData(value);
        if (Array.isArray(data) && data.some(row => isRecord(row) && (row.omitted || row.description_truncated))) {
          console.log(dim('Some fields are partial. Read a task with tasks get <id>; expand a field with --view field --field <name>. --json includes omission details.'));
        }
      });
    });

  tasks
    .command('get <task-id>')
    .description('Get current task state; retrieve history or long fields explicitly')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--view <view>', 'current (default), history, field, or full (unbounded)')
    .option('--kind <kind>', 'comments (default) or activity for history')
    .option('--field <field>', 'Top-level field to expand with --view field')
    .option('--event-id <id>', 'History event whose field to expand; repeat --kind')
    .option('--cursor <cursor>', 'next_cursor from previous read; repeat view and field/kind')
    .option('--offset <n>', 'Fresh offset; prefer cursor for checked continuation')
    .option('--limit <n>', 'History page size (default 5, cap 20)')
    .option('--json', 'Print the complete response as JSON')
    .action(async (taskId: string, opts: TaskReadOptions) => {
      await runTaskTool('tasks_get', compactRecord([
        ['project_id', resolveTaskProject(opts.project)], ['task_id', taskId],
        ['view', opts.view], ['kind', opts.kind], ['field', opts.field], ['event_id', opts.eventId],
        ['cursor', opts.cursor], ['offset', numberOption(opts.offset)], ['limit', numberOption(opts.limit)],
      ]), opts.json, (value) => printJson(unwrapPlatformData(value)));
    });

  tasks
    .command('waiting')
    .description('List what is waiting for you: what agents have asked you to do, across your projects, with the steps')
    .option('-p, --project <project>', 'Only this project (slug or ID), read at once')
    .option('--cursor <cursor>', 'next_cursor from the previous answer: the next 25 projects')
    .option('--json', 'Print the complete response as JSON')
    .action(async (opts: ProjectOptions & { cursor?: string }) => {
      // The platform's own read of what waits on the signed-in person: the waiting mode of tasks_list.
      const args = compactRecord([
        ['waiting', 'me'],
        ['project_id', opts.project ? resolveTaskProject(opts.project) : undefined],
        ['cursor', opts.cursor],
      ]);
      await runTaskTool('tasks_list', args, opts.json, printWaiting);
    });

  tasks
    .command('answer <task-id>')
    .description('Answer something that is waiting for you: --done when you did it, --cannot when you can\'t or won\'t, --not-needed when it is no longer needed')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--done', 'You did it')
    .option('--cannot', 'You can\'t or won\'t do it')
    .option('--not-needed', 'It is no longer needed')
    .option('--note <text>', 'A short note for the agent that asked; never a password or a key')
    .option('--json', 'Print the complete response as JSON')
    .action(async (taskId: string, opts: ProjectOptions & { done?: boolean; cannot?: boolean; notNeeded?: boolean; note?: string }) => {
      if ([opts.done, opts.cannot, opts.notNeeded].filter(Boolean).length !== 1) {
        error('Say which one: --done, --cannot or --not-needed.');
        process.exitCode = 1;
        return;
      }
      const args = compactRecord([
        ['project_id', resolveTaskProject(opts.project)],
        ['task_id', taskId],
        ['answer', opts.done ? 'done' : opts.cannot ? 'cannot' : 'not_needed'],
        ['note', opts.note],
      ]);
      await runTaskTool('tasks_update', args, opts.json, printTaskMutation);
    });

  tasks
    .command('create <title>')
    .description('Create a task without opening an editor')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('-d, --description <text>', 'Long-form task description')
    .option('--status <status>', 'Initial status')
    .option('--priority <priority>', 'low, normal, high, or urgent')
    .option('--type <type>', 'Task type')
    .option('--assignee <assignee>', 'Assignee')
    .option('--labels <labels>', 'Comma-separated labels')
    .option('--area <area>', 'Subsystem area')
    .option('--parent <task-id>', 'Parent task ID')
    .option('--due-at <unix-ms>', 'Due time as a Unix timestamp in milliseconds')
    .option('--waiting-on <who>', 'human or product_decision asks the person (shown under "Waiting for you"); external records an outside wait')
    .option('--status-note <text>', 'Current state; with --waiting-on human, the numbered steps for the person, one per line')
    .option('--author <name>', 'The asking agent\'s own name, shown to the person as who asked')
    .option('--supersedes <task-id>', 'An earlier task this one replaces; the earlier one leaves the person\'s waiting list at once')
    .option('--json', 'Print the complete response as JSON')
    .action(async (title: string, opts: TaskWriteOptions) => {
      const args = compactRecord([
        ['project_id', resolveTaskProject(opts.project)],
        ['title', title],
        ['description', opts.description],
        ['status', opts.status],
        ['priority', opts.priority],
        ['type', opts.type],
        ['assignee', opts.assignee],
        ['labels', parseCommaList(opts.labels)],
        ['area', opts.area],
        ['parent_id', opts.parent],
        ['due_at', numberOption(opts.dueAt)],
        ['waiting_on', opts.waitingOn],
        ['status_note', opts.statusNote],
        ['author', opts.author],
        ['supersedes', opts.supersedes],
      ]);
      await runTaskTool('tasks_create', args, opts.json, printTaskMutation);
    });

  tasks
    .command('update <task-id>')
    .description('Update task fields or add a comment')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--title <title>', 'New title')
    .option('-d, --description <text>', 'New description')
    .option('--status <status>', 'New status')
    .option('--priority <priority>', 'New priority')
    .option('--type <type>', 'New type')
    .option('--assignee <assignee>', 'New assignee')
    .option('--labels <labels>', 'Replacement comma-separated labels')
    .option('--area <area>', 'New area; pass an empty string to clear')
    .option('--parent <task-id>', 'New parent; pass an empty string to detach')
    .option('--due-at <unix-ms>', 'Due time as a Unix timestamp in milliseconds')
    .option('--status-note <text>', 'Overwrite the current status note')
    .option('--waiting-on <who>', 'human or product_decision asks the person; external records an outside wait; an empty string clears it (withdraws an ask)')
    .option('--superseded-by <task-id>', 'The task that replaces this one; a replaced ask leaves the person\'s waiting list at once')
    .option('--author <name>', 'The asking agent\'s own name, shown as who asked or who commented')
    .option('--health <health>', 'on_track, at_risk, or off_track')
    .option('--comment <text>', 'Append an evidence comment')
    .option('--resolution-note <text>', 'Resolution note when closing the task')
    .option('--shipped-in <version>', 'Release/version tag this task shipped in')
    .option('--deployment-project <project>', 'Project owning --deployment-version')
    .option('--deployment-version <version>', 'Verified production version to link')
    .option('--json', 'Print the complete response as JSON')
    .action(async (taskId: string, opts: TaskWriteOptions & { title?: string }) => {
      const args = compactRecord([
        ['project_id', resolveTaskProject(opts.project)],
        ['task_id', taskId],
        ['title', opts.title],
        ['description', opts.description],
        ['status', opts.status],
        ['priority', opts.priority],
        ['type', opts.type],
        ['assignee', opts.assignee],
        ['labels', parseCommaList(opts.labels)],
        ['area', opts.area],
        ['parent_id', opts.parent],
        ['due_at', numberOption(opts.dueAt)],
        ['status_note', opts.statusNote],
        ['waiting_on', opts.waitingOn],
        ['superseded_by', opts.supersededBy],
        ['author', opts.author],
        ['health', opts.health],
        ['comment', opts.comment],
        ['resolution_note', opts.resolutionNote],
        ['shipped_in', opts.shippedIn],
        ['deployment_project_id', opts.deploymentProject],
        ['deployment_version', numberOption(opts.deploymentVersion)],
      ]);
      if (Object.keys(args).length === 2) {
        error('No update supplied. Pass a field such as --status, --status-note, --waiting-on, or --comment.');
        process.exitCode = 1;
        return;
      }
      await runTaskTool('tasks_update', args, opts.json, printTaskMutation);
    });

  tasks
    .command('delete <task-ids...>')
    .description('Delete a task that should never have existed (board owner only)')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .requiredOption('--reason <text>', 'Why this task should never have existed')
    .option('--json', 'Print the complete response as JSON')
    .action(async (taskIds: string[], opts: ProjectOptions & { reason: string }) => {
      if (taskIds.length > 200) throw new Error('At most 200 task IDs may be deleted per call.');
      await runTaskTool('tasks_delete', compactRecord([
        ['project_id', resolveTaskProject(opts.project)], [taskIds.length === 1 ? 'task_id' : 'task_ids', taskIds.length === 1 ? taskIds[0] : taskIds], ['reason', opts.reason],
      ]), opts.json, (value) => {
        const data = unwrapPlatformData(value);
        if (!isRecord(data) || typeof data.id !== 'string') { printJson(value); return; }
        console.log(`${teal(data.id)}  ${data.already_deleted ? 'was already deleted' : 'deleted'}`);
        const restore = `\`${cliInvocation()} tasks restore ${data.id}\``;
        const deadline = typeof data.purge_at === 'number' ? ` until ${new Date(data.purge_at).toISOString()}` : '';
        console.log(dim(`Restore${deadline} with ${restore}.`));
      });
    });

  tasks
    .command('restore <task-id>')
    .description('Restore a deleted task with its comments and links (board owner only)')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--reason <text>', 'Why it is being restored')
    .option('--json', 'Print the complete response as JSON')
    .action(async (taskId: string, opts: ProjectOptions & { reason?: string }) => {
      await runTaskTool('tasks_restore', compactRecord([
        ['project_id', resolveTaskProject(opts.project)], ['task_id', taskId], ['reason', opts.reason],
      ]), opts.json, (value) => {
        const data = unwrapPlatformData(value);
        if (!isRecord(data) || typeof data.id !== 'string') { printJson(value); return; }
        console.log(`${teal(data.id)}  restored`);
        const missing = Array.isArray(data.not_restored) ? data.not_restored.filter(isRecord) : [];
        for (const item of missing) console.log(dim(`Not restored: ${String(item.kind)} ${String(item.task_id)} — ${String(item.reason)}`));
        console.log(dim(`Next: ${cliInvocation()} tasks get ${data.id}`));
      });
    });

  tasks
    .command('deleted')
    .description('List deleted tasks that can still be restored (board owner only)')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--json', 'Print the complete response as JSON')
    .action(async (opts: ProjectOptions) => {
      await runTaskTool('tasks_restore', compactRecord([['project_id', resolveTaskProject(opts.project)]]), opts.json, (value) => {
        const data = unwrapPlatformData(value);
        if (!Array.isArray(data)) throw new Error('tasks_restore returned an unexpected response.');
        if (data.length === 0) { console.log(dim('No deleted tasks to restore.')); return; }
        table(['ID', 'Title', 'Reason', 'Erased'], data.filter(isRecord).map((row) => [
          typeof row.id === 'string' ? row.id : '—',
          truncateText(row.title, 40),
          truncateText(row.reason, 40),
          typeof row.purge_at === 'number' ? new Date(row.purge_at).toISOString().slice(0, 10) : '—',
        ]));
      });
    });
}
