// The Node.js version check, kept free of dependencies and of newer syntax so
// it runs on any Node.js before the CLI's bundled dependencies are loaded.
import { readFileSync } from 'node:fs';

/** The minimum Node.js version declared in package.json `engines.node` (">=X.Y.Z"). */
export function minimumNodeVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const match = /^>=\s*(\d+\.\d+\.\d+)$/.exec(String(pkg.engines && pkg.engines.node).trim());
  if (!match) throw new Error('package.json engines.node must be ">=X.Y.Z"');
  return match[1];
}

/** True when `version` (e.g. "20.20.2") is older than `minimum` (e.g. "22.19.0"). */
export function olderThan(version, minimum) {
  const have = version.split('.').map(Number);
  const need = minimum.split('.').map(Number);
  for (let i = 0; i < need.length; i++) {
    const part = have[i] || 0;
    if (part !== need[i]) return part < need[i];
  }
  return false;
}

export function unsupportedNodeMessage(version, minimum) {
  return `somewhere needs Node.js ${minimum} or newer; this is Node.js ${version}. `
    + 'Install a current Node.js LTS from https://nodejs.org, then run the command again.';
}
