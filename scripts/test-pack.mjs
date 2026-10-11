import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'pavegrid packed bundle '));
const keychain = join(directory, 'test.keychain-db');
const password = randomUUID();
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20000, ...options });
  if (result.error) throw new Error('Package test command could not run');
  return result;
}
let created = false;
try {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'Run package checks with npm run test:pack');
  // npm supplies its CLI path to scripts. Calling it through Node avoids the
  // Windows .cmd shim and preserves paths with spaces as single arguments.
  const packed = run(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', directory], { cwd: repo });
  assert.equal(packed.status, 0, 'npm pack failed');
  const parsed = JSON.parse(packed.stdout);
  const metadata = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  assert.deepEqual(metadata.files.map(file => file.path).sort(), ['CHANGELOG.md', 'LICENSE', 'README.md', 'SECURITY.md', 'dist/cli.cjs', 'package.json'].sort());
  const unpacked = join(directory, 'unpacked with spaces'); await mkdir(unpacked);
  const extracted = run('tar', ['-xzf', join(directory, metadata.filename), '-C', unpacked]); assert.equal(extracted.status, 0, 'tar extraction failed');
  const cli = join(unpacked, 'package', 'dist', 'cli.cjs');
  const env = { ...process.env, PAVEGRID_MCP_TEST_SERVICE: `pavegrid-mcp:test:${randomUUID()}` };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  if (process.platform === 'darwin') {
    assert.equal(run('/usr/bin/security', ['create-keychain', '-p', password, keychain]).status, 0); created = true;
    assert.equal(run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]).status, 0);
    env.PAVEGRID_MCP_TEST_KEYCHAIN = keychain;
  }
  for (const arg of ['--help', '--version']) {
    const result = run(process.execPath, [cli, arg], { cwd: unpacked, env });
    assert.equal(result.status, 0, arg); assert.equal(result.stderr, ''); if (arg === '--help') assert.match(result.stdout, /PaveGrid read-only/); else assert.equal(result.stdout, `${version}\n`);
  }
  const loggedOut = run(process.execPath, [cli, 'whoami'], { cwd: unpacked, env });
  assert.equal(loggedOut.status, 1); assert.equal(loggedOut.stdout, ''); assert.match(loggedOut.stderr, /^Not logged in\. Run pavegrid-mcp login first\.\n$/);
  const refused = run(process.execPath, [cli, 'whoami'], { cwd: unpacked, env: { ...env, PAVEGRID_MCP_INTERNAL_BASE_URL: 'https://example.com' } });
  assert.equal(refused.status, 1); assert.equal(refused.stdout, ''); assert.equal(refused.stderr, 'PaveGrid origin is not allowed.\n');
  const pkg = JSON.parse(await readFile(join(unpacked, 'package', 'package.json'), 'utf8'));
  assert.ok(!pkg.dependencies || !Object.keys(pkg.dependencies).length);
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly']) assert.ok(!pkg.scripts?.[hook]);
  console.log('Packed bundle passes --help, --version and logged-out whoami with plain node outside the repo; isolated credential target, path with spaces, no runtime dependencies.');
} finally {
  if (created) assert.equal(run('/usr/bin/security', ['delete-keychain', keychain]).status, 0, 'temporary keychain cleanup failed');
  await rm(directory, { recursive: true, force: true });
}
