import { BUNDLED_SKILLS_PACK } from './skills-pack.generated.js';
import { SKILLS_DIR, skillNames } from './skills-pack.js';

// Generated mirror of somewhere.cloud/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Build, deploy, test

If every access rule can be declared (owner, member, parent, public read), declare
it and use the generated browser client. If a rule cannot be declared (for example
it depends on an unverified email, or a role your app assigns), use serverOnly()
tables and check access in your own sw.endpoint functions.
Built-in groups and email-domain roles require VERIFIED email. For access before
verification, use your own membership/role table with server-side checks. Never
give a privileged role solely because an unverified address claims a domain.

Starter map:
- src/App.tsx + src/routes.ts: route selection, including a detail path parameter;
  navigate/linkTo accept string paths. Extensionless paths serve index.html.
- src/pages/HomePage.tsx: build here; src/pages/SignedInLayout.tsx: signed-in layout;
  src/ui/AppShell.tsx: account/sign-out; src/ui/layout.tsx: PageHeader (React-node title).
- src/auth/hooks.ts: existing useAuthState/useSignOut; src/services/auth.ts: errors.
  In components, useAuth from @somewhere-cloud/sdk/react exposes signIn/signUp
  ({ email, password }); both throw readable errors. Sign-up signs in immediately;
  unverified users pass auth: 'required'. Keep api/auth/[...path].ts and the session gate.
- src/config.ts: app name, SIGN_IN_PROVIDERS, SHOW_EMAIL_VERIFICATION.

Endpoint files: api/notes.ts → /api/notes; api/notes/[id].ts → params.id;
api/notes/[id]/sub.ts → /api/notes/:id/sub; underscore-prefixed files are helpers.
The global sw only declares endpoints; the handler's second argument is the runtime.
Method-named exports select GET/DELETE; default export handles POST with a body.
Declare auth on every endpoint; declare body fields before reading JSON. GET has no body.
Plain objects become JSON 200; return Response.json(value, { status }) for other statuses.

