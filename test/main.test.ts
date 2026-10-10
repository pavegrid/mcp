import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, requireNode } from '../src/main.js';
import { ClientError } from '../src/errors.js';
import { nativeStore, type TokenStore, type Runner } from '../src/store.js';
import { fixtureFetch, token } from './fixtures.js';

test('CLI login, whoami, logout and relogin do not print the token', async () => {
  let saved: string | null = null, output = '', diagnostics = '';
  const store: TokenStore = { read: async () => saved, write: async value => { saved = value; }, remove: async () => { saved = null; } };
  const options = { store, fetcher: fixtureFetch(), readToken: async () => token, stdout: (value: string) => { output += value; }, stderr: (value: string) => { diagnostics += value; } };
  await assert.rejects(main(['whoami'], options), (e: unknown) => e instanceof ClientError && e.code === 'not_logged_in');
  await main(['login', '--stdin'], options); assert.ok(saved === token); assert.equal(output, '');
  await main(['whoami'], options); assert.match(output, /user@example.com/);
  await main(['logout'], options); assert.equal(saved, null);
  await main(['login'], options); assert.ok(saved === token);
  assert.ok(!(output + diagnostics).includes(token));
});
test('CLI validates arguments before accessing a store; no token argv or env config', async () => {
  const store: TokenStore = { read: async () => { assert.fail('store should not be read'); }, write: async () => { assert.fail('store should not be written'); }, remove: async () => { assert.fail('store should not be removed'); } };
  for (const args of [['login', token], ['serve', '--token', token], ['whoami', '--stdin'], ['login', '--stdin', '--stdin'], ['bad']]) await assert.rejects(main(args, { store }), ClientError);
  let output = '';
  await main(['--help'], { store, stdout: value => { output += value; } }); assert.match(output, /read-only/);
  output = ''; await main(['--version'], { store, stdout: value => { output += value; } }); assert.equal(output, '0.1.0\n');
  assert.throws(() => requireNode('20.19.0'), ClientError); requireNode('22.0.0'); requireNode('24.0.0');
});
test('login verifies authorization before storing; failure leaves previous token intact', async () => {
  let writes = 0;
  const store: TokenStore = { read: async () => null, write: async () => { writes++; }, remove: async () => {} };
  await assert.rejects(main(['login'], { store, readToken: async () => token, fetcher: async () => new Response('{}', { status: 401 }) }), ClientError);
  assert.equal(writes, 0);
});
test('unapproved origins fail at startup before any credential access or token input', async t => {
  const previous = process.env.PAVEGRID_MCP_INTERNAL_BASE_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.PAVEGRID_MCP_INTERNAL_BASE_URL;
    else process.env.PAVEGRID_MCP_INTERNAL_BASE_URL = previous;
  });
  const store: TokenStore = {
    read: async () => assert.fail('must not read credentials'),
    write: async () => assert.fail('must not write credentials'),
    remove: async () => assert.fail('must not remove credentials'),
  };
  const options = {
    store, storeFactory: () => assert.fail('must not select credentials'),
    readToken: async () => assert.fail('must not read token input'),
    fetcher: async () => assert.fail('must not send a request'),
  };
  for (const origin of ['https://example.com', 'http://pavegrid.com', 'https://pavegrid.com.example.com', 'https://pavegrid.com/path', 'https://user@pavegrid.com', 'not a URL', '']) {
    process.env.PAVEGRID_MCP_INTERNAL_BASE_URL = origin;
    for (const command of ['serve', 'whoami', 'login', 'logout', '--help', '--version']) {
      await assert.rejects(main([command], options), (e: unknown) => e instanceof ClientError && e.code === 'bad_origin' && e.message === 'PaveGrid origin is not allowed.');
    }
    await assert.rejects(main(['whoami'], { ...options, store: undefined }), ClientError);
  }
});
test('origin overrides use isolated native credentials for reads, login and logout', async t => {
  const previous = process.env.PAVEGRID_MCP_INTERNAL_BASE_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.PAVEGRID_MCP_INTERNAL_BASE_URL;
    else process.env.PAVEGRID_MCP_INTERNAL_BASE_URL = previous;
  });
  const production = 'pavegrid-mcp:production';
  const alternate = 'pavegrid-mcp:https://www.pavegrid.io';
  const entries = new Map([[production, token]]);
  const overrideToken = `${token}_override`;
  const accesses: { action: string; service: string }[] = [];
  const run: Runner = async (_command, args, input) => {
    const service = args[args.indexOf('service') + 1];
    accesses.push({ action: args[0], service });
    if (args[0] === 'lookup') return entries.has(service) ? { code: 0, stdout: entries.get(service)!, stderr: '' } : { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'store') entries.set(service, input!);
    else entries.delete(service);
    return { code: 0, stdout: '', stderr: '' };
  };
  let diagnostics = '', output = '';
  const calls: { url: URL; init: RequestInit }[] = [];
  const options = {
    storeFactory: (_allowFileStore: boolean, _warn: (value: string) => void, origin?: string) => nativeStore({ platform: 'linux', origin, run }),
    readToken: async () => overrideToken, fetcher: fixtureFetch(calls),
    stdout: (value: string) => { output += value; }, stderr: (value: string) => { diagnostics += value; },
  };
  delete process.env.PAVEGRID_MCP_INTERNAL_BASE_URL;
  await main(['whoami'], options);
  assert.deepEqual(accesses, [{ action: 'lookup', service: production }]);
  assert.equal(calls[0].url.origin, 'https://pavegrid.com');
  assert.equal(String(diagnostics), '');
  accesses.length = 0; calls.length = 0;
  process.env.PAVEGRID_MCP_INTERNAL_BASE_URL = 'https://www.pavegrid.io';
  await assert.rejects(main(['whoami'], options), (e: unknown) => e instanceof ClientError && e.code === 'not_logged_in');
  assert.equal(calls.length, 0, 'the production token must never be sent under an override');
  assert.equal(String(diagnostics), 'Warning: PaveGrid origin override is active: https://www.pavegrid.io\n');
  await main(['login', '--stdin'], options);
  assert.equal(entries.get(alternate), overrideToken);
  await main(['whoami'], options);
  await main(['logout'], options);
  assert.equal(entries.has(alternate), false);
  assert.equal(entries.get(production), token);
  assert.deepEqual(accesses.map(access => access.service), [alternate, alternate, alternate, alternate]);
  assert.ok(calls.every(call => call.url.origin === 'https://www.pavegrid.io'));
  assert.ok(calls.every(call => new Headers(call.init.headers).get('authorization') === `Bearer ${overrideToken}`));
  assert.equal(diagnostics.split('\n').filter(line => line.startsWith('Warning:')).length, 4);
  assert.ok(!(output + diagnostics).includes(token));
  process.env.PAVEGRID_MCP_INTERNAL_BASE_URL = 'https://pavegrid.com';
  diagnostics = '';
  await main(['whoami'], options);
  assert.equal(accesses.at(-1)?.service, production);
  assert.equal(diagnostics, 'Warning: PaveGrid origin override is active: https://pavegrid.com\n');
});
