import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tree = mkdtempSync(join(tmpdir(), 'somewhere-cli-test-tree-'));
const inputs = new Set(['.github', '.gitignore', 'bin', 'runtime', 'scripts', 'server', 'src', 'test',
  'CHANGELOG.md', 'LICENSE', 'README.md', 'npm-shrinkwrap.json', 'package.json', 'tsconfig.json']);

try {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8',
  });
  for (const path of paths.split('\0')) {
    if (!inputs.has(path.split('/')[0]) || !existsSync(join(root, path))) continue;
    const destination = join(tree, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, path), destination);
  }
  symlinkSync(join(root, 'node_modules'), join(tree, 'node_modules'), 'junction');

  // Other builds may replace the checkout's dist while this suite is running.
  const windows = process.platform === 'win32';
  execFileSync(windows ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: tree, stdio: 'inherit', shell: windows });
  const result = spawnSync(process.execPath, ['scripts/test-packed.mjs'], { cwd: tree, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(tree, { recursive: true, force: true });
}
