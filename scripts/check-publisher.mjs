import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const version = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim().split('.').map(Number);
assert.ok(version[0] > 11 || (version[0] === 11 && (version[1] > 5 || (version[1] === 5 && version[2] >= 1))), 'npm >=11.5.1 is required for trusted publishing');
assert.ok(!process.env.NPM_TOKEN && !process.env.NODE_AUTH_TOKEN, 'publish must use OIDC, without registry tokens');