\`\`\`ts
export const GET = sw.endpoint({
  auth: 'required',
  handler: async ({ params }, sw) => sw.db.from('notes', { limit: 100 }),
});
export default sw.endpoint({
  auth: 'required', body: { title: 'string' },
  handler: async ({ body }, sw) => sw.db.insert('notes', { title: body.title }),
});
export const DELETE = sw.endpoint({
  auth: 'required',
  handler: async ({ params }, sw) => sw.db.remove('notes', { where: { id: params.id } }),
});
\`\`\`

Schema: db/schema.ts is declaration only: imports and a default schema export.
No helper functions, constants, spreads or arbitrary TypeScript expressions.
id() is a random text key; references use text(). owner() adds/fills user_id.

\`\`\`ts
import { schema, table, id, text, owner } from 'somewhere/db';
export default schema({
  notes: table({ id: id(), title: text() }, {
    scope: owner(),
    client: { read: ['id', 'title'], create: ['title'], update: ['title'], delete: true },
  }),
});
\`\`\`

Scopes:
- owner(): personal rows, caller ownership applied by the platform.
- member(): your membership table controls shared rows; parent(): inherit a related row's access.
- serverOnly(): functions authorize every read/write; no browser data access.
- publicRead: { where }: visitor reads of explicitly selected rows/columns.
client grants browser operations/columns; read must include the primary key.
Omitted browser write grants prevent direct writes; use endpoints for validation.

Server calls return { data: rows, count, changes }. sw.db applies caller scopes;
sw.db.server bypasses them, so authorize first and supply trusted ownership on insert.
update takes TWO arguments: table and { where, set }. Transactions take an ARRAY
of write intents, never a callback; pre-generate related IDs. No reads or result
references inside tx; a zero-match update does not abort it. Use unique constraints
for concurrent uniqueness, not a read-then-insert check.

\`\`\`ts
async function writeNotes(sw: SomewhereRuntimeContext, ownerId: string) {
  // ownerId must come from the caller or an authorized lookup, never unchecked input.
  const id = crypto.randomUUID();
  await sw.db.server.tx([
    { op: 'insert', table: 'notes', values: { id, user_id: ownerId, title: 'Hello' } },
    { op: 'update', table: 'notes', where: { id }, set: { title: 'Updated' } },
  ]);
  await sw.db.from('notes', { where: { id }, limit: 1 });
  await sw.db.insert('notes', { title: 'Hello' });
  await sw.db.update('notes', { where: { id }, set: { title: 'Updated' } });
  await sw.db.remove('notes', { where: { id } });
  // Server directory: authorize the caller before looking up another account.
  const { users: [user] } = await sw.auth.server.listUsers({ emails: ['person@example.com'] });
  return user; // undefined when no eligible account matches
}
\`\`\`

Browser data is generated from the schema. list returns at most 100 rows, no
order option: sort in the client or use a server endpoint for ordered queries.

\`\`\`ts
import { data } from 'somewhere:data';
async function readNotes() {
  const page = await data.notes.list({ limit: 100 });
  if (page.has_more && page.next) return data.notes.list({ limit: 100, after: page.next });
  return page;
}
\`\`\`

Call your API with fetch(path, { method: 'POST', credentials: 'same-origin',
headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) }).
The short-lived access cookie refreshes automatically; do not store tokens.
Scripts sending cookie-authenticated POST/PATCH/DELETE must send Origin equal to
the app URL. UI rendering/session checks are asynchronous: wait for loaded UI.
Test with throwaway users at <name>@<subdomain>.test.somewhere.site.

Publish: somewhere typecheck → somewhere deploy → somewhere test.
Deploy raw source; do not run a frontend build. Type errors stop before upload;
explicit override: somewhere deploy --allow-type-errors. Deploy applies the schema.
somewhere test runs project tests against production; also test each table's
access and the affected journey. Diagnose with somewhere errors and somewhere logs.
RATE_LIMIT_UNAVAILABLE is temporary platform unavailability: the request was not
admitted; retry it and keep rateLimit protection.

On demand:
- Membership/parent: \`somewhere docs sw.db --section owner-or-member-and-parent-access\`
- Groups: \`somewhere docs sw.groups --section share-data-with-a-group\`
- Transactions: \`somewhere docs sw.db --section transaction-intents\`
- Updates: \`somewhere docs sw.db --section update-shape\`
- Browser limits: \`somewhere docs sw.db --section browser-list-limits\`
- Direct HTTP data tests: \`somewhere docs declared-data --section calling-the-data-endpoint-directly\`
- Auth hooks: \`somewhere docs auth-client --section react-auth-state\`
- Files/background import: \`somewhere docs recipe-csv-import --section larger-files\`
- Server-rendered pages: \`somewhere docs recipe-seo --section 5-server-rendered-pages-and-redirects\`
`;

export const SKILLS_POINTER = `Skills: \`${SKILLS_DIR}/\` — `
  + skillNames(BUNDLED_SKILLS_PACK).map((name) => `\`${name}\``).join(', ')
  + '. Read the skill that matches the task. `somewhere skills status` inspects the installed pack; `somewhere skills update` updates unmodified files.';

export const DECLARED_ACCESS_POINTER = '';

/** One line telling agents the app's data and code can leave:
 *  an evaluating agent concluded the platform had no exits. Kept outside
 *  AGENT_WORKFLOW, which is a byte mirror of the platform's agent workflow. */
export const PORTABILITY_POINTER = 'Your data and code are yours: `somewhere pull` (source), `somewhere db dump` (raw SQL database as one .sql file), '
  + 'one-table CSV export and attaching PostgreSQL in your own Neon account; managed-database tables are not in the dump or CSV yet. '
  + 'Limits per path: `somewhere docs portability`.';

export const INIT_AGENTS_MD = `# somewhere.cloud project contract\n${SKILLS_POINTER}\n${DECLARED_ACCESS_POINTER}\n${PORTABILITY_POINTER}\n${AGENT_WORKFLOW}\n`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
