/**
 * Stored log and error text is untrusted: an app writes it, often from caller input. Render it as ONE
 * line of terminal output (tsk_f184baa4): C0 controls, DEL, C1 controls, the Unicode line/paragraph
 * separators and the bidirectional overrides become visible escapes (\n, \r, \t, \x1b, \u202e ...),
 * so a message can neither start a forged row nor send a terminal escape sequence. Other text,
 * non-ASCII included, is kept as written. JSON output never uses this: JSON.stringify escapes.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function terminalSafe(value: unknown): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text.replace(UNSAFE, (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    const code = ch.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/**
 * A stored multi-line value (a crash stack) rendered under its record (tsk_da2dba3d). Each line is escaped as
 * above AND starts with one fixed continuation marker, so no line of untrusted text can begin at the margin
 * or pass as a record of its own (a stack line written to look like `  [info]  ...` stays visibly inside
 * the stack). The marker is the ONLY prefix a continuation line ever gets; the text cannot choose another.
 * Lines past `maxLines` are counted, not silently dropped; --json keeps the whole value.
 */
export const CONTINUATION_MARKER = '      stack | ';

export function terminalContinuation(value: unknown, maxLines = 30): string[] {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const shown = lines.slice(0, maxLines).map((line) => CONTINUATION_MARKER + terminalSafe(line));
  if (lines.length > maxLines) {
    const more = lines.length - maxLines;
    shown.push(`${CONTINUATION_MARKER}... ${more} more line${more === 1 ? '' : 's'} (--json shows the whole stack)`);
  }
  return shown;
}
