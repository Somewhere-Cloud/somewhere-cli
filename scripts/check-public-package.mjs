import { fileURLToPath } from 'node:url';
import { assertPublicPackage } from './public-projection.mjs';
console.log('Public package identifier scan:', assertPublicPackage(fileURLToPath(new URL('..', import.meta.url))));
