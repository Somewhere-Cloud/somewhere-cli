// @somewhere-cloud/cli/script — helpers for an ordinary Node or Playwright script that tests a
// linked Somewhere app. Works from ESM (import) and CommonJS (require). No runner, no fixtures.
export { openAppTest, AppTest, launchOptions, captureResponses, dataReady, ready } from './lib/app-test.js';
export type { OpenOptions, DataRequest, DataResult, DataKind, Check, Captured } from './lib/app-test.js';
export type { FormAdapter, Control, Person, SignUpOptions, SignInOptions, FormSteps, CodeSteps } from './lib/form-auth.js';
