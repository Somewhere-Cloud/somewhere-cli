import { BUNDLED_SKILLS_PACK } from './skills-pack.generated.js';
import { SKILLS_DIR, skillNames } from './skills-pack.js';

// Generated mirror of somewhere.cloud/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Getting started — build, deploy, verify

\`somewhere init --name <slug>\` writes React + TypeScript. Signed out: local only;
signed in: also creates and links a project.
Default: sign-in UI; minimal: SDK/auth route; bare: neither. \`init --catalog --json\`: modules.
\`npx @somewhere-cloud/cli deploy\` publishes raw source: signed out, a temporary URL, claim URL
and expiry; linked, your account project. On a hosted VM, \`somewhere login\` uses browser approval and keeps you signed in.
Account operations, test inbox and cron need login.
Core API shapes below cover a typical app; read deeper topics when needed.

After edits: \`somewhere typecheck\` and focused local/browser tests. Publish:
1. \`somewhere deploy\` (do not build first). Deploy
   checks compilation, schema and secrets; \`somewhere deploy-check\` runs them without publishing
   (diagnosis, review, \`--run /api/x\`).
2. Run \`somewhere verify\` on the final journey (\`--flow flow.json\`); rerun after fixes. Sign test users up
   in-app at \`*.test.somewhere.site\`; more: \`actors\` + \`journey\` (\`somewhere docs browser\`).
3. Inspect: \`somewhere browser\`; diagnose: \`somewhere logs --tail 10\`, \`somewhere errors\`.
4. Test mail: \`somewhere email test-inbox <addr>\` includes \`verification_code\`.
   Don't retest sign-in or \`sw.db.from\` scoping; test each table's scope, auth before \`sw.db.server\`/raw SQL, bad input and journeys.

Routes: \`index.html\` loads \`src/main.tsx\`; unmatched extensionless paths
(\`/signin\`) serve it. Route the app by \`location.pathname\`.
\`api/notes/[id].ts\` is \`/api/notes/:id\`; \`_\`-prefixed names are import-only
helpers. Avoid names differing only in case.

With auth enabled, \`api/auth/[...path].ts\` is
\`export { somewhereAuth as default } from '@somewhere-cloud/sdk/server'\`; pages
use \`createSomewhereAuth()\` from \`@somewhere-cloud/sdk/auth\` (client and React hooks:
\`somewhere docs auth-client --section react-auth-state\`). \`auth.signUp({ email, password,
displayName? })\` / \`auth.signIn({ email, password })\` return the user or throw
with the message. Gate on \`auth.getState().status\` (React: \`useAuthState()\`). Sign-up sets \`email_verified: false\`; unverified users pass
\`auth: 'required'\`. \`sw.auth.requireUser(req)\` returns \`{ id, email,
role, email_verified, … }\` or throws 401 \`AUTH_REQUIRED\`;
\`sw.auth.fromRequest(req)\` returns it or \`null\`.

Functions: JSON endpoints use \`sw.endpoint({ auth, body, rateLimit, handler:
async ({ body, user, params }, sw) => value })\`; set \`auth\` (\`'required'\`,
\`'optional'\`, \`'none'\`) or deploy refuses it. Webhooks and streaming use a bare \`export default async
function (req: Request, sw: SomewhereRuntimeContext)\` returning a \`Response\`.
Params: \`params.id\` there, \`sw.params.id\` bare.

Data: \`id()\` is a random text key on new tables (reference with \`text()\`); integer-id tables keep integers. The starter's \`id({ uuid: false })\` is deliberate.
Declare tables in \`db/schema.ts\`; pages use \`somewhere:data\`
(\`data.notes.list()\`, \`.create()\`, \`.update(id, …)\`) without API files.
Use \`owner()\` for personal rows, \`group()\` for invited teams, \`appRole()\`
for app-wide roles, \`anyOf()\` for owner or a role, \`allOf()\` for members-only rows.
Sharing your own rows with specific people: \`anyOf(owner(), grant())\`
(\`somewhere docs declared-data --section per-owner-sharing\`).
Booking/help desk: \`somewhere docs sw.db --section provider-or-booker-and-owner-or-staff-recipes\`.
Keep fitting scopes when an exceptional write needs \`sw.db.server.tx\`.
\`shared()\` gives signed-in reads and creator-only writes. \`client\` sets browser
columns; \`publicRead: { where }\` admits visitors. Public-profile enquiries use
\`client.intake\` (\`somewhere docs declared-data\`). Keep scopes and grants;
functions handle authorized exceptional writes and side effects. Declare the
body schema (a missing or mistyped field is a 400); \`handle\` below is a
public address its owner claimed:


Use the looked-up owner, never the body. Rate limits/alerts: \`recipe-signed-in-app\`.
Use \`serverOnly()\` only when every operation needs a function's own access check.
Structured queries: \`sw.db.from\` / \`insert\` / \`update\` / \`remove\` return \`{ data: rows[], count,
changes }\`; \`where: { a: 1, b: { in: ids }, c: { gte: 2 }, d: null }\` (one
operator per column). Raw SQL uses a separate raw database, never managed tables.
For cross-user managed work, authorize the caller and use \`sw.db.server.from\` /
\`insert\` / \`update\` / \`remove\`; keep \`owner()\`/\`group()\`. Parallel reads: \`Promise.all\`.

Core contract:
- Schema is declaration only: imports and one default schema({...}) export. No
  helper functions, loops, computed expressions or arbitrary TypeScript.
- owner(): personal rows; group()/parent membership: invited teams and their children.
- serverOnly(): every operation goes through a function with its own authorization.
- publicRead: { where }: visitor reads of explicitly selected rows; client.read includes the primary key.
- Built-in groups and email-domain app roles require VERIFIED email. For apps
  that must work before verification, declare a membership/role table and check
  it on the server before privileged operations.
- Browser somewhere:data is generated from db/schema.ts. list reads at most 100
  rows: { limit: 100, after: cursor }. No order option: sort in the client or use
  a server endpoint. Cursor and row shapes come from the generated declaration.
- Existing browser hooks live in src/auth; routes in src/App.tsx; layouts in
  src/layouts. Extend them rather than replacing working authentication.

\`\`\`ts
export default sw.endpoint({
  auth: 'required',
  handler: async ({ user }, sw) => {
    const { users } = await sw.auth.server.listUsers({ emails: [user.email] });
    return { users };
  },
});
\`\`\`
GET endpoints export the endpoint as GET (export const GET = sw.endpoint({...})).
Server database shapes (authorize cross-user operations before using server):
\`\`\`ts
async function writes(sw: SomewhereRuntimeContext) {
  const id = crypto.randomUUID(); // generate related IDs before the transaction
  await sw.db.server.tx([
    { op: 'insert', table: 'greetings', values: { id, message: 'Hello' } },
    { op: 'update', table: 'greetings', where: { id }, set: { message: 'Updated' } },
  ]);
  await sw.db.server.from('greetings', { where: { id }, limit: 1 });
  await sw.db.server.insert('greetings', { id: crypto.randomUUID(), message: 'Hello' });
  await sw.db.server.update('greetings', { where: { id }, set: { message: 'Updated' } });
  await sw.db.server.remove('greetings', { where: { id } });
}
\`\`\`
The same from/insert/update/remove verbs on sw.db apply caller scopes.
Transactions take an ARRAY of write intents, never a callback.
Transactions: \`somewhere docs sw.db --section swdbservertxintents-authorized-cross-user-writes\`.
Updates: \`somewhere docs sw.db --section builder-verbs-and-where-shapes\`.
Membership: \`somewhere docs sw.db --section owner-or-member-and-parent-access\`.
Auth hooks: \`somewhere docs auth-client --section react-auth-state\`.

Unique pair: \`unique: [['org_id','email']]\` in table options.

Test schedules now: \`somewhere cron run <id> --wait\`. Do not wait for it to fire.
`;

