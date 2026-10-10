import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { requireNode } from '../src/main.js';

const fixture = fileURLToPath(new URL('./stdio-fixture.ts', import.meta.url));
test('stdio discovery and tool calls use a real child process and legacy MCP client', async () => {
  const client = new Client({ name: 'test-stdio-host', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', fixture], stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools(); assert.equal(tools.length, 10);
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    assert.ok(!result.isError); assert.ok(result.structuredContent);
    assert.equal(diagnostics, '');
  } finally { await client.close(); }
});
test('raw stdout contains only JSON-RPC and process exits after EOF', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  let resolveResponse: () => void;
  const responded = new Promise<void>(resolve => { resolveResponse = resolve; });
  child.stdout.on('data', () => { if (stdout.includes('\n')) resolveResponse(); });
  const exited = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'wire-test', version: '1.0.0' } } }) + '\n');
    await responded;
    child.stdin.end();
    assert.equal(await exited, 0); assert.equal(stderr, '');
    const messages = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(messages.every(message => message.jsonrpc === '2.0')); assert.equal(messages[0].id, 1);
  } finally { clearTimeout(timeout); child.kill(); }
});
test('Node 22 startup minimum is independent of installed tooling', () => { assert.throws(() => requireNode('21.7.0')); requireNode('22.0.0'); });
