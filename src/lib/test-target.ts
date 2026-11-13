import { ApiClient } from './client.js';
import { productionOrigin } from './test-identities.js';
import { span } from './test-timeline.js';

export interface TestTarget { projectId: string; origin: string; host: string; releaseId: string; contractDigest: string | null }
export async function loadTestTarget(client: ApiClient, projectId: string): Promise<TestTarget> {
  const [urls, map] = await Promise.all([
    span('target:urls', {}, () => client.call<{ prod_fallback: string }>('GET', `/projects/${encodeURIComponent(projectId)}/urls`)),
    span('target:access-map', {}, () => client.call<{ release: { id: string }; browser_data: { contract_digest: string | null } }>('GET', '/db/access-map', undefined, { project_id: projectId })),
  ]);
  return { projectId, ...productionOrigin(urls.prod_fallback), releaseId: map.release.id, contractDigest: map.browser_data.contract_digest };
}
export async function fixtureTestTarget(client: ApiClient, projectId: string): Promise<TestTarget> {
  if (process.env.SW_TEST_TARGET) {
    const target = JSON.parse(process.env.SW_TEST_TARGET) as TestTarget;
    if (target.projectId !== projectId) throw new Error('Test target belongs to a different project');
    return target;
  }
  return loadTestTarget(client, projectId);
}
