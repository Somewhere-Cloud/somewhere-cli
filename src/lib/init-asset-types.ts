import type { InitScaffoldFile } from './init-scaffold.js';

/** Types for the asset imports the platform compiler accepts: a bare `.svg` is
 *  a URL default plus a named ReactComponent, `.svg?react` is a component
 *  default, and other media files are URL defaults. Without these the starter's
 *  typecheck refuses those imports before deploy. */
const FILE_ASSET_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'webm', 'wav', 'ogg', 'pdf'];

export const ASSET_TYPES = `// Types for asset imports. The platform compiler serves each as a URL.
declare module '*.svg' {
  import type { FunctionComponent, SVGProps } from 'react';
  const url: string;
  export default url;
  export const ReactComponent: FunctionComponent<SVGProps<SVGSVGElement>>;
}

declare module '*.svg?react' {
  import type { FunctionComponent, SVGProps } from 'react';
  const Component: FunctionComponent<SVGProps<SVGSVGElement>>;
  export default Component;
}
${FILE_ASSET_EXTENSIONS.map(ext => `
declare module '*.${ext}' {
  const url: string;
  export default url;
}
`).join('')}`;

export const ASSET_TYPES_FILE: InitScaffoldFile = { path: 'types/assets.d.ts', content: ASSET_TYPES };
