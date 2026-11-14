import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, unwrapPlatformData } from './platform-command.js';

/**
 * The preview this folder last opened, and its files exactly as they were
 * sent (one sha256 per local path, the same keys as base-files.json).
 *
 * `somewhere preview` continues it while it is open. `somewhere promote` of
 * exactly this preview makes these files the folder's new base, so the next
 * preview and pull start from what is live without a pull first.
 */
export interface PreviewRecord {
  project_id: string;
  preview_session_id: string;
  preview_id: string;
  files: Record<string, string>;
  saved_at: string;
}

const PREVIEW_RECORD = join('.somewhere', 'preview.json');

export function loadPreviewRecord(dir: string, projectId: string): PreviewRecord | null {
  const path = join(dir, PREVIEW_RECORD);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PreviewRecord;
    if (parsed.project_id !== projectId || typeof parsed.preview_session_id !== 'string'
        || typeof parsed.preview_id !== 'string' || !isRecord(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePreviewRecord(dir: string, record: Omit<PreviewRecord, 'saved_at'>): void {
  mkdirSync(join(dir, '.somewhere'), { recursive: true });
  writeFileSync(join(dir, PREVIEW_RECORD), JSON.stringify({ ...record, saved_at: new Date().toISOString() }) + '\n');
}

export function clearPreviewRecord(dir: string): void {
  rmSync(join(dir, PREVIEW_RECORD), { force: true });
}

/** One open preview, as deploy_status reports it. */
export interface OpenPreview {
  previewSessionId: string;
  previewId: string;
  baseReleaseId: string | null;
  createdAt: string | null;
  lastUpdatedAt: string | null;
  expiresAt: string | null;
}

/** The open previews and the live release, from a deploy_status answer. */
export function openPreviewsFromStatus(status: unknown): { activeReleaseId: string | null; previews: OpenPreview[] } {
  const data = unwrapPlatformData(status);
  if (!isRecord(data)) return { activeReleaseId: null, previews: [] };
  const rows = (Array.isArray(data.previews) && data.previews.length ? data.previews
    : Array.isArray(data.preview_candidates) ? data.preview_candidates : []).filter(isRecord);
  const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  const previews = rows.flatMap((row) => {
    const previewSessionId = str(row.preview_session_id) ?? str(row.draft_id);
    const previewId = str(row.preview_id) ?? str(row.candidate_release_id);
    if (!previewSessionId || !previewId) return [];
    return [{
      previewSessionId,
      previewId,
      baseReleaseId: str(row.base_release_id),
      createdAt: str(row.created_at),
      lastUpdatedAt: str(row.last_updated_at),
      expiresAt: str(row.expires_at),
    }];
  });
  return { activeReleaseId: str(data.active_release_id), previews };
}

/** A preview opened from an older production version can never be promoted. */
export function previewIsStale(preview: OpenPreview, activeReleaseId: string | null): boolean {
  return preview.baseReleaseId !== null && activeReleaseId !== null && preview.baseReleaseId !== activeReleaseId;
}

/** "3 min", "2 h 5 min", "1 d 4 h": short, for a table cell. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** What `somewhere preview` should do with this folder's recorded preview. */
export type ContinueDecision =
  | { action: 'continue'; preview: OpenPreview }
  | { action: 'new'; reason: 'asked' | 'none-recorded' }
  | { action: 'new'; reason: 'not-open' | 'stale'; recorded: PreviewRecord };

export function decideContinue(args: {
  recorded: PreviewRecord | null;
  open: OpenPreview[];
  activeReleaseId: string | null;
  forceNew: boolean;
}): ContinueDecision {
  if (args.forceNew) return { action: 'new', reason: 'asked' };
  if (!args.recorded) return { action: 'new', reason: 'none-recorded' };
  const preview = args.open.find((item) => item.previewSessionId === args.recorded!.preview_session_id);
  if (!preview) return { action: 'new', reason: 'not-open', recorded: args.recorded };
  if (previewIsStale(preview, args.activeReleaseId)) return { action: 'new', reason: 'stale', recorded: args.recorded };
  return { action: 'continue', preview };
}
