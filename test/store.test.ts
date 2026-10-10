import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeStore, credentialStore, fileStore, tokenFile, configDirectory, type Runner } from '../src/store.js';
import { ClientError } from '../src/errors.js';
import { token } from './fixtures.js';

test('native store mocks keep secrets out of arguments and handle missing/locked/denied', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const calls: { command: string; args: string[]; input?: string }[] = [];
    const run: Runner = async (command, args, input) => {
      calls.push({ command, args, input });
      if (platform === 'linux') return args[0] === 'lookup' ? { code: 0, stdout: token, stderr: '' } : { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: JSON.stringify({ status: 'ok', token }), stderr: '' };
    };
    const store = nativeStore({ platform, run });
    await store.write(token); assert.ok(await store.read() === token); await store.remove();
    for (const call of calls) {
      const service = platform === 'linux' ? call.args[call.args.indexOf('service') + 1] : JSON.parse(call.input!).service;
      assert.equal(service, 'pavegrid-mcp:production');
    }
    assert.ok(calls.every(call => !call.args.join(' ').includes(token)));
    assert.ok(calls[0].input?.includes(token));
    const missing = nativeStore({ platform, run: async () => platform === 'linux' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '{"status":"missing"}', stderr: '' } });
    assert.equal(await missing.read(), null); await missing.remove();
    await assert.rejects(missing.write(token), ClientError);
    for (const status of ['locked', 'denied', 'unavailable']) {
      const failed = nativeStore({ platform, run: async () => platform === 'linux' ? { code: 1, stdout: '', stderr: status } : { code: 0, stdout: JSON.stringify({ status }), stderr: '' } });
      await assert.rejects(failed.read(), (e: unknown) => e instanceof ClientError && e.code === `store_${status}`);
    }
  }
});
test('each native store backend uses the override namespace', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const run: Runner = async (_command, args, input) => {
      const service = platform === 'linux' ? args[args.indexOf('service') + 1] : JSON.parse(input!).service;
      assert.equal(service, 'pavegrid-mcp:https://www.pavegrid.io');
      return platform === 'linux' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '{"status":"missing"}', stderr: '' };
    };
    assert.equal(await nativeStore({ platform, origin: 'https://www.pavegrid.io', run }).read(), null);
  }
});
test('file credentials use separate paths per origin and leave production intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pavegrid origin files '));
  const production = fileStore(tokenFile('https://pavegrid.com', directory));
  const alternate = fileStore(tokenFile('https://www.pavegrid.io', directory));
  assert.equal(tokenFile('https://pavegrid.com', directory), join(directory, 'ai-token'));
  assert.notEqual(tokenFile('https://www.pavegrid.io', directory), tokenFile('https://pavegrid.com', directory));
  try {
    await production.write(token);
    assert.equal(await alternate.read(), null);
    await alternate.write(`${token}_override`);
    assert.equal(await alternate.read(), `${token}_override`);
    assert.equal(await production.read(), token);
    await alternate.remove();
    assert.equal(await production.read(), token);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('native failure never falls back; explicit file selection warns', async () => {
  let warns = 0;
  const native = credentialStore(false, () => { warns++; });
  assert.ok(native); assert.equal(warns, 0);
  credentialStore(true, () => { warns++; }); assert.equal(warns, 1);
  const bad = nativeStore({ platform: 'unsupported' });
  await assert.rejects(bad.write(token), ClientError);
});
test('real opt-in file storage: private permissions or Windows user-only ACL, no symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pavegrid token '));
  const file = join(directory, 'ai-token');
  const store = fileStore(file);
  try {
    assert.equal(await store.read(), null); await store.write(token);
    assert.ok(await store.read() === token); assert.ok(await readFile(file, 'utf8') === token);
    if (process.platform !== 'win32') {
      assert.equal((await lstat(file)).mode & 0o777, 0o600);
      await chmod(file, 0o644); await assert.rejects(store.read(), ClientError);
      await chmod(file, 0o600);
    }
    await store.remove(); assert.equal(await store.read(), null);
    if (process.platform !== 'win32') {
      await symlink(join(directory, 'other'), file);
      await assert.rejects(store.read(), ClientError); await assert.rejects(store.remove(), ClientError);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('configuration paths work with spaces on each OS', () => {
  assert.match(configDirectory('win32', { APPDATA: 'C:/Users/Example User/AppData/Roaming' }, 'unused'), /Example User/);
  assert.match(configDirectory('darwin', {}, '/Users/Example User'), /Application Support/);
  assert.equal(configDirectory('linux', { XDG_CONFIG_HOME: '/tmp/config space' }, '/home/example'), '/tmp/config space/pavegrid/mcp');
});
