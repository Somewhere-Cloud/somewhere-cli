import { createRequire } from 'node:module';
import { CLI_PACKAGE_ROOT } from './package-root.js';

const require = createRequire(CLI_PACKAGE_ROOT);
const { checkerContract } = require('./runtime/declared-data.cjs') as {
  checkerContract: { TYPESCRIPT_VERSION: string };
};

// The starter and fallback compiler use the same pin as the deploy check.
export const TYPECHECK_TYPESCRIPT_VERSION = checkerContract.TYPESCRIPT_VERSION;
