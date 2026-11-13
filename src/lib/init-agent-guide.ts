import { SKILLS_DIR } from './skills-pack.js';

// Generated mirror of somewhere.cloud/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Build, deploy, test

This core is enough to start a typical app. Start coding here; docs are for
exceptions. Declare access rules; use the generated browser client for normal
reads/writes. Start with owner() for personal rows.

Schema: db/schema.ts accepts imports, named declarative constants/spreads and a
default schema export; no helpers or arbitrary expressions. id() is a random
text key; references use text(). owner() fills user_id (or its named column).
client.read includes the key. Columns: timestamp({ default: 'now' }),
text({ nullable: true }); indexes: [['team_id']].

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
Members read/create/update tasks; creators delete their own while still members.
Keep a team-owner delete as one checked endpoint; other access stays declared. Team creation must atomically seed its owner's membership:

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

Scopes: owner() private rows; member() team rows;
parent({ table: 'tickets', via: 'ticket_id' }) gives messages their ticket's access;
client.publicRead: { where } exposes selected rows/columns.

Do not mark data people read or change in your app serverOnly() and hand-write
access checks. Declare who may read/write it; the platform enforces it. Exceptions:
- Server-only job state, import staging, audit records and counters.
- Membership/grant ledgers, never browser-written; grant() requires owner() scope.
- Arbitrary predicates (e.g. access until expiry): check in an endpoint.
- Different writable fields per role on one table: split tables or check that write.
Keep other operations declared; do not infer staff from an unverified suffix.

Starter: build src/pages/HomePage.tsx. Routes: src/App.tsx + src/routes.ts
(string navigate/linkTo); layout: src/pages/SignedInLayout.tsx; sign-out:
src/ui/AppShell.tsx; PageHeader: src/ui/layout.tsx.
src/auth/hooks.ts: useAuthState/useSignOut. @somewhere-cloud/sdk/react useAuth: signIn/signUp({ email,
password }), readable thrown errors; sign-up signs in immediately. Required auth
accepts unverified users. Keep api/auth/[...path].ts. src/config.ts controls
SIGN_IN_PROVIDERS and SHOW_EMAIL_VERIFICATION.

Endpoint files: api/notes.ts → /api/notes; api/notes/[id].ts → params.id;
api/notes/[id]/sub.ts → /api/notes/:id/sub; underscore-prefixed files are helpers.
GET/DELETE use method-named exports; POST with JSON uses default export.
The handler gets { user, params, body, request } plus its sw runtime; global sw
only declares endpoints. Required auth gives user.id and user.email (string).
Declare JSON body fields. Objects return JSON 200; Response.json sets other statuses.

\`\`\`ts
export const GET = sw.endpoint({
  auth: 'required',
  handler: async ({ user, params }, sw) => sw.db.from('notes', { limit: 100 }),
});
export const DELETE = sw.endpoint({
  auth: 'required',
  handler: async ({ params }, sw) => sw.db.remove('notes', { where: { id: params.id } }),
});
\`\`\`

Structured sw.db calls apply caller scopes; sw.db.server bypasses them: authorize first.
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

Publish: somewhere typecheck → npx @somewhere-cloud/cli deploy → somewhere verify → somewhere test.
Deploy raw source, no frontend build. Type errors stop before upload; explicit
override: somewhere deploy --allow-type-errors. Tests: newUser() gives a signed-in page/request; call twice for access tests.
Diagnose with somewhere errors and somewhere logs.

On demand:
- Membership/parent: \`somewhere docs sw.db --section owner-or-member-and-parent-access\`
- Groups/roles: \`somewhere docs sw.groups --section app-wide-roles\`
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
