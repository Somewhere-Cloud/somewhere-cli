// Generated from somewhere-tech worker/src/security/browser-secret-scan.ts.
// Refresh with node scripts/generate-credential-patterns.mjs in somewhere-tech.
                                                                                                              

/**
 * THE credential-shape list (pfb_f7b84331ac12 + pfb_6f9dab80d698). One list,
 * read by two rules: a literal in deploy source (scanSourceForSecrets) and the
 * value of a VITE_/REACT_APP_ variable (public-env.ts via matchSecretPatterns).
 * `envName` is the variable name the fix suggests. `ignore` passes the
 * well-known harmless shapes of a pattern (documentation examples, obvious
 * placeholders, the public Supabase anon key).
 */
                         
                          
                
                  
                  
                                         
 

/** Documentation examples and fill-in-the-blank values: a run of a classic
 *  fill character (sk_live_xxxxxxxx…, 00000000, ********) or a word nobody
 *  leaves in a real key. */
const PLACEHOLDER = /[xX]{8,}|0{8,}|\*{8,}|example|your|replace|placeholder|changeme|dummy|redacted/i;
const isPlaceholder = (material        )          => PLACEHOLDER.test(material);

/** A signed token (JWT) is public by design only when its payload says
 *  `role: "anon"` (the Supabase anon key). */
function anonJwt(material        )          {
  try {
    const base64 = material.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload          = JSON.parse(atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')));
    return !!payload && typeof payload === 'object' && (payload                      ).role === 'anon';
  } catch {
    return false;
  }
}

/** A connection URL whose password is a docs placeholder (`<password>`,
 *  `password`, `your-password`, `changeme`) or a template interpolation
 *  (`${env.DB_PASSWORD}`) carries no credential (pfb_13d77cf63108). */
const PLACEHOLDER_PASSWORD = /^(?:<[^>]*>|\$\{[^}]*\}|\{\{?[^}]*\}\}?|password|passwd|pass|pwd|secret)$/i;
function placeholderPassword(material        )          {
  const password = /^[^:]+:\/\/[^:@]*:([^@]+)@/.exec(material)?.[1] ?? '';
  return PLACEHOLDER_PASSWORD.test(password) || isPlaceholder(password);
}

const SECRET_PATTERNS                           = [
  { kind: 'platform-developer-key', label: 'platform developer key', envName: 'SOMEWHERE_API_KEY', pattern: /\bsmt_[A-Za-z0-9]{20,}\b/g, ignore: isPlaceholder },
  { kind: 'stripe-secret-key', label: 'Stripe secret or restricted key', envName: 'STRIPE_SECRET_KEY', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g, ignore: isPlaceholder },
  { kind: 'stripe-webhook-secret', label: 'Stripe webhook signing secret', envName: 'STRIPE_WEBHOOK_SECRET', pattern: /\bwhsec_[A-Za-z0-9+/=]{20,}/g, ignore: isPlaceholder },
  // AKIAIOSFODNN7EXAMPLE is Amazon's documented example key; every example
  // key Amazon publishes ends in EXAMPLE, which the placeholder rule passes.
  { kind: 'aws-access-key-id', label: 'AWS access key id', envName: 'AWS_ACCESS_KEY_ID', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, ignore: isPlaceholder },
  { kind: 'github-token', label: 'GitHub access token', envName: 'GITHUB_TOKEN', pattern: /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}\b/g, ignore: isPlaceholder },
  { kind: 'anthropic-api-key', label: 'Anthropic API key', envName: 'ANTHROPIC_API_KEY', pattern: /\bsk-ant-[A-Za-z0-9_-]{30,}\b/g, ignore: isPlaceholder },
  { kind: 'openai-api-key', label: 'OpenAI API key', envName: 'OPENAI_API_KEY', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/g, ignore: isPlaceholder },
  { kind: 'slack-token', label: 'Slack access token', envName: 'SLACK_TOKEN', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, ignore: isPlaceholder },
  // Mailgun's private key: `key-` and 32 lowercase letters and digits. Both a
  // letter and a digit are required, so a `key-…` class name or i18n key made
  // of words does not match (pfb_13d77cf63108).
  { kind: 'mailgun-api-key', label: 'Mailgun API key', envName: 'MAILGUN_API_KEY', pattern: /\bkey-(?=[a-z]*[0-9])(?=[0-9]*[a-z])[a-z0-9]{32}(?![A-Za-z0-9_-])/g, ignore: isPlaceholder },
  { kind: 'sendgrid-api-key', label: 'SendGrid API key', envName: 'SENDGRID_API_KEY', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, ignore: isPlaceholder },
  // Not preceded by `.`: a Mapbox public token is `pk.eyJ…`.
  {
    kind: 'signed-token',
    label: 'signed access token (JWT)',
    envName: 'ACCESS_TOKEN',
    pattern: /(?<![A-Za-z0-9_.-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{10,}/g,
    ignore: anonJwt,
  },
  // A connection string is only a credential when it CARRIES one. The
  // userinfo `user:password@` is therefore required, not optional: `postgres://`
  // on its own, `postgres://localhost:5432/app`, and `postgres://reader@host/db`
  // are a scheme, a local DSN and a passwordless DSN — none is a secret, and all
  // three appear in ordinary setup prose. Requiring a non-empty password and a
  // host is what separates the leak from the documentation; a placeholder or
  // interpolated password passes. Each scheme is covered by fixtures in
  // test-source-secret-refusal and check-scanner.
  {
    kind: 'postgres-connection-string',
    label: 'Postgres connection string with a password',
    envName: 'DATABASE_URL',
    pattern: /\bpostgres(?:ql)?:\/\/[^\s:/?#@'"`]+:[^\s@'"`]+@[^\s/?#'"`]+/g,
    ignore: placeholderPassword,
  },
  // Redis commonly carries only a password (`rediss://:secret@host`), so the
  // user may be empty here (pfb_13d77cf63108).
  {
    kind: 'connection-string',
    label: 'database connection string with a password',
    envName: 'DATABASE_URL',
    pattern: /\b(?:mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:/?#@'"`]*:[^\s@/'"`]+@[^\s/?#'"`]+/g,
    ignore: placeholderPassword,
  },
  { kind: 'private-key', label: 'private key material', envName: 'PRIVATE_KEY', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
];


export { SECRET_PATTERNS };
