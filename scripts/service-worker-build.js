import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PUBLIC_SHELL_FILES = ['favicon.svg', 'manifest.json', 'icon-192.png', 'icon-512.png'];
const integrity = bytes => `sha256-${createHash('sha256').update(bytes).digest('base64')}`;

export function buildServiceWorker(bundle, publicFiles, template) {
  const files = new Map();
  for (const output of Object.values(bundle)) {
    if (output.fileName !== 'index.html' && !output.fileName.startsWith('assets/')) continue;
    files.set(`/${output.fileName}`, output.type === 'chunk' ? output.code : output.source);
  }
  if (!files.has('/index.html')) throw new Error('Cannot precache CLC: the built index.html is missing.');
  files.set('/', files.get('/index.html'));
  for (const name of PUBLIC_SHELL_FILES) {
    if (!publicFiles[name]) throw new Error(`Cannot precache CLC: public/${name} is missing.`);
    files.set(`/${name}`, publicFiles[name]);
  }
  const manifest = [...files].sort(([a], [b]) => a.localeCompare(b))
    .map(([url, bytes]) => ({ url, integrity: integrity(typeof bytes === 'string' ? Buffer.from(bytes) : bytes) }));
  const version = createHash('sha256').update(template).update(JSON.stringify(manifest)).digest('hex').slice(0, 20);
  if (!template.includes('__CLC_CACHE_VERSION__') || !template.includes('/* __CLC_PRECACHE_MANIFEST__ */ []')) {
    throw new Error('Cannot precache CLC: the service-worker template markers are missing.');
  }
  return template.replace('__CLC_CACHE_VERSION__', version)
    .replace('/* __CLC_PRECACHE_MANIFEST__ */ []', JSON.stringify(manifest));
}

export function serviceWorkerBuild() {
  let publicDir;
  return {
    name: 'clc-offline-shell',
    apply: 'build',
    enforce: 'post',
    configResolved(config) { publicDir = config.publicDir; },
    writeBundle: {
      order: 'post',
      handler(options, bundle) {
        // Vite's preload pass still rewrites chunks during generateBundle. Hash
        // the final bytes on disk so fetch integrity matches Docker's exact files.
        const files = Object.fromEntries(Object.values(bundle).map(output => [output.fileName, {
          type: 'asset', fileName: output.fileName, source: readFileSync(resolve(options.dir, output.fileName)),
        }]));
        const publicFiles = Object.fromEntries(PUBLIC_SHELL_FILES.map(name => [name, readFileSync(resolve(options.dir, name))]));
        const template = readFileSync(resolve(publicDir, 'sw.js'), 'utf8');
        writeFileSync(resolve(options.dir, 'sw.js'), buildServiceWorker(files, publicFiles, template));
      },
    },
  };
}
