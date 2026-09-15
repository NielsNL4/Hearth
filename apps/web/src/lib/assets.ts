import type { Session } from '@supabase/supabase-js';

export interface ManifestOutput {
  key: string;
  type: 'tile' | 'preview' | 'image' | 'thumbnail';
  width: number;
  height: number;
  z?: number;
  x?: number;
  y?: number;
}

export interface AssetManifest {
  version: 1;
  assetId: string;
  kind: 'map' | 'token';
  width: number;
  height: number;
  outputs: ManifestOutput[];
}

export interface AssetReservation {
  id: string;
  roomId: string;
  status: string;
}

const baseUrl = String(import.meta.env.VITE_ASSET_API_URL || '').replace(/\/$/, '');

async function request<T>(session: Session, path: string, init?: RequestInit): Promise<T> {
  if (!baseUrl) throw new Error('VITE_ASSET_API_URL is not configured.');
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error || `Asset service returned ${response.status}.`));
  return body as T;
}

export async function getManifest(session: Session, assetId: string): Promise<AssetManifest> {
  return request(session, `/v1/assets/${assetId}/manifest`);
}

export async function getDownloadUrls(session: Session, assetId: string, keys: string[]) {
  return request<{ expiresIn: number; urls: Record<string, string> }>(session, `/v1/assets/${assetId}/download-urls`, {
    method: 'POST', body: JSON.stringify({ keys }),
  });
}

export async function uploadAsset(
  session: Session,
  reservation: AssetReservation,
  file: File,
  onProgress: (progress: number) => void,
  onProcessing?: () => void,
) {
  const upload = await request<{ url: string; fields: Record<string, string> }>(session, `/v1/assets/${reservation.id}/upload`, {
    method: 'POST', body: JSON.stringify({ contentType: file.type, bytes: file.size }),
  });
  await new Promise<void>((resolve, reject) => {
    const form = new FormData();
    Object.entries(upload.fields).forEach(([key, value]) => form.append(key, value));
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', upload.url);
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(Math.round(event.loaded / event.total * 100));
    xhr.onerror = () => reject(new Error('The image upload was interrupted.'));
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status}).`));
    xhr.send(form);
  });
  onProcessing?.();
  await request(session, `/v1/assets/${reservation.id}/process`, { method: 'POST', body: '{}' });
}

export async function waitForManifest(session: Session, assetId: string, timeoutMs = 90_000): Promise<AssetManifest> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await getManifest(session, assetId); }
    catch (error) {
      if (Date.now() + 1500 >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw new Error('Image processing timed out.');
}
