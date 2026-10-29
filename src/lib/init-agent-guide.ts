import { BUNDLED_SKILLS_PACK } from './skills-pack.generated.js';
import { SKILLS_DIR, skillNames } from './skills-pack.js';

// Generated mirror of somewhere.cloud/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Getting started — build, deploy, verify

\`somewhere init --name <slug>\` creates a React + TypeScript app; no login needed.
Default: sign-in UI. Minimal: SDK and auth route. Bare: neither. \`init --catalog --json\` lists \`--features\` modules.
\`npx @somewhere-cloud/cli deploy\` publishes a temporary app and prints its live
URL, claim URL and expiry. Login is needed for account-owned operations,
the email test inbox and cron. On a hosted VM, \`somewhere login\` uses browser approval and keeps you signed in.
Start auth/data/cron with \`somewhere docs recipe-signed-in-app --full\`.

After edits: \`somewhere typecheck\` and focused local/browser tests. Publish:
1. \`somewhere deploy\` (do not build first). Deploy
   checks compilation, schema and secrets, refusing a blank page
   before going live; \`somewhere deploy-check\` runs them without publishing
   (diagnosis, review, \`--run /api/x\`).
2. Run \`somewhere verify\` once on the final deployed journey (or
   \`--flow flow.json\`); rerun after fixes. Sign test users up
   in-app at \`*.test.somewhere.site\`; more: \`actors\` + \`journey\` (\`somewhere docs browser\`).
3. \`somewhere browser\` inspects a page; \`somewhere logs --tail 10\`, then
   \`somewhere errors\`: read the failure first.
4. Test mail: \`somewhere email test-inbox <addr>\` includes \`verification_code\`.
   Don't retest sign-in or \`sw.db.from\` scoping; test each table's scope, auth before \`sw.db.server\`/raw SQL, bad input and journeys.

Routes: \`index.html\` loads \`src/main.tsx\`; every extensionless path with no file
(\`/signin\`) serves \`index.html\`, so one app routes by \`location.pathname\`.
\`api/notes/[id].ts\` is \`/api/notes/:id\`; \`_\`-prefixed names are import-only
helpers. Avoid names differing only in letter case (\`SignIn.tsx\`, \`signin.tsx\`).

With auth enabled, \`api/auth/[...path].ts\` is
\`export { somewhereAuth as default } from '@somewhere-cloud/sdk/server'\`; pages
use \`createSomewhereAuth()\` from \`@somewhere-cloud/sdk/auth\` (no SDK:
\`docs({ topic: 'auth-client' })\`). \`auth.signUp({ email, password,
displayName? })\` / \`auth.signIn({ email, password })\` return the user or throw
with the message. Gate pages on \`auth.getState().status\` (React:
\`useAuthState()\`) as the auth starter's \`src/App.tsx\` does. Sign-up signs the user
in with \`email_verified: false\`; unverified users can sign in and pass
\`auth: 'required'\`. \`sw.auth.requireUser(req)\` returns \`{ id, email,
role, email_verified, … }\` or throws 401 \`AUTH_REQUIRED\`;
\`sw.auth.fromRequest(req)\` returns it or \`null\`.

Functions: JSON endpoints use \`sw.endpoint({ auth, body, rateLimit, handler:
async ({ body, user, params }, sw) => value })\`; set \`auth\` (\`'required'\`,
\`'optional'\`, \`'none'\`) or deploy refuses it. Webhooks and streaming use a bare \`export default async
function (req, sw)\` returning a \`Response\`. Params: \`params.id\` there,
\`sw.params.id\` bare; \`somewhere typecheck\` types bare handlers too.

Data: declare tables in \`db/schema.ts\`; pages use \`somewhere:data\`
(\`data.notes.list()\`, \`.create()\`, \`.update(id, …)\`) without API files.
Use \`owner()\` for personal rows, \`group()\` for invited teams, \`appRole()\`
for app-wide roles, \`anyOf()\` for owner or a role, \`allOf()\` for members-only rows.
\`shared()\` gives signed-in reads and creator-only writes. \`client\` sets browser
columns; \`publicRead: { where }\` admits visitors. Public-profile enquiries use
\`client.intake\` (\`somewhere docs declared-data\`). Keep scopes and grants;
functions handle authorized exceptional writes and side effects. Validate
first: \`handle\` below is a public address its owner claimed:

\`\`\`ts
const { handle, title, from_email } = body as { handle?: unknown; title?: unknown; from_email?: unknown };
if (typeof handle !== 'string' || typeof title !== 'string' || typeof from_email !== 'string'
    || !title.trim() || title.length > 200 || /[\\r\\n]/.test(title)
    || from_email.length > 254 || !/^[^\\s@]+@[^\\s@]+\$/.test(from_email)) return Response.json({ error: 'bad input' }, { status: 400 });
const { data: [profile] } = await sw.db.server.from('profiles', { where: { handle }, limit: 1 });
if (!profile) return Response.json({ error: 'unknown handle' }, { status: 404 });
await sw.db.server.insert('entries', { user_id: profile.user_id, owner_email: profile.owner_email,
  title: title.trim(), from_email, created_ms: Date.now() });
\`\`\`

The owner comes from that lookup, never the body; the sender is not the
owner. Rate limits and the alert are in \`somewhere docs recipe-signed-in-app\`.
Use \`serverOnly()\` only when every operation needs a function's own access check.
Structured queries: \`sw.db.from\` / \`insert\` / \`update\` / \`remove\` return \`{ data: rows[], count,
changes }\`; \`where: { a: 1, b: { in: ids }, c: { gte: 2 }, d: null }\` (one
operator per column). Raw SQL uses a separate raw database, never managed tables.
For cross-user managed work, authorize the caller and use \`sw.db.server.from\` /
\`insert\` / \`update\` / \`remove\`; keep \`owner()\`/\`group()\`. Parallel reads: \`Promise.all\`.

Unique pair: \`unique: [['org_id','email']]\` in table options.

Test schedules now: \`somewhere cron run <id> --wait\`. Do not wait for it to fire.
`;

export const SKILLS_POINTER = `Skills: \`${SKILLS_DIR}/\` — `
  + skillNames(BUNDLED_SKILLS_PACK).map((name) => `\`${name}\``).join(', ')
  + '. Read the skill that matches the task. `somewhere skills status` inspects the installed pack; `somewhere skills update` updates unmodified files.';

export const INIT_AGENTS_MD = `# somewhere.cloud project contract\n${SKILLS_POINTER}\n${AGENT_WORKFLOW}\n`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
