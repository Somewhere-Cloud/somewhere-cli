import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiClient } from './client.js';

/**
 * What `somewhere advisor` sends about the app linked in this folder. The CLI reads it with the user's own
 * sign-in; the Advisor reads nothing itself and keeps nothing. Sent: the overview exactly as project_get
 * returns project_overview (pages, routes and their sign-in rule, tables, scheduled jobs), and the last
 * deploy result. Never file contents, rows, env values or users.
 */
export interface AdvisorLastDeploy { status: 'succeeded' | 'failed'; code?: string; file?: string; line?: number; column?: number; message?: string }
export interface AdvisorAppFacts { projectId: string; app_overview?: Record<string, unknown>; last_deploy?: AdvisorLastDeploy }

export async function gatherAdvisorApp(client: ApiClient, ref: string): Promise<AdvisorAppFacts> {
  const project = await client.call<Record<string, unknown>>('GET', `/projects/${encodeURIComponent(ref)}`);
  if (typeof project.id !== 'string' || project.deleted === true) throw new Error(`The app linked in this folder ("${ref}") is not readable with this sign-in.`);
  const id = project.id;
  const facts: AdvisorAppFacts = { projectId: id };
  const release = project.live_release as { id?: string } | null | undefined;
  if (release?.id) {
    const docs = await client.call<{ release_id?: string; project_overview?: Record<string, unknown> }>('GET', '/project-docs', undefined, { project_id: id, view: 'overview' }).catch(() => null);
    if (docs?.project_overview && docs.release_id === release.id) facts.app_overview = docs.project_overview;
  } else {
    // An app that was never deployed says so, rather than sending nothing and letting the answer guess.
    facts.app_overview = { app: 'No live version yet: nothing has been deployed, so the app has no pages, routes, tables or jobs.' };
  }
  const deploys = await client.call<{ deploys?: Array<Record<string, unknown>> }>('GET', `/projects/${encodeURIComponent(id)}/deploys`, undefined, { limit: 3 }).catch(() => null);
  const newest = (deploys?.deploys ?? []).slice().sort((a, b) => String(b.at ?? b.promoted_at ?? '').localeCompare(String(a.at ?? a.promoted_at ?? '')))[0];
  if (newest?.status === 'rejected') {
    // The failed build's own narrow record: it opens no release source on the platform.
    const failure = await client.call<{ last_failure?: { errors?: Array<{ file?: string; line?: number; column?: number; message?: string }> } }>('GET', '/deploy/log', undefined, { project_id: id, view: 'last_failure' }).catch(() => null);
    const first = (failure?.last_failure?.errors ?? []).find((e) => typeof e.file === 'string');
    facts.last_deploy = {
      status: 'failed',
      ...(typeof newest.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(newest.code) ? { code: newest.code } : {}),
      ...(first?.file ? { file: first.file.slice(0, 300) } : {}),
      ...(Number.isSafeInteger(first?.line) ? { line: first!.line } : {}),
      ...(Number.isSafeInteger(first?.column) ? { column: first!.column } : {}),
      message: String(first?.message ?? newest.message ?? '').slice(0, 500),
    };
  } else if (newest) facts.last_deploy = { status: 'succeeded' };
  return facts;
}

/** Follow-ups kept by the CLI in the linked app folder (never a per-machine file): three turns, 30 minutes,
 *  for that app and that signed-in account only. */
const DIR = '.somewhere';
const FILE = join(DIR, 'advisor-conversation.json');
const IDLE_MS = 30 * 60_000;
export interface AdvisorTurn { question: string; answer: string; at: number }
const ownerOf = (account: string) => createHash('sha256').update(`advisor:${account}`).digest('hex');

export function loadAdvisorTurns(dir: string, projectId: string, account: string, now = Date.now()): AdvisorTurn[] {
  try {
    const saved = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as { project_id?: string; owner?: string; turns?: AdvisorTurn[] };
    if (saved.project_id !== projectId || saved.owner !== ownerOf(account) || !Array.isArray(saved.turns)) return [];
    const last = saved.turns.at(-1);
    return last && now - last.at <= IDLE_MS ? saved.turns.slice(-3) : [];
  } catch { return []; }
}

export function saveAdvisorTurn(dir: string, projectId: string, account: string, earlier: AdvisorTurn[], turn: AdvisorTurn): void {
  mkdirSync(join(dir, DIR), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, FILE), JSON.stringify({ project_id: projectId, owner: ownerOf(account), turns: [...earlier, { question: turn.question.slice(0, 2_000), answer: turn.answer.slice(0, 3_000), at: turn.at }].slice(-3) }) + '\n', { mode: 0o600 });
  ensureAdvisorStateIgnored(dir);
}

export function clearAdvisorTurns(dir: string): void {
  if (existsSync(join(dir, FILE))) rmSync(join(dir, FILE), { force: true });
}

/** Deploys skip dot-folders; git might not. Make sure the folder's .gitignore covers .somewhere/. */
export function ensureAdvisorStateIgnored(dir: string): void {
  const path = join(dir, '.gitignore');
  const covered = ['.somewhere/', '.somewhere', '/.somewhere/', '/.somewhere', '.somewhere/advisor-conversation.json'];
  if (!existsSync(path)) { writeFileSync(path, '# somewhere: local CLI state (Advisor follow-ups, test users)\n.somewhere/\n'); return; }
  const text = readFileSync(path, 'utf8');
  if (text.split(/\r?\n/).map((l) => l.trim()).some((l) => covered.includes(l))) return;
  writeFileSync(path, `${text}${text.endsWith('\n') || !text ? '' : '\n'}\n# somewhere: local CLI state (Advisor follow-ups, test users)\n.somewhere/\n`);
}
