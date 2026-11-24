import { build } from 'esbuild';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyDeclaredDataVendor } from './platform-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
verifyDeclaredDataVendor(root);
const dist = join(root, 'dist');
// The platform's pinned docs and starter tools also import these paths by
// filename. Route those imports to the same implementation as the CLI.
const { files } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const entries = files.filter(file => /^dist\/.+\.js$/.test(file))
  .map(file => file.slice('dist/'.length))
  .filter(file => file !== 'index.js' && file !== 'lib/bundle.js');
const factories = entries.map(file => `  ${JSON.stringify(file)}: () => require(${JSON.stringify('./dist/' + file)}),`);

const result = await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export const runCli = () => require('./dist/index.js').runCli();",
      'const factories = {',
      ...factories,
      '};',
      'export const loadEntry = name => factories[name]();',
    ].join('\n'),
    resolveDir: root,
    sourcefile: 'cli-bundle-entry.js',
  },
  outfile: join(dist, 'lib', 'bundle.js'),
  bundle: true,
  platform: 'node',
  target: 'node22.19',
  format: 'esm',
  minify: false,
  keepNames: true,
  legalComments: 'eof',
  sourcemap: 'linked',
  sourcesContent: false,
  metafile: true,
  // The existing runtime lock does not install debug's optional color package.
  plugins: [{
    name: 'debug-without-optional-colors',
    setup(builder) {
      builder.onResolve({ filter: /^supports-color$/ }, ({ importer }) =>
        importer.replaceAll('\\', '/').includes('/node_modules/debug/') ? { path: 'supports-color', namespace: 'absent-optional-package' } : undefined);
      builder.onLoad({ filter: /^supports-color$/, namespace: 'absent-optional-package' }, () =>
        ({ contents: 'module.exports = false;' }));
    },
  }],
  banner: { js: [
    '// Somewhere CLI. Module labels name the original source or npm package.',
    '// See bundle.js.map for original sources and NOTICE.third-party.txt for licenses.',
    'import { createRequire as createBundleRequire } from "node:module";',
    'const require = createBundleRequire(import.meta.url);',
  ].join('\n') },
});

for (const output of Object.values(result.metafile.outputs)) {
  for (const entry of output.imports) {
    if (entry.external && !isBuiltin(entry.path)) throw new Error(`Unbundled npm import: ${entry.path}`);
  }
}

const bundled = Object.values(result.metafile.outputs)
  .flatMap(output => Object.keys(output.inputs))
  .filter(file => file.split('/').includes('node_modules'));
const dependencies = new Set(bundled.map(file => {
  const parts = file.split('/');
  const first = parts.lastIndexOf('node_modules') + 1;
  return parts.slice(0, first + (parts[first].startsWith('@') ? 2 : 1)).join('/');
}));
// These npm releases declare a license but omitted the corresponding file.
const suppliedNotices = {
  '@npmcli/agent@4.0.2': {
    file: 'npmcli-agent-4.0.2.txt',
    attribution: 'Upstream npm metadata credits GitHub Inc. and specifies ISC. The license text is from SPDX.',
    source: 'https://github.com/npm/agent/blob/db7852869c74ceb8985d7c36b291a2e7a866741c/package.json',
  },
  '@sigstore/verify@3.1.1': {
    file: 'sigstore-verify-3.1.1.txt',
    attribution: 'License from the source repository at the npm release commit.',
    source: 'https://github.com/sigstore/sigstore-js/blob/c1dc7d4778a450787fc72b083f2490ad02b714c6/LICENSE',
  },
};
const notices = ['Third-party notices for the Somewhere CLI bundle', ''];
for (const dependency of [...dependencies].sort()) {
  const directory = join(root, dependency);
  const { name, version, license } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const files = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice|copyright)(?:[._ -]|$)/i.test(entry.name))
    .map(entry => entry.name).sort();
  const identifier = `${name}@${version}`;
  notices.push(`=== ${identifier} (${license}) ===`, '');
  if (!files.length) {
    const notice = suppliedNotices[identifier];
    if (!notice) throw new Error(`Missing third-party notice for ${identifier} (${license})`);
    notices.push(notice.attribution, notice.source, '', readFileSync(join(root, 'scripts', 'licenses', notice.file), 'utf8').trimEnd(), '');
  }
  for (const file of files) {
    notices.push(file, readFileSync(join(directory, file), 'utf8').trimEnd(), '');
  }
}
// Independently vendored runtime files carry their own source manifests.
const vendored = new Map();
for (const manifest of ['DECLARED-DATA-VENDOR.json', 'SOURCE-LINT-VENDOR.json']) {
  const { source_files } = JSON.parse(readFileSync(join(root, 'runtime', manifest), 'utf8'));
  for (const [file, digest] of Object.entries(source_files)) {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file);
    if (!match) continue;
    const [, name] = match;
    if (!vendored.has(name)) vendored.set(name, new Map());
    vendored.get(name).set(file, digest);
  }
}
const runtimeNotices = JSON.parse(readFileSync(join(root, 'scripts/licenses/vendored-runtime.json'), 'utf8'));
for (const name of [...vendored.keys()].sort()) {
  const notice = runtimeNotices[name];
  const fingerprint = createHash('sha256').update(JSON.stringify([...vendored.get(name)].sort())).digest('hex');
  if (notice?.source_sha256 !== fingerprint) throw new Error(`Refresh the vendored runtime notice for ${name}`);
  notices.push(`=== ${name}@${notice.version} (${notice.license}) in runtime/ ===`,
    '', readFileSync(join(root, 'scripts/licenses', notice.file), 'utf8').trimEnd(), '');
}
writeFileSync(join(root, 'NOTICE.third-party.txt'), notices.join('\n'));

