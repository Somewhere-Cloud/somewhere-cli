/**
 * Deploy-relative path policy.
 *
 * Deploy maps become object-store keys and are later returned by source export
 * for local writes. Accept only already-normalized, project-relative paths so
 * neither side has to guess whether `..`, a backslash, or a control character
 * is data or navigation. Sensitive paths are rejected separately so secrets
 * never enter the public deploy namespace in the first place.
 */

export type DeployPathIssueKind = 'unsafe' | 'sensitive';

export interface DeployPathIssue {
  kind: DeployPathIssueKind;
  reason: string;
}

const MAX_DEPLOY_PATH_LENGTH = 1024;
const MAX_DEPLOY_SEGMENT_LENGTH = 255;
const RAW_STATIC_MARKER = '.somewhere/raw-static';
const PRIVATE_KEY_NAME_RE = /^id_(?:rsa|dsa|ecdsa|ed25519)$/i;
const SENSITIVE_EXTENSION_RE = /\.(?:pem|key|p12|pfx)$/i;
// `credentials` is only a secret when it carries a DATA extension (or none).
// `credentials.ts` / `.tsx` / `.md` are source and docs — a component that
// renders a credentials form, or a page documenting them, is normal customer
// code (rule 9: the guard must not reject the legitimate pattern). Bare
// `credentials` with no extension stays blocked: that shape is a secrets file.
const SENSITIVE_BASENAME_RE = /^(?:credentials(?:\.(?:json|ya?ml|toml|ini|txt|env|cfg|conf|properties))?|secrets?(?:\.(?:json|ya?ml|toml|ini))?|service[-_.]?account(?:[-_.]?key)?\.json)$/i;
// `.env.example` / `.env.sample` / `.env.template` exist SPECIFICALLY to carry
// no secrets — they are the committed placeholder every real repo ships, so
// blocking them failed a customer's first deploy with a message implying we
// found a live secret (rule 9). Every other `.env*` variant stays blocked.
const SENSITIVE_ENV_TEMPLATE_RE = /^\.env\.(?:example|sample|template|dist)$/i;
const SENSITIVE_DOT_SEGMENT_RE = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.npmrc|\.yarnrc|\.pypirc|\.netrc|\.dockerconfigjson|\.htpasswd)$/i;

function isSensitiveDotSegment(segment: string): boolean {
  if (SENSITIVE_ENV_TEMPLATE_RE.test(segment)) return false;
  return SENSITIVE_DOT_SEGMENT_RE.test(segment);
}

function decodeForInspection(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function unsafePathReason(path: string): string | null {
  if (path.length === 0) return 'path must not be empty';
  if (path.length > MAX_DEPLOY_PATH_LENGTH) {
    return `path exceeds ${MAX_DEPLOY_PATH_LENGTH} characters`;
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    return 'path must be relative to the project root';
  }
  if (/[\\\x00-\x1f\x7f]/.test(path)) {
    return 'path contains a backslash or control character';
  }

  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.') return 'path must be normalized (no empty or "." segments)';
    if (segment === '..') return 'path may not contain ".." segments';
    if (segment.length > MAX_DEPLOY_SEGMENT_LENGTH) {
      return `path segment exceeds ${MAX_DEPLOY_SEGMENT_LENGTH} characters`;
    }
  }

  const decoded = decodeForInspection(path);
  if (decoded === null) return 'path contains invalid percent encoding';
  if (decoded !== path) {
    if (decoded.startsWith('/') || /^[A-Za-z]:/.test(decoded)) {
      return 'path decodes to an absolute path';
    }
    if (/%2f/i.test(path) || /[\\\x00-\x1f\x7f]/.test(decoded)) {
      return 'path decodes to a separator or control character';
    }
    const decodedSegments = decoded.split('/');
    if (decodedSegments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      return 'path decodes to a non-normalized or traversal path';
    }
  }

  return null;
}

/** High-confidence secret/dotfile detection after path safety is established. */
export function isSensitiveDeployPath(path: string): boolean {
  const inspected = decodeForInspection(path) ?? path;
  const lowerPath = inspected.toLowerCase();
  if (lowerPath === RAW_STATIC_MARKER) return false;

  const segments = inspected.split('/');
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    // ACME/security metadata must remain deployable. The segment is public by
    // definition and is not a credential container like other dot-directories.
    if (lower === '.well-known') continue;
    if (isSensitiveDotSegment(segment)) return true;
    if (PRIVATE_KEY_NAME_RE.test(segment)) return true;
    if (SENSITIVE_EXTENSION_RE.test(segment)) return true;
    if (SENSITIVE_BASENAME_RE.test(segment)) return true;
  }
  return false;
}

export function inspectDeployPath(path: string, options: { allowSensitive?: boolean } = {}): DeployPathIssue | null {
  const unsafe = unsafePathReason(path);
  if (unsafe) return { kind: 'unsafe', reason: unsafe };
  if (!options.allowSensitive && isSensitiveDeployPath(path)) {
    return { kind: 'sensitive', reason: 'secret-bearing dotfiles, credentials, and private-key files cannot be deployed' };
  }
  return null;
}

/** True only for a path safe to return from source export / local pull. */
export function isSafeDeployExportPath(path: string): boolean {
  return inspectDeployPath(path) === null;
}
