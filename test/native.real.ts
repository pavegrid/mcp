import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeStore, runCommand } from '../src/store.js';
import { main } from '../src/main.js';
import { fixtureFetch } from './fixtures.js';
import { ClientError } from '../src/errors.js';

test('real OS store: missing, login, read, logout, relogin; isolated target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pavegrid keychain '));
  const keychain = join(directory, 'test.keychain-db');
  const service = `pavegrid-mcp:test:${randomUUID()}`;
  const password = randomUUID();
  const token = `pgai_${randomUUID().replaceAll('-', '')}`;
  const other = `pgai_${randomUUID().replaceAll('-', '')}`;
  const command = async (args: string[]) => {
    const result = await runCommand('/usr/bin/security', args);
    assert.equal(result.code, 0, 'temporary keychain lifecycle command failed');
  };
  let created = false;
  try {
    if (process.platform === 'darwin') {
      await command(['create-keychain', '-p', password, keychain]); created = true;
      await command(['set-keychain-settings', keychain]);
      await command(['unlock-keychain', '-p', password, keychain]);
    }
    const store = nativeStore({ service, ...(process.platform === 'darwin' ? { keychain } : {}) });
    assert.equal(await store.read(), null);
    await store.write(token);
    assert.ok(await store.read() === token, 'token round trip failed');
    await store.remove();
    assert.equal(await store.read(), null);
    await store.remove();
    await store.write(other);
    assert.ok(await store.read() === other, 'relogin failed');
    await store.write(token);
    assert.ok(await store.read() === token, 'credential replacement failed');
    if (process.platform === 'darwin') {
      await command(['lock-keychain', keychain]);
      await assert.rejects(store.read(), (error: unknown) => error instanceof ClientError && error.code === 'store_locked');
      await command(['unlock-keychain', '-p', password, keychain]);
    }
    await store.remove();
    let output = '', diagnostics = '';
    const options = { store, readToken: async () => token, fetcher: fixtureFetch(), stdout: (value: string) => { output += value; }, stderr: (value: string) => { diagnostics += value; } };
    await main(['login'], options);
    assert.ok(await store.read() === token, 'CLI login did not store the credential');
    await main(['whoami'], options);
    await main(['logout'], options);
    assert.equal(await store.read(), null);
    await main(['login', '--stdin'], options);
    assert.ok(await store.read() === token, 'CLI relogin did not store the credential');
    await main(['logout'], options);
    assert.ok(!(output + diagnostics).includes(token), 'credential escaped to CLI output');
  } finally {
    if (created) await command(['delete-keychain', keychain]);
    else if (process.platform !== 'darwin') await nativeStore({ service }).remove();
    await rm(directory, { recursive: true, force: true });
  }
});
