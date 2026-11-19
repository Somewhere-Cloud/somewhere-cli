import { registerHooks } from 'node:module';

const helpers = new Map([
  ['@somewhere-cloud/cli/script', new URL('../dist/script.js', import.meta.url).href],
  ['@somewhere-cloud/cli/testing', new URL('../dist/testing.js', import.meta.url).href],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = helpers.get(specifier);
    if (!url) return nextResolve(specifier, context);
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      // Prefer an explicitly installed package and preserve its other errors.
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'MODULE_NOT_FOUND') throw error;
      return { url, format: 'module', shortCircuit: true };
    }
  },
});
