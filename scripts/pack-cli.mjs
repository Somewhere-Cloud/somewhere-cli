import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBundleBudget, assertPublicArtifact } from './public-projection.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function packCli(destination, source) {
  const output = resolve(destination);
  const stage = mkdtempSync(join(tmpdir(), 'somewhere-release-package-'));
  try {
    const { scripts, devDependencies, ...manifest } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (Object.keys(manifest[field] ?? {}).length) throw new Error(`The standalone CLI cannot declare ${field}`);
    }
    if (source !== undefined) {
      if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('Expected an exact source commit to stamp the tarball');
      manifest.gitHead = source;
    }
    for (const file of manifest.files) {
      if (file === 'npm-shrinkwrap.json') continue;
      const entry = join(stage, file);
      mkdirSync(dirname(entry), { recursive: true });
      cpSync(join(root, file), entry, { recursive: true });
    }
    writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const { name, version, license, bin, engines } = manifest;
    // npm 10 can install build entries from a published shrinkwrap even when
    // they are marked dev. The signed install lock therefore only has a root.
    const shrinkwrap = {
      name, version, lockfileVersion: 3, requires: true,
      packages: { '': { name, version, license, bin, engines, bundleDependencies: [] } },
    };
    writeFileSync(join(stage, 'npm-shrinkwrap.json'), JSON.stringify(shrinkwrap, null, 2) + '\n');

    mkdirSync(output, { recursive: true });
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const [pack] = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', output], {
      cwd: stage, encoding: 'utf8', shell: process.platform === 'win32',
    }));
    assertBundleBudget(pack);
    for (const { path } of pack.files) {
      assertPublicArtifact(path, path);
      assertPublicArtifact(readFileSync(join(stage, path), 'utf8'), path);
    }
    return pack;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
