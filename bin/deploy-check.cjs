'use strict';

const { existsSync } = require('node:fs');
const { delimiter, join, resolve } = require('node:path');
const { checkerContract } = require('../runtime/declared-data.cjs');

const configPath = process.argv[2];
const projectRoot = process.cwd();
const own = join(projectRoot, 'node_modules', 'typescript');
const compiler = [own, ...(process.env.PATH ?? '').split(delimiter).map(bin => resolve(bin, '..', 'typescript'))]
  .find(dir => existsSync(join(dir, 'package.json')) && require(join(dir, 'package.json')).version === checkerContract.TYPESCRIPT_VERSION);
if (!compiler) throw new Error(`TypeScript ${checkerContract.TYPESCRIPT_VERSION} was not found.`);
const ts = require(compiler);
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = config.error ? null : ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot);
const errors = config.error ? [config.error] : parsed.errors;
if (parsed && !errors.length) {
  const { options, fileNames } = parsed;
  const functionFiles = new Set(config.config.somewhereFunctionFiles.map(file => resolve(projectRoot, file)));
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...args) => {
    const source = read(file, ...args);
    return functionFiles.has(resolve(file)) ? checkerContract.withEndpointBinding(ts, source, options) : source;
  };
  errors.push(...ts.getPreEmitDiagnostics(ts.createProgram(fileNames, options, host)));
}
if (errors.length) {
  process.stdout.write(ts.formatDiagnostics(errors, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => projectRoot,
    getNewLine: () => '\n',
  }));
  process.exitCode = 1;
}
