import type { ApiClient } from './client.js';
import { awaitPostLiveRender } from './post-live-render.js';
import { runTests, type PreparedRunner } from './test-run.js';
import { mark } from './test-timeline.js';

// somewhere deploy --test: the project's specs, once, against the release this deploy published.
// The runner is prepared (Playwright resolved, browser checked) while the deploy runs; nothing
// touches the app until the release is live and its blank-page check has settled, because a
// release can still be rolled back until then.

export type PreparedOrError = { value: PreparedRunner } | { error: unknown };
export interface DeployTests {
  status: 'passed' | 'failed' | 'not_run';
  release: string | null;
  /** Why the tests did not run, or what failed around them. */
  reason?: string;
  results?: Record<string, unknown> | null;
}

export function prepareDeployTests(start: () => Promise<PreparedRunner>): Promise<PreparedOrError> {
  return start().then(value => ({ value }), (error: unknown) => ({ error }));
}

export async function runDeployTests(input: {
  client: ApiClient; root: string; projectId: string | undefined; temporary: boolean; json: boolean;
  release: string | undefined; renderPending: boolean; prepared: Promise<PreparedOrError>;
}): Promise<DeployTests> {
  const release = input.release ?? null;
  const notRun = (reason: string): DeployTests => ({ status: 'not_run', release, reason });
  if (input.temporary) return notRun('a temporary project cannot run tests; claim it, link this folder and run somewhere test');
  if (!input.projectId || !input.release) return notRun('the deploy did not name its project and release');
  // A release whose blank-page check is still running may yet be rolled back: wait for it to settle.
  if (input.renderPending) {
    let settled = false;
    for (let attempt = 0; attempt < 6 && !settled; attempt++) {
      const wait = await awaitPostLiveRender(input.client, input.projectId, { release_id: input.release, post_live_render: { status: 'pending' } } as never);
      settled = wait.kind !== 'timeout';
    }
    if (!settled) return notRun('the live page check has not finished, so the release could still be rolled back; run somewhere test once it has');
  }
  const prepared = await input.prepared;
  if ('error' in prepared) return notRun(prepared.error instanceof Error ? prepared.error.message : String(prepared.error));
  mark('deploy-test:start');
  try {
    const outcome = await runTests({ root: input.root, client: input.client, projectId: input.projectId, prepared: prepared.value, options: { workers: '5', json: input.json }, expectRelease: input.release, toStderr: input.json });
    const passed = outcome.exitCode === 0 && outcome.results !== null;
    return { status: passed ? 'passed' : 'failed', release, results: outcome.results, ...(outcome.results ? {} : { reason: 'the runner wrote no results' }) };
  } catch (error) {
    return notRun(error instanceof Error ? error.message : String(error));
  } finally { mark('deploy-test:end'); }
}

/** The plain closing line: the deploy and its tests are reported separately, never as one green. */
export function formatDeployTestsLine(tests: DeployTests): string {
  const r = tests.results as { passed?: number; failed?: number; setupErrors?: number; notRun?: number } | null | undefined;
  if (tests.status === 'passed') return `The deploy is live and its tests passed: ${r?.passed ?? 0} passed on ${tests.release}.`;
  if (tests.status === 'failed') return `The deploy is live. Its tests FAILED: ${r?.failed ?? 0} failed, ${r?.passed ?? 0} passed${r?.setupErrors ? `, ${r.setupErrors} setup errors` : ''}${tests.reason ? ` (${tests.reason})` : ''} on ${tests.release}. After fixing a test: somewhere test --failed. After fixing the app: somewhere deploy --test.`;
  return `The deploy is live. Its tests did NOT run: ${tests.reason}.`;
}
