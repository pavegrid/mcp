import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici';
import { Api, apiOrigin, type Fetcher } from './api.js';
import { credentialStore, type TokenStore } from './store.js';
import { createServer } from './tools.js';
import { ClientError, validateToken } from './errors.js';
import { VERSION } from './version.js';

export const HELP = `PaveGrid read-only AI connection\nUsage: pavegrid-mcp login [--stdin] [--allow-file-store]\n       pavegrid-mcp whoami | serve | logout [--allow-file-store]\n       pavegrid-mcp --help | --version\nNode.js 22 or newer is required; Node.js 24 LTS is recommended.\nLogin reads your token from a hidden prompt, or from stdin with --stdin.\nTokens must never be passed in arguments, environment, or MCP config.\nThe OS credential store is used by default. --allow-file-store explicitly\nselects plain text storage with private file permissions.\n`;
export function requireNode(version = process.versions.node): void {
  if (Number(version.split('.')[0]) < 22) throw new ClientError('node_version', 'PaveGrid MCP requires Node.js 22 or newer. Install Node.js 24 LTS and try again.');
}
export async function readToken(stdin: boolean): Promise<string> {
  if (stdin) {
    let value = '';
    for await (const chunk of process.stdin) {
      value += chunk;
      if (Buffer.byteLength(value) > 2048) throw new ClientError('input', 'Token input is too large.');
    }
    return validateToken(value);
  }
  if (!process.stdin.isTTY) throw new ClientError('terminal', 'Login needs a terminal. Use login --stdin to read a token from stdin.');
  process.stderr.write('AI access token: ');
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return validateToken(await new Promise<string>((resolve, reject) => {
      let value = '';
      const cleanup = () => { process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stderr.write('\n'); };
      const onEnd = () => { cleanup(); reject(new ClientError('cancelled', 'Login cancelled.')); };
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString()) {
          if (char === '\u0003' || char === '\u0004') { onEnd(); return; }
          if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
          else if (char >= ' ') value += char;
          if (value.length > 2048) { cleanup(); reject(new ClientError('input', 'Token input is too large.')); return; }
        }
      };
      process.stdin.on('data', onData);
      process.stdin.on('end', onEnd);
    }));
  } finally { process.stdin.setRawMode(wasRaw); process.stdin.pause(); }
}
export async function main(argv = process.argv.slice(2), options: {
  store?: TokenStore; fetcher?: Fetcher; readToken?: (stdin: boolean) => Promise<string>;
  storeFactory?: typeof credentialStore;
  stdout?: (value: string) => void; stderr?: (value: string) => void;
} = {}): Promise<void> {
  requireNode();
  const stdout = options.stdout ?? (value => process.stdout.write(value));
  const stderr = options.stderr ?? (value => process.stderr.write(value));
  const origin = apiOrigin();
  if (process.env.PAVEGRID_MCP_INTERNAL_BASE_URL !== undefined) stderr(`Warning: PaveGrid origin override is active: ${origin}\n`);
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { stdout(HELP); return; }
  if (argv.length === 1 && argv[0] === '--version') { stdout(VERSION + '\n'); return; }
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'serve';
  const args = command === argv[0] ? argv.slice(1) : argv;
  if (!['login', 'whoami', 'serve', 'logout'].includes(command) || new Set(args).size !== args.length || args.some(arg => arg !== '--allow-file-store' && !(command === 'login' && arg === '--stdin'))) {
    throw new ClientError('usage', 'Use login [--stdin], whoami, serve, logout, --help or --version. Tokens must be entered at the prompt or on stdin.');
  }
  const store = options.store ?? (options.storeFactory ?? credentialStore)(args.includes('--allow-file-store'), value => stderr(value + '\n'), origin);
  if (command === 'logout') {
    await store.remove();
    stderr('Local token removed. To revoke it everywhere, revoke the token in PaveGrid Settings, AI assistant access.\n');
    return;
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new ClientError('tls', 'PaveGrid requires TLS certificate checks. Remove NODE_TLS_REJECT_UNAUTHORIZED=0 and use your company CA certificate.');
  let dispatcher: EnvHttpProxyAgent | undefined;
  const fetcher: Fetcher = options.fetcher ?? (async (url, init) => {
    dispatcher ??= new EnvHttpProxyAgent();
    return await proxyFetch(url, { method: 'GET', redirect: 'manual', headers: init.headers as Record<string, string>, signal: init.signal, dispatcher }) as unknown as Response;
  });
  let serving = false;
  try {
    if (command === 'login') {
      const token = validateToken(await (options.readToken ?? readToken)(args.includes('--stdin')));
      await new Api(token, { fetcher, origin }).whoami();
      await store.write(token);
      stderr('Connected to PaveGrid. Run pavegrid-mcp whoami to see your account.\n');
      return;
    }
    const token = await store.read();
    if (!token) throw new ClientError('not_logged_in', 'Not logged in. Run pavegrid-mcp login first.');
    const api = new Api(token, { fetcher, origin });
    if (command === 'whoami') { stdout(JSON.stringify(await api.whoami()) + '\n'); return; }
    const handle = serveStdio(() => {
      const server = createServer(api);
      server.onclose = () => { void dispatcher?.close(); };
      return server;
    }, { onerror: () => stderr('MCP connection error. Restart your AI app and try again.\n') });
    serving = true;
    const close = () => { void handle.close().then(() => dispatcher?.close()); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } finally { if (!serving) await dispatcher?.close(); }
}
