type Scope = Record<string, string | number>;

export type FilesRequest =
  | { operation: 'upload'; file: Blob; name?: string; contentType?: string; scope?: Scope }
  | { operation: 'list'; limit?: number; cursor?: string; scope?: Scope }
  | { operation: 'url' | 'delete'; id: string }
  | { operation: 'shareLink'; id: string; expiresIn?: number };

export interface UploadLink {
  id: string;
  name?: string;
  url: string;
  multipart_url: string;
}

interface MultipartTransfer {
  part_size: number;
  part_count: number;
  parts_url: string;
  complete_url: string;
  abort_url: string;
}

// The file door returns signed transfer URLs. Send only the file bytes or
// transfer metadata to them. The app's cookies stay on the app's own origin.
function transfer(url: string, init: RequestInit): Promise<Response> {
  if (new URL(url).protocol !== 'https:') throw new Error('Expected an HTTPS file transfer URL.');
  return fetch(url, { ...init, credentials: 'omit', redirect: 'error' });
}

export async function transferTestFile(link: UploadLink, file: Blob, type: string, singleRequestMaxBytes: number): Promise<Response> {
  if (file.size <= singleRequestMaxBytes) {
    return transfer(link.url, { method: 'PUT', headers: { 'Content-Type': type }, body: file });
  }
  const start = await transfer(link.multipart_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size_bytes: file.size, content_type: type }),
  });
  if (!start.ok) return start;
  const { data } = await start.json() as { data: MultipartTransfer };
  const abort = async () => {
    await transfer(data.abort_url, { method: 'DELETE' }).catch(() => {});
  };
  try {
    for (let n = 1; n <= data.part_count; n++) {
      const from = (n - 1) * data.part_size;
      const part = await transfer(data.parts_url + '/' + n, {
        method: 'PUT', body: file.slice(from, from + data.part_size),
      });
      if (!part.ok) {
        await abort();
        return part;
      }
      await part.body?.cancel();
    }
    return await transfer(data.complete_url, { method: 'POST' });
  } catch (error) {
    await abort();
    throw error;
  }
}
