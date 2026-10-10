import { build } from 'esbuild';
import { chmod, readFile, readdir, rm, appendFile } from 'node:fs/promises';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const version = await readFile(new URL('../src/version.ts', import.meta.url), 'utf8');
if (!version.includes(`'${pkg.version}'`)) throw new Error('package.json and src/version.ts versions differ');
await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
const result = await build({
  entryPoints: ['src/cli.ts'], outfile: 'dist/cli.cjs', bundle: true, platform: 'node', format: 'cjs',
  target: 'node22', metafile: true, minify: false, sourcemap: false, legalComments: 'inline',
  banner: { js: `#!/usr/bin/env node\nif (Number(process.versions.node.split('.')[0]) < 22) { process.stderr.write('PaveGrid MCP requires Node.js 22 or newer. Install Node.js 24 LTS.\\n'); process.exit(1); }` },
});
// Preserve complete license text for each dependency actually included.
const packages = new Set(Object.keys(result.metafile.inputs).flatMap(input => {
  const match = input.match(/^node_modules\/(?:@[^/]+\/)?[^/]+/);
  return match ? [match[0]] : [];
}));
for (const directory of [...packages].sort()) {
  const files = await readdir(directory);
  const licenses = files.filter(file => /^(license|notice|copying)(\.|$)/i.test(file));
  if (!licenses.length) throw new Error(`Missing dependency license: ${directory}`);
  for (const file of licenses) {
    const notice = (await readFile(`${directory}/${file}`, 'utf8')).replaceAll('*/', '* /');
    await appendFile('dist/cli.cjs', `\n/* Bundled dependency ${directory.slice(13)} — ${file}\n${notice}\n*/\n`);
  }
}
await chmod(new URL('../dist/cli.cjs', import.meta.url), 0o755);
