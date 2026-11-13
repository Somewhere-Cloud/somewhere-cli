import { SKILLS_DIR } from './skills-pack.js';

// Generated mirror of somewhere.cloud/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Build, deploy, test

This core is enough to start a typical app: write the schema, endpoint and browser
call below; use docs for exceptions. Declare access rules and use the generated
browser client for normal reads/writes. Start with owner() for personal rows.

Schema: db/schema.ts is declaration only; imports, named declarative constants,
spreads of those constants and the default schema export. No helper functions or
arbitrary expressions. id() is a random text key; references use text().
owner() fills user_id (or its named column). client.read includes the key.
Columns: timestamp({ default: 'now' }), text({ nullable: true }); indexes: [['team_id']].

\`\`\`ts
import { schema, table, id, text, owner, member, anyOf, serverOnly } from 'somewhere/db';
export default schema({
  notes: table({ id: id(), title: text() }, {
    scope: owner(),
    client: { read: ['id', 'title'], create: ['title'], update: ['title'], delete: true },
  }),
  teams: table({ id: id(), name: text(), owner_id: text() }, {
    scope: member({ group: 'id', membership: 'team_members', member_user: 'user_id', member_group: 'team_id' }),
    client: { read: ['id', 'name'] },
  }),
  team_members: table({ id: id(), team_id: text(), user_id: text() }, {
    scope: serverOnly(), unique: [['team_id', 'user_id']],
  }),
  tasks: table({ id: id(), team_id: text({ references: 'teams' }), title: text() }, {
    scope: anyOf(owner(), member({ group: 'team_id', membership: 'team_members',
      member_user: 'user_id', member_group: 'team_id', operations: ['read', 'create', 'update'] })),
    client: { read: ['id', 'team_id', 'title'], create: ['team_id', 'title'], update: ['title'], delete: true },
  }),
});
\`\`\`

Browser data is generated from db/schema.ts. list: max 100 rows, after cursor,
no order option; sort in the browser or use a server endpoint for ordering.

\`\`\`ts
import { data } from 'somewhere:data';
async function notes() {
  const { data: note } = await data.notes.create({ title: 'Hello' });
  if (note) await data.notes.update(note.id, { title: 'Updated' });
  const page = await data.notes.list({ limit: 100 });
  return page.has_more && page.next ? data.notes.list({ after: page.next }) : page;
}
\`\`\`

Teams WITHOUT email verification: use your own membership table with member(),
as above. Built-in sw.groups and email-domain roles need VERIFIED emails;
member() over your own table does not. Never let browsers write memberships.
Here members read/create/update tasks; only each task's creator deletes it while
still a member. A team-owner delete can be one checked server operation; keep the
other operations declared. Team creation must atomically seed its owner's membership:

\`\`\`ts
// api/teams.ts
export default sw.endpoint({
  auth: 'required', body: { name: 'string' },
  handler: async ({ user, body }, sw) => {
    const id = crypto.randomUUID();
    await sw.db.server.tx([
      { op: 'insert', table: 'teams', values: { id, name: body.name, owner_id: user.id } },
      { op: 'insert', table: 'team_members', values: { id: crypto.randomUUID(), team_id: id, user_id: user.id } },
    ]);
    return { id };
  },
});
\`\`\`

\`\`\`ts
// api/teams/[id]/members.ts — only the team owner adds a member
export default sw.endpoint({
  auth: 'required', body: { email: 'string' },
  handler: async ({ user, params, body }, sw) => {
    const { data: teams } = await sw.db.from('teams', { where: { id: params.id, owner_id: user.id }, limit: 1 });
    if (!teams[0]) return Response.json({ error: 'Team owner required' }, { status: 403 });
    const { users: [target] } = await sw.auth.server.listUsers({ emails: [body.email] });
    if (!target) return Response.json({ error: 'Account not found' }, { status: 404 });
    await sw.db.server.insert('team_members', {
      id: crypto.randomUUID(), team_id: params.id, user_id: target.id,
    }, { onConflict: 'ignore' });
    return { ok: true };
  },
});
\`\`\`

Scopes: owner() personal rows; member() membership-table rows; parent({ table,
via }) inherits a related row's access; publicRead: { where } exposes selected
rows/columns. serverOnly() is the fallback when a required identity/relationship
cannot be declared, not a reason to move every table behind endpoints. Keep
supported rules declared; check only the exceptional operation in an endpoint.

Starter: build src/pages/HomePage.tsx; src/App.tsx + src/routes.ts select routes
and params (navigate/linkTo accept string paths); SignedInLayout.tsx is in pages/;
src/ui/AppShell.tsx has sign-out; src/ui/layout.tsx has PageHeader (React-node title).
src/auth/hooks.ts has useAuthState/useSignOut. useAuth from @somewhere-cloud/sdk/react
has signIn/signUp({ email, password }); both throw readable errors. Sign-up signs
in immediately; auth: 'required' accepts unverified users. Keep api/auth/[...path].ts.
src/config.ts controls SIGN_IN_PROVIDERS and SHOW_EMAIL_VERIFICATION.

Endpoint files: api/notes.ts → /api/notes; api/notes/[id].ts → params.id;
api/notes/[id]/sub.ts → /api/notes/:id/sub; underscore-prefixed files are helpers.
GET/DELETE use method-named exports; POST with JSON uses default export.
The handler receives { user, params, body, request }; its second argument is the
runtime (the global sw only declares endpoints). auth: 'required' supplies user.id
and user.email (string). Declare auth and JSON body fields.
Plain objects become JSON 200; return Response.json(value, { status }) otherwise.

\`\`\`ts
export const GET = sw.endpoint({
  auth: 'required',
  handler: async ({ user, params }, sw) => sw.db.from('notes', { limit: 100 }),
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

Server sw.db applies caller scopes; sw.db.server bypasses them: authorize first.
Reads: from(table, { where, columns, order: [['id', 'asc']], limit, offset }).
Filters include { id: { in: ids } }; schema uniqueness is unique: [['a', 'b']].
Writes: insert(table, values), update(table, { where, set }), remove(table, { where }).
Transactions are ARRAYs of write intents (above), never callbacks; pre-generate
related IDs.
Server user-by-email lookup is listUsers({ emails }) (above), not member-contacts.

Call endpoints with fetch(path, { method: 'POST', credentials: 'same-origin',
headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) }).
The short access cookie refreshes automatically; do not store tokens. Cookie-auth
POST/PATCH/DELETE from scripts need Origin equal to the app URL.

Publish: somewhere typecheck → somewhere deploy → somewhere test.
Deploy raw source, no frontend build. Type errors stop before upload; explicit
override: somewhere deploy --allow-type-errors. Test the affected journey and access.
RATE_LIMIT_UNAVAILABLE: temporary platform condition; request not admitted; retry,
keep rateLimit. Diagnose with somewhere errors and somewhere logs.

On demand:
- Membership/parent: \`somewhere docs sw.db --section owner-or-member-and-parent-access\`
- Verified-email groups: \`somewhere docs sw.groups --section create-a-group\`
- Transactions: \`somewhere docs sw.db --section transaction-intents\`
- Updates: \`somewhere docs sw.db --section update-shape\`
- Server paging: \`somewhere docs sw.db --section server-read-paging\`
- Browser limits: \`somewhere docs sw.db --section browser-list-limits\`
- Direct HTTP data tests: \`somewhere docs declared-data --section calling-the-data-endpoint-directly\`
- Auth hooks: \`somewhere docs auth-client --section react-auth-state\`
- Endpoint options: \`somewhere docs sw.endpoint --section what-your-handler-receives\`
- Schedules: \`somewhere docs cron --section create-a-schedule\`
- Server rendering: \`somewhere docs recipe-seo --section 5-server-rendered-pages-and-redirects\`
`;

export const SKILLS_POINTER = `Task-specific skills: \`${SKILLS_DIR}/\`. Inspect/update with somewhere skills status/update.`;

export const DECLARED_ACCESS_POINTER = '';

/** One line telling agents the app's data and code can leave:
 *  an evaluating agent concluded the platform had no exits. Kept outside
 *  AGENT_WORKFLOW, which is a byte mirror of the platform's agent workflow. */
export const PORTABILITY_POINTER = 'Data/code export limits: `somewhere docs portability`.';

export const INIT_AGENTS_MD = `# somewhere.cloud project contract\n${AGENT_WORKFLOW}\n${SKILLS_POINTER}\n${PORTABILITY_POINTER}\n`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
