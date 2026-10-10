import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(process.env.RELEASE_TAG, `v${pkg.version}`, 'release tag must match package version');
assert.equal(pkg.name, '@pavegrid/mcp');
assert.equal(pkg.repository.url, 'https://github.com/pavegrid/mcp.git');