// Publish just the declaration graph reachable from the two public entry points.
const declarations = new Set();
function copyDeclaration(filename) {
  if (declarations.has(filename)) return;
  declarations.add(filename);
  const destination = join(dist, 'types', relative(dist, filename));
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(filename, destination);
  const source = readFileSync(filename, 'utf8');
  for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
    if (!specifier.startsWith('.')) continue;
    const target = resolve(dirname(filename), specifier.replace(/\.js$/, '.d.ts'));
    const declaration = existsSync(target) ? target : target + '.d.ts';
    if (!declaration.startsWith(dist + sep)) throw new Error(`Declaration outside dist: ${specifier}`);
    copyDeclaration(declaration);
  }
}

for (const name of ['script', 'testing']) copyDeclaration(join(dist, name + '.d.ts'));

// Match the original JavaScript exports, including aliases and the reporter's
// default export, without executing a project entry point in the build.
const program = ts.createProgram(entries.map(file => join(dist, file)), { allowJs: true, noEmit: true });
const checker = program.getTypeChecker();
for (const entry of entries) {
  const filename = join(dist, entry);
  const source = program.getSourceFile(filename);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`Bundle entry has no exports: ${entry}`);
  const exports = checker.getExportsOfModule(module).map(symbol => symbol.name).sort();
  const bundle = relative(dirname(filename), join(dist, 'lib', 'bundle.js')).replaceAll(sep, '/');
  const specifier = bundle.startsWith('.') ? bundle : './' + bundle;
  const lines = [
    `import { loadEntry } from ${JSON.stringify(specifier)};`,
    `const entry = loadEntry(${JSON.stringify(entry)});`,
  ];
  const named = exports.filter(name => name !== 'default');
  if (named.length) lines.push(`export const { ${named.join(', ')} } = entry;`);
  if (exports.includes('default')) lines.push('export default entry.default;');

  // Two platform checks read compiler literals directly from these files.
  const inspected = { 'commands/init.js': 'DEFAULT_AUTH_SELECTION', 'lib/declared-data.js': 'SW_ENDPOINT_GLOBAL' }[entry];
  if (inspected) {
    const declaration = source.statements.flatMap(statement => ts.isVariableStatement(statement)
      ? [...statement.declarationList.declarations] : []).find(item => item.name.getText(source) === inspected);
    if (!declaration?.initializer) throw new Error(`Missing ${inspected} in ${entry}`);
    lines.push(`const ${declaration.getText(source)};`);
  }
  writeFileSync(filename, lines.join('\n') + '\n');
}
writeFileSync(join(dist, 'index.js'), "export { runCli } from './lib/bundle.js';\nimport { runCli } from './lib/bundle.js';\nif (import.meta.main) void runCli();\n");

if (process.env.SOMEWHERE_PLATFORM_SOURCE) {
  execFileSync(process.execPath, [join(root, 'scripts/vendor-declared-data.mjs'), process.env.SOMEWHERE_PLATFORM_SOURCE, '--check'], { stdio: 'inherit' });
}
