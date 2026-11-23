import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ApiClient } from './client.js';

/**
 * What `somewhere advisor` sends about the linked app. The CLI reads it with the
 * user's own sign-in and sends it as context; the Advisor holds no credential and
 * keeps nothing. Sent: the app's overview (pages, routes and their sign-in rule,
 * tables, scheduled jobs) and its last deploy result. Never file contents, rows,
 * env values or users.
 */
export async function gatherAdvisorApp(client: ApiClient, ref: string): Promise<{ projectId: string; text: string }> {
  const project = await client.call<Record<string, unknown>>('GET', `/projects/${encodeURIComponent(ref)}`);
  if (typeof project.id !== 'string' || project.deleted === true) throw new Error(`No app "${ref}" is readable with this sign-in.`);
  const id = project.id;
  const release = project.live_release as { id?: string; version?: number } | null | undefined;
  const lines = [`APP: "${String(project.name ?? project.subdomain ?? id)}" (project ${id}), read by the CLI with the user's own sign-in.`];
  if (!release?.id) lines.push('APP STATE: the app has no live version yet; nothing has been deployed.');
  else {
    const docs = await client.call<{ release_id?: string; project_overview?: Record<string, unknown> }>('GET', '/project-docs', undefined, { project_id: id, view: 'overview' }).catch(() => null);
    if (docs?.project_overview && docs.release_id === release.id) {
      const { more: _more, ...shown } = docs.project_overview;
      lines.push(`APP OVERVIEW (live version ${release.version ?? ''}): ${JSON.stringify(shown)}`);
    } else lines.push("APP OVERVIEW: unavailable. Do not describe the app's files, routes or tables.");
  }
  const deploys = await client.call<{ deploys?: Array<Record<string, unknown>> }>('GET', `/projects/${encodeURIComponent(id)}/deploys`, undefined, { limit: 3 }).catch(() => null);
  const newest = (deploys?.deploys ?? []).slice().sort((a, b) => String(b.at ?? b.promoted_at ?? '').localeCompare(String(a.at ?? a.promoted_at ?? '')))[0];
  if (newest?.status === 'rejected') {
    const failure = await client.call<{ last_failure?: { errors?: Array<{ file?: string; line?: number; column?: number; message?: string }> } }>('GET', '/deploy/log', undefined, { project_id: id, view: 'last_failure' }).catch(() => null);
    const where = (failure?.last_failure?.errors ?? []).filter((e) => e.file).slice(0, 3).map((e) => `${e.file}:${e.line ?? '?'}:${e.column ?? '?'} ${String(e.message ?? '').slice(0, 200)}`);
    lines.push(`LAST DEPLOY: failed. Code ${String(newest.code)}: ${String(newest.message ?? '')}${where.length ? ` Build errors: ${where.join('; ')}.` : ''} The live version is unchanged.`);
  } else if (newest) lines.push(`LAST DEPLOY: succeeded, version ${String(newest.version)}.`);
  return { projectId: id, text: lines.join('\n').slice(0, 8_000) };
}

/** Follow-ups kept by the CLI in the linked app folder (never a per-machine file): three turns, 30 minutes. */
const FILE = join('.somewhere', 'advisor-conversation.json');
const IDLE_MS = 30 * 60_000;
export interface AdvisorTurn { question: string; answer: string; at: number }

const ownerOf = (account: string) => createHash('sha256').update(`advisor:${account}`).digest('hex');

/** Turns for this app AND this signed-in account only; another sign-in in the same folder sees none. */
export function loadAdvisorTurns(dir: string, projectId: string, account: string, now = Date.now()): AdvisorTurn[] {
  try {
    const saved = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as { project_id?: string; owner?: string; turns?: AdvisorTurn[] };
    if (saved.project_id !== projectId || saved.owner !== ownerOf(account) || !Array.isArray(saved.turns)) return [];
    const last = saved.turns.at(-1);
    return last && now - last.at <= IDLE_MS ? saved.turns.slice(-3) : [];
  } catch { return []; }
}

export function saveAdvisorTurn(dir: string, projectId: string, account: string, earlier: AdvisorTurn[], turn: AdvisorTurn): void {
  mkdirSync(join(dir, '.somewhere'), { recursive: true });
  writeFileSync(join(dir, FILE), JSON.stringify({ project_id: projectId, owner: ownerOf(account), turns: [...earlier, { question: turn.question.slice(0, 2_000), answer: turn.answer.slice(0, 3_000), at: turn.at }].slice(-3) }) + '\n', { mode: 0o600 });
}

export function clearAdvisorTurns(dir: string): void {
  if (existsSync(join(dir, FILE))) rmSync(join(dir, FILE), { force: true });
}
