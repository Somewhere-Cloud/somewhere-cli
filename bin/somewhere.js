#!/usr/bin/env node
import { minimumNodeVersion, olderThan, unsupportedNodeMessage } from './engine.js';

// Checked before the CLI and its bundled dependencies load: on an older Node.js
// they fail with an unrelated internal error instead of this message.
const minimum = minimumNodeVersion();
if (olderThan(process.versions.node, minimum)) {
  process.stderr.write(`✗ ${unsupportedNodeMessage(process.versions.node, minimum)}\n`);
  process.exit(1);
}
await import('../dist/index.js');
