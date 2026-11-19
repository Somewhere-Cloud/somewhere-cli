import { CLI_PACKAGE_ROOT } from './package-root.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The installed CLI's own version, read once from its package.json. Sent to
 *  the platform at `somewhere login` so the approval page can show which CLI
 *  build is asking for access. */
function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(CLI_PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const CLI_VERSION: string = readVersion();
