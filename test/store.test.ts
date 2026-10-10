import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeStore, credentialStore, fileStore, tokenFile, configDirectory, runCommand, type Runner } from '../src/store.js';
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
  const directory = await mkdtemp(join(tmpdir(), 'pavegrid token [literal] $ '));
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
test('failed Windows ACL setup refuses storage before writing a token and removes the temporary file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pavegrid refused ACL '));
  const file = join(directory, 'ai-token');
  const run: Runner = async (command, args, input) => {
    assert.equal(command, 'powershell.exe');
    assert.equal(args[3], '-EncodedCommand');
    assert.ok(!args.join(' ').includes(directory));
    assert.ok(!args.join(' ').includes(token));
    const request = JSON.parse(input!);
    assert.equal(request.action, 'secure');
    assert.equal(await readFile(request.path, 'utf8'), '');
    return { code: 1, stdout: '', stderr: 'Access denied' };
  };
  try {
    await assert.rejects(fileStore(file, 'win32', run).write(token), ClientError);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('Windows file storage verifies the exact user-only ACL and rejects unsafe changes', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pavegrid ACL [literal] $ '));
  const file = join(directory, 'ai-token');
  const store = fileStore(file);
  // Independent inspection and tampering of the real ACL, using stdin for paths.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $req.path
if ($req.action -eq 'inspect') {
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{sid=$_.IdentityReference.Value; rights=$_.FileSystemRights.ToString(); type=$_.AccessControlType.ToString(); inherited=$_.IsInherited}
  })
  @{owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; current=$sid.Value; protected=$acl.AreAccessRulesProtected; rules=$rules} | ConvertTo-Json -Depth 4 -Compress
  exit 0
}
if ($req.action -eq 'inherit') {
  $acl.SetAccessRuleProtection($false, $true)
} elseif ($req.action -eq 'extra') {
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
} else {
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  if ($req.action -eq 'read-only') {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'Read', 'Allow'))
  }
}
Set-Acl -LiteralPath $req.path -AclObject $acl
`;
  const operate = async (action: string) => {
    const result = await runCommand('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], JSON.stringify({ path: file, action }));
    assert.equal(result.code, 0, 'test ACL operation failed');
    return result.stdout;
  };
  try {
    await store.write(token);
    const acl = JSON.parse(await operate('inspect'));
    assert.equal(acl.owner, acl.current);
    assert.equal(acl.protected, true);
    assert.deepEqual(acl.rules, [{ sid: acl.current, rights: 'FullControl', type: 'Allow', inherited: false }]);
    for (const action of ['extra', 'inherit', 'read-only', 'empty']) {
      await operate(action);
      await assert.rejects(store.read(), ClientError);
      await assert.rejects(store.remove(), ClientError);
      // Restore via the normal atomic replacement path, not the test helper.
      await store.write(token);
      assert.equal(await store.read(), token);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('configuration paths work with spaces on each OS', () => {
  assert.equal(configDirectory('win32', { APPDATA: 'C:/Users/Example User/AppData/Roaming' }, 'unused'), 'C:\\Users\\Example User\\AppData\\Roaming\\PaveGrid\\mcp');
  assert.equal(configDirectory('win32', {}, 'C:\\Users\\Example User'), 'C:\\Users\\Example User\\AppData\\Roaming\\PaveGrid\\mcp');
  assert.equal(configDirectory('darwin', {}, '/Users/Example User'), '/Users/Example User/Library/Application Support/PaveGrid/mcp');
  assert.equal(configDirectory('linux', { XDG_CONFIG_HOME: '/tmp/config space' }, '/home/example'), '/tmp/config space/pavegrid/mcp');
  assert.equal(configDirectory('linux', {}, '/home/example'), '/home/example/.config/pavegrid/mcp');
});
