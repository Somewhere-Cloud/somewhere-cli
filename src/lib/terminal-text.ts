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