export const SKILLS_POINTER = `Skills: \`${SKILLS_DIR}/\` — `
  + skillNames(BUNDLED_SKILLS_PACK).map((name) => `\`${name}\``).join(', ')
  + '. Read the skill that matches the task. `somewhere skills status` inspects the installed pack; `somewhere skills update` updates unmodified files.';

/** One line pointing agents at the declared-access recipes: in
 *  the testing lane's experiment all three agents given it moved from
 *  serverOnly() plus hand-written checks to declared access. Kept outside
 *  AGENT_WORKFLOW, which is a byte mirror of the platform's agent workflow. */
export const DECLARED_ACCESS_POINTER = 'Access rules: before choosing `serverOnly()` plus hand-written checks, read the declared-access recipes: '
  + 'teams, creator-or-owner and parent rows in `somewhere docs sw.db --section owner-or-member-and-parent-access`; '
  + 'bookings and help desks in `somewhere docs sw.db --section provider-or-booker-and-owner-or-staff-recipes`; '
  + 'sharing your own rows with specific people (read-only sharing, co-authors) in `somewhere docs declared-data --section per-owner-sharing`.';

/** One line telling agents the app's data and code can leave:
 *  an evaluating agent concluded the platform had no exits. Kept outside
 *  AGENT_WORKFLOW, which is a byte mirror of the platform's agent workflow. */
export const PORTABILITY_POINTER = 'Your data and code are yours: `somewhere pull` (source), `somewhere db dump` (raw SQL database as one .sql file), '
  + 'one-table CSV export and attaching PostgreSQL in your own Neon account; managed-database tables are not in the dump or CSV yet. '
  + 'Limits per path: `somewhere docs portability`.';

export const INIT_AGENTS_MD = `# somewhere.cloud project contract\n${SKILLS_POINTER}\n${DECLARED_ACCESS_POINTER}\n${PORTABILITY_POINTER}\n${AGENT_WORKFLOW}\n`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
