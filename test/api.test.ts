import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api, apiOrigin, retryAfter } from '../src/api.js';
import { ClientError, message } from '../src/errors.js';
import { fixtureFetch, json, identity, token } from './fixtures.js';

test('GET only, fixed origin, authorization and version header on every request', async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const api = new Api(token, { fetcher: fixtureFetch(calls) });
  await api.whoami();
  await api.request('/api/sites');
  for (const { url, init } of calls) {
    assert.equal(url.origin, 'https://pavegrid.com');
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    assert.ok(new Headers(init.headers).get('authorization') === `Bearer ${token}`);
    assert.equal(new Headers(init.headers).get('x-pavegrid-client'), 'pavegrid-mcp/0.1.0');
  }
  for (const path of ['/api/users', '/api/sites/../../login', 'https://example.com/api/sites', '/api/sites?x=1', '/api/projects/invalid', '/api/org/wrong/tree']) await assert.rejects(api.request(path), ClientError);
  assert.equal(calls.length, 2);
});
test('all redirects are refused without following data URLs', async () => {
  let calls = 0;
  const api = new Api(token, { fetcher: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://example.com' } }); } });
  await assert.rejects(api.request('/api/sites'), (e: unknown) => e instanceof ClientError && e.code === 'redirect');
  assert.equal(calls, 1);
});
test('only allowed origins are accepted and the request origin stays fixed', async t => {
  const previous = process.env.PAVEGRID_MCP_INTERNAL_BASE_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.PAVEGRID_MCP_INTERNAL_BASE_URL;
    else process.env.PAVEGRID_MCP_INTERNAL_BASE_URL = previous;
  });
  delete process.env.PAVEGRID_MCP_INTERNAL_BASE_URL;
  assert.equal(apiOrigin(), 'https://pavegrid.com');
  for (const origin of ['https://example.com', 'https://pavegrid.com:443', 'https://www.pavegrid.io/path']) {
    assert.throws(() => new Api(token, { origin }), (e: unknown) => e instanceof ClientError && e.code === 'bad_origin');
  }
  process.env.PAVEGRID_MCP_INTERNAL_BASE_URL = 'https://www.pavegrid.io';
  const calls: { url: URL; init: RequestInit }[] = [];
  const api = new Api(token, { fetcher: fixtureFetch(calls) });
  process.env.PAVEGRID_MCP_INTERNAL_BASE_URL = 'https://pavegrid.com';
  await api.whoami();
  assert.equal(calls[0].url.origin, 'https://www.pavegrid.io');
});
test('allowed override refuses redirects to production and other origins', async t => {
  const previous = process.env.PAVEGRID_MCP_INTERNAL_BASE_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.PAVEGRID_MCP_INTERNAL_BASE_URL;
    else process.env.PAVEGRID_MCP_INTERNAL_BASE_URL = previous;
  });
  process.env.PAVEGRID_MCP_INTERNAL_BASE_URL = 'https://www.pavegrid.io';
  for (const location of ['https://pavegrid.com/api/sites', 'https://example.com/api/sites']) {
    let calls = 0;
    const api = new Api(token, { fetcher: async (url, init) => {
      calls++;
      assert.equal(url.origin, 'https://www.pavegrid.io');
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location } });
    } });
    await assert.rejects(api.request('/api/sites'), (e: unknown) => e instanceof ClientError && e.code === 'redirect');
    assert.equal(calls, 1);
  }
});
test('GET retries are bounded and honor seconds/date Retry-After on 429 and 503', async () => {
  for (const status of [429, 503]) {
    let calls = 0; const waits: number[] = [];
    const api = new Api(token, { fetcher: async () => ++calls < 3 ? json({}, status, { 'retry-after': '2' }) : json(identity), sleep: async ms => { waits.push(ms); } });
    assert.deepEqual(await api.whoami(), identity); assert.equal(calls, 3); assert.deepEqual(waits, [2000, 2000]);
  }
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:00:05 GMT', 2000), 3000);
  assert.equal(retryAfter('invalid'), null);
  let calls = 0;
  const api = new Api(token, { fetcher: async () => { calls++; return json({}, 429, { 'retry-after': '120' }); }, sleep: async () => { assert.fail('must not retry before requested time'); } });
  await assert.rejects(api.whoami(), (e: unknown) => e instanceof ClientError && e.code === 'ai_access_rate_limited');
  assert.equal(calls, 1);
});
test('429 after three attempts, 401, 403, 426 produce controlled errors', async () => {
  for (const [status, code] of [[401, 'ai_access_denied'], [403, 'ai_access_read_only'], [426, 'ai_access_client_outdated'], [429, 'ai_access_rate_limited']] as const) {
    let calls = 0;
    const api = new Api(token, { fetcher: async () => { calls++; return json({ minimum: '1.2.3', error: token }, status); }, sleep: async () => {} });
    await assert.rejects(api.whoami(), (e: unknown) => {
      assert.ok(e instanceof ClientError); assert.equal(e.code, code);
      assert.ok(!message(e).includes(token)); if (status === 426) assert.match(message(e), /minimum 1.2.3/); return true;
    });
    assert.equal(calls, status === 429 ? 3 : 1);
  }
});
test('timeout, cancellation and raw exceptions never echo input or tokens', async () => {
  const api = new Api(token, { timeoutMs: 5, fetcher: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error(token)), { once: true });
  }) });
  // Keep the event loop alive while AbortSignal.timeout runs its unref timer.
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(api.whoami(), (e: unknown) => /timed out/.test(message(e)) && !message(e).includes(token)); }
  finally { clearTimeout(keepAlive); }
  const controller = new AbortController(); controller.abort();
  const cancelled = new Api(token, { fetcher: async (_url, init) => { init.signal?.throwIfAborted(); return json(identity); } });
  await assert.rejects(cancelled.whoami(controller.signal), ClientError);
});
test('responses redact tokens, validate identity, and bound the body size', async () => {
  const api = new Api(token, { fetcher: async () => json({ note: `secret ${token}`, other: 'pgai_example_redact' }) });
  assert.deepEqual(await api.request('/api/sites'), { note: 'secret [redacted]', other: '[redacted]' });
  await assert.rejects(api.whoami(), ClientError);
  const large = new Api(token, { fetcher: async () => new Response('x'.repeat(1024 * 1024 + 1)) });
  await assert.rejects(large.request('/api/sites'), (e: unknown) => e instanceof ClientError && e.code === 'too_large');
});
