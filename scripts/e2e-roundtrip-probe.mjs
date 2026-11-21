export const PUBLIC_PROBE_PATH = '/roundtrip-health.txt';
const PRIVATE_MODULE_PATH = '/_lib/secret.ts';

export async function verifyRoundtripServing(subdomain, marker, request = fetch) {
  const origin = `https://${subdomain}.somewhere.site`;
  const publicFile = await request(origin + PUBLIC_PROBE_PATH, { redirect: 'error' });
  if (publicFile.status !== 200 || await publicFile.text() !== marker) {
    throw new Error(`GET ${PUBLIC_PROBE_PATH} returned ${publicFile.status} without the deployed fixture marker.`);
  }

  const privateFile = await request(origin + PRIVATE_MODULE_PATH, { redirect: 'error' });
  const refusal = privateFile.status === 404 ? await privateFile.json().catch(() => null) : null;
  if (refusal?.ok !== false || refusal.error !== 'FUNCTION_NOT_FOUND'
    || refusal.message !== `No function registered at ${PRIVATE_MODULE_PATH}`) {
    throw new Error(`GET ${PRIVATE_MODULE_PATH} returned ${privateFile.status} without the expected FUNCTION_NOT_FOUND refusal.`);
  }
}
