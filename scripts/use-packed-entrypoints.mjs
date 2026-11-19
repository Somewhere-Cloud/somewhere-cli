import { readdirSync } from 'node:fs';
import * as module from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Every shipped JavaScript entry point runs from the installed tarball.
// Tests of private helpers use the remaining compiled files from the checkout.
const installed = process.env.SOMEWHERE_TEST_PACKED_CLI;
if (installed && typeof module.registerHooks === 'function') {
  const entries = readdirSync(installed, { recursive: true })
    .filter(entry => /\.[cm]?js$/.test(entry));
  const urls = new Map(entries.map(entry => [
    pathToFileURL(join(fileURLToPath(new URL('../', import.meta.url)), entry)).href,
    pathToFileURL(join(installed, entry)).href,
  ]));
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const packed = urls.get(resolved.url);
      return packed ? { ...resolved, url: packed } : resolved;
    },
  });
}
