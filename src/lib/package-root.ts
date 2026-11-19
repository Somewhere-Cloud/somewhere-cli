import { fileURLToPath } from 'node:url';

// Both compiled source and the published bundle live in dist/lib.
export const CLI_PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
