/** Wait briefly for quick hosted work, then poll at most once per second. */
export function interactivePollDelay(attempt: number): number {
  return [150, 300, 600][attempt] ?? 1000;
}

export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  const header = value?.trim();
  if (!header) return undefined;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
