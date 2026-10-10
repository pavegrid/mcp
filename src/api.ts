import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { ClientError, redact, validateToken } from './errors.js';
import { VERSION } from './version.js';

export const IdentitySchema = z.object({
  user: z.object({ id: z.uuid(), email: z.string() }), org: z.object({ id: z.uuid(), name: z.string() }),
  role: z.string(), token: z.object({ id: z.uuid(), label: z.string(), expires_at: z.string().nullable() }),
});
export type Identity = z.infer<typeof IdentitySchema>;
export type Fetcher = (url: URL, init: RequestInit) => Promise<Response>;
export type Query = Record<string, string | number | undefined>;
const routes = /^\/api\/(ai-access\/(whoami|summary)|sites|org\/[a-f0-9-]{36}\/tree|projects(?:\/[a-f0-9-]{36})?|work-orders(?:\/[a-f0-9-]{36})?|activities(?:\/[a-f0-9-]{36})?)$/i;
const origins = new Set(['https://pavegrid.com', 'https://www.pavegrid.io']);
export function apiOrigin(origin = process.env.PAVEGRID_MCP_INTERNAL_BASE_URL ?? 'https://pavegrid.com'): string {
  if (!origins.has(origin)) throw new ClientError('bad_origin', 'PaveGrid origin is not allowed.');
  return origin;
}
function failure(code: string, text: string): ClientError { return new ClientError(code, text); }
export function retryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) { const seconds = Number(value); return Number.isSafeInteger(seconds) ? seconds * 1000 : Infinity; }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
async function readJson(response: Response, token: string): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > 1024 * 1024) { await response.body?.cancel(); throw failure('too_large', 'PaveGrid response is too large. Use a smaller page or open the record in PaveGrid.'); }
  const reader = response.body?.getReader();
  if (!reader) throw failure('bad_response', 'PaveGrid returned an empty response.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 1024 * 1024) { await reader.cancel(); throw failure('too_large', 'PaveGrid response is too large. Use a smaller page or open the record in PaveGrid.'); }
      chunks.push(value);
    }
    return JSON.parse(redact(Buffer.concat(chunks).toString('utf8').split(token).join('[redacted]')));
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw failure('bad_response', 'PaveGrid returned an unexpected response. Try again later.');
  } finally { reader.releaseLock(); }
}
export class Api {
  private readonly token: string;
  private readonly origin: string;
  constructor(token: string, private readonly options: {
    fetcher?: Fetcher; origin?: string; timeoutMs?: number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {}) { this.origin = apiOrigin(options.origin); this.token = validateToken(token); }
  async request(path: string, query: Query = {}, signal?: AbortSignal): Promise<unknown> {
    if (!routes.test(path)) throw failure('read_only', 'This client can only read PaveGrid records.');
    const url = new URL(path, this.origin);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 25000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const fetcher = this.options.fetcher ?? fetch;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetcher(url, { method: 'GET', redirect: 'manual', signal: combined,
          headers: { Authorization: `Bearer ${this.token}`, 'X-PaveGrid-Client': `pavegrid-mcp/${VERSION}`, Accept: 'application/json' } });
      } catch {
        throw failure('connection', combined.aborted ? 'PaveGrid request timed out or was cancelled. Try again.' : 'PaveGrid request failed. Check your connection and try again.');
      }
      if ([429, 503].includes(response.status)) {
        const wait = retryAfter(response.headers.get('retry-after')) ?? (500 * 2 ** attempt);
        await response.body?.cancel();
        if (attempt < 2 && wait <= 5000 && !combined.aborted) {
          try { await (this.options.sleep ?? ((ms, s) => delay(ms, undefined, { signal: s })))(wait, combined); }
          catch { throw failure('timeout', 'PaveGrid request timed out or was cancelled. Try again.'); }
          continue;
        }
        throw failure(response.status === 429 ? 'ai_access_rate_limited' : 'unavailable', response.status === 429
          ? 'PaveGrid rate limit reached. Wait before trying again.' : 'PaveGrid is temporarily unavailable. Try again later.');
      }
      if (response.status === 426) {
        let minimum = '';
        try {
          const body = await readJson(response, this.token);
          if (body && typeof body === 'object' && 'minimum' in body && typeof body.minimum === 'string' && /^\d+\.\d+\.\d+$/.test(body.minimum)) minimum = ` (minimum ${body.minimum})`;
        } catch { /* A malformed error must still produce upgrade guidance. */ }
        throw failure('ai_access_client_outdated', `Your PaveGrid client is outdated${minimum}. Update @pavegrid/mcp and restart your AI app.`);
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 300 && response.status < 400) throw failure('redirect', 'PaveGrid redirected this request. The client refused to send your token to another address.');
        if (response.status === 401) throw failure('ai_access_denied', 'AI access is off, or your token expired or was revoked. Ask your PaveGrid admin.');
        if (response.status === 403) throw failure('ai_access_read_only', 'AI access can only read records your company allows. Ask your PaveGrid admin.');
        throw failure('http', `PaveGrid could not read these records (HTTP ${response.status}). Try again later.`);
      }
      return readJson(response, this.token);
    }
    throw failure('unavailable', 'PaveGrid is temporarily unavailable.');
  }
  async whoami(signal?: AbortSignal): Promise<Identity> {
    const result = IdentitySchema.safeParse(await this.request('/api/ai-access/whoami', {}, signal));
    if (!result.success) throw failure('bad_identity', 'PaveGrid returned an unexpected account response.');
    return result.data;
  }
}
