import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packCli } from './pack-cli.mjs';

const [destination, source] = process.argv.slice(2);
const output = destination ? resolve(destination) : mkdtempSync(join(tmpdir(), 'somewhere-package-check-'));
try {
  const pack = packCli(output, source);
  const expected = process.env.REHEARSED_SHA512;
  if (expected && createHash('sha512').update(readFileSync(join(output, pack.filename))).digest('hex') !== expected) {
    throw new Error('The packed CLI differs from the rehearsed tarball.');
  }
  console.log(JSON.stringify({ version: pack.version, files: pack.entryCount, compressed: pack.size, unpacked: pack.unpackedSize }));
  if (destination && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${join(output, pack.filename)}\n`);
  }
} finally {
  if (!destination) rmSync(output, { recursive: true, force: true });
}
