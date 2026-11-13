import { ApiClient } from './client.js';
import { productionOrigin } from './test-identities.js';
import { span } from './test-timeline.js';

export interface TestTarget { projectId: string; origin: string; host: string; releaseId: string; contractDigest: string | null }
/** `onOrigin` is called as soon as the app's origin is known, before the access map arrives. */
export async function loadTestTarget(client: ApiClient, projectId: string, onOrigin?: (origin: string) => void): Promise<TestTarget> {
  const [urls, map] = await Promise.all([
    span('target:urls', {}, () => client.call<{ prod_fallback: string }>('GET', `/projects/${encodeURIComponent(projectId)}/urls`)).then(urls => { onOrigin?.(productionOrigin(urls.prod_fallback).origin); return urls; }),
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

/** The release serving the app now (the same id the access map names), from the light URLs read. */
export async function liveReleaseId(client: ApiClient, projectId: string): Promise<string> {
  const urls = await client.call<{ active_release_id?: string | null }>('GET', `/projects/${encodeURIComponent(projectId)}/urls`);
  if (!urls.active_release_id) throw new Error('The project has no live release');
  return urls.active_release_id;
}
