import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClientError, validateToken } from './errors.js';
import { apiOrigin } from './api.js';
import { MAC_SCRIPT, WINDOWS_SCRIPT, WINDOWS_ACL_SCRIPT } from './native-scripts.js';

export interface TokenStore { read(): Promise<string | null>; write(token: string): Promise<void>; remove(): Promise<void> }
export type CommandResult = { code: number; stdout: string; stderr: string };
export type Runner = (command: string, args: string[], input?: string) => Promise<CommandResult>;
// A cold PowerShell start on Windows can take over 10 s (seen on GitHub's windows-latest runner).
export const HELPER_TIMEOUT_MS = 30000;
export const runCommand: Runner = (command, args, input) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '', bytes = 0;
  const timer = setTimeout(() => { child.kill(); reject(storeError('unavailable')); }, HELPER_TIMEOUT_MS);
  for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) {
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) { child.kill(); reject(storeError('unavailable')); return; }
      if (key === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    });
  }
  child.on('error', () => { clearTimeout(timer); reject(storeError('unavailable')); });
  child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  child.stdin.on('error', () => { /* Process exit determines the result. */ });
  child.stdin.end(input);
});
function storeError(status: string): ClientError {
  const messages: Record<string, string> = {
    locked: 'Your OS credential store is locked. Unlock it and try again.',
    denied: 'Access to your OS credential store was denied. Allow access and try again.',
    unavailable: 'Your OS credential store is unavailable. Check Keychain, Credential Manager, or Linux libsecret. No token file was used.',
  };
  return new ClientError(`store_${status}`, messages[status] ?? messages.unavailable);
}
function encoded(script: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}
function originNamespace(origin: string): string {
  return apiOrigin(origin) === 'https://pavegrid.com' ? 'production' : origin;
}
export function nativeStore(options: { platform?: string; service?: string; origin?: string; keychain?: string; run?: Runner } = {}): TokenStore {
  const platform = options.platform ?? process.platform;
  const namespace = originNamespace(apiOrigin(options.origin));
  const service = options.service
    ? options.service + (namespace === 'production' ? '' : `:${namespace}`)
    : `pavegrid-mcp:${namespace}`;
  const run = options.run ?? runCommand;
  const operate = async (action: 'read' | 'write' | 'remove', token?: string): Promise<string | null> => {
    let result: CommandResult;
    if (platform === 'darwin' || platform === 'win32') {
      const input = JSON.stringify({ action, service, keychain: options.keychain, token });
      result = platform === 'darwin'
        ? await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT], input)
        : await run('powershell.exe', encoded(WINDOWS_SCRIPT), input);
      if (result.code !== 0) throw storeError('unavailable');
      let reply: { status: string; token?: string };
      try { reply = JSON.parse(result.stdout) as typeof reply; } catch { throw storeError('unavailable'); }
      if (reply.status === 'missing' && action !== 'write') return null;
      if (reply.status !== 'ok') throw storeError(['locked', 'denied'].includes(reply.status) ? reply.status : 'unavailable');
      return action === 'read' ? validateToken(reply.token ?? '') : null;
    }
    if (platform !== 'linux') throw storeError('unavailable');
    result = await run('secret-tool', [action === 'read' ? 'lookup' : action === 'write' ? 'store' : 'clear',
      ...(action === 'write' ? ['--label=PaveGrid AI access'] : []), 'service', service, 'account', 'pavegrid'], token);
    if (action !== 'write' && result.code === 1 && !result.stderr.trim() && !result.stdout.trim()) return null;
    if (result.code !== 0) {
      if (/locked|prompt|dismissed/i.test(result.stderr)) throw storeError('locked');
      if (/denied|permission|not authorized/i.test(result.stderr)) throw storeError('denied');
      throw storeError('unavailable');
    }
    return action === 'read' ? validateToken(result.stdout) : null;
  };
  return {
    read: () => operate('read'),
    write: async token => { await operate('write', validateToken(token)); },
    remove: async () => { await operate('remove'); },
  };
}
export function configDirectory(platform = process.platform, env = process.env, home = homedir()): string {
  if (platform === 'win32') return win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), 'PaveGrid', 'mcp');
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'PaveGrid', 'mcp');
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), 'pavegrid', 'mcp');
}
export function tokenFile(origin: string, directory = configDirectory()): string {
  const namespace = originNamespace(origin);
  return join(directory, namespace === 'production' ? 'ai-token' : `ai-token-${encodeURIComponent(namespace)}`);
}
export function fileStore(file = tokenFile(apiOrigin()), platform: string = process.platform, run: Runner = runCommand): TokenStore {
  const privateError = () => new ClientError('unsafe_file', 'The token file could not be accessed safely. Check its owner and permissions.');
  const acl = async (path: string, action: 'secure' | 'verify') => {
    const result = await run('powershell.exe', encoded(WINDOWS_ACL_SCRIPT), JSON.stringify({ path, action }));
    if (result.code !== 0) throw privateError();
  };
  const verify = async (path: string, directory = false) => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (!directory && info.nlink !== 1)) throw privateError();
    if (platform === 'win32') { if (!directory) await acl(path, 'verify'); }
    else if ((info.mode & 0o077) || info.uid !== process.getuid?.()) throw privateError();
  };
  return {
    async read() {
      try {
        await verify(dirname(file), true);
        await verify(file);
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const info = await handle.stat();
          if (info.size > 2048 || !info.isFile() || info.nlink !== 1 || (platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid?.()))) throw privateError();
          return validateToken(await handle.readFile('utf8'));
        } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw privateError();
      }
    },
    async write(value) {
      const token = validateToken(value);
      const directory = dirname(file);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await verify(directory, true);
      const temp = join(directory, `.token-${randomUUID()}`);
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        if (platform === 'win32') await acl(temp, 'secure'); else await chmod(temp, 0o600);
        await handle.writeFile(token);
        await handle.sync();
        await handle.close();
        await rename(temp, file);
        await verify(file);
      } finally { await handle.close(); await rm(temp, { force: true }); }
    },
    async remove() {
      try { await verify(dirname(file), true); await verify(file); await rm(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw privateError(); }
    },
  };
}
export function credentialStore(allowFileStore: boolean, warn: (message: string) => void, origin = apiOrigin()): TokenStore {
  apiOrigin(origin);
  if (!allowFileStore) {
    // Isolated subprocess test targets, never the user's regular credentials.
    const service = process.env.PAVEGRID_MCP_TEST_SERVICE;
    if (service && /^pavegrid-mcp:test:[a-f0-9-]{36}$/.test(service)) return nativeStore({ service, origin, keychain: process.env.PAVEGRID_MCP_TEST_KEYCHAIN });
    return nativeStore({ origin });
  }
  warn('Warning: --allow-file-store stores your token as plain text in a private local file.');
  return fileStore(tokenFile(origin));
}
