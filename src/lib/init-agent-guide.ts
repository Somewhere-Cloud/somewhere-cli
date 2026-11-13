import { SKILLS_DIR } from './skills-pack.js';

// Generated mirror of somewhere.cloud/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Build, deploy, test

Enough to start a typical app: declare access and use the browser client; docs are for exceptions.

| Requirement | Declaration below |
| --- | --- |
| Each user sees only their own rows | notes: owner() |
| Team: owner adds members; members read/write; creator rights | teams/team_members/tasks: owner() + member(); role-owner delete branch |
| Owner/staff record with staff-only child notes | tickets: owner() or appRole(); parent() thread; staff-only notes; POST setup below |
| Public pages from private drafts | pages: conditional publicRead |
| Share one record read-only | shared_notes/note_shares: read-only grant() |

db/schema.ts is declaration only: imports, constants/spreads, default schema;
no helpers/expressions. id() is random text; owner() stamps user_id. client.read
includes the key. Inside anyOf(), owner() takes only column/read: it stamps the
creator, not create/delete options; member() gates placement (non-member create is
refused), while creators or the allowed branch can delete. Other fields: timestamp({ default: 'now' }), text({ nullable: true });
indexes: [['team_id']].

\`\`\`ts
import { schema, table, id, text, owner, member, anyOf, serverOnly, parent, appRole, boolean, grant } from 'somewhere/db';
export default schema({
  notes: table({ id: id(), title: text() }, { scope: owner(), client: { read: ['id', 'title'], create: ['title'], update: ['title'], delete: true },
  }),
  teams: table({ id: id(), name: text(), owner_id: text() }, {
    scope: member({ group: 'id', membership: 'team_members', member_user: 'user_id', member_group: 'team_id' }),
    client: { read: ['id', 'name'] },
  }),
  team_members: table({ id: id(), team_id: text(), user_id: text(), role: text() }, {
    scope: serverOnly(), unique: [['team_id', 'user_id']],
  }),
  tasks: table({ id: id(), team_id: text({ references: 'teams' }), title: text() }, {
    scope: anyOf(owner(), member({ group: 'team_id', membership: 'team_members',
      member_user: 'user_id', member_group: 'team_id', operations: ['read', 'create', 'update'] }),
      member({ group: 'team_id', membership: 'team_members', member_user: 'user_id',
        member_group: 'team_id', where: { role: 'owner' }, operations: ['delete'] })),
    client: { read: ['id', 'team_id', 'title'], create: ['team_id', 'title'], update: ['title'], delete: true },
  }),
  tickets: table({ id: id(), subject: text() }, {
    scope: anyOf(owner(), appRole({ roles: { read: ['staff'], create: ['staff'], update: ['staff'] } })),
    client: { read: true, create: ['subject'], update: ['subject'] },
  }),
  messages: table({ id: id(), ticket_id: text({ references: 'tickets' }), body: text() }, {
    scope: parent({ via: 'ticket_id' }),
    client: { read: true, create: ['ticket_id', 'body'] },
  }),
  staff_notes: table({ id: id(), ticket_id: text({ references: 'tickets' }), body: text() }, {
    scope: appRole({ roles: { read: ['staff'], create: ['staff'] } }),
    client: { read: true, create: ['ticket_id', 'body'] },
  }),
  pages: table({ id: id(), title: text(), published: boolean({ default: false }) }, {
    scope: owner(), client: { read: ['id', 'title'], create: ['title'], update: ['title'],
      publicRead: { where: { published: true } } },
  }),
  note_shares: table({ id: id(), grantee_id: text(), note_id: text({ references: 'shared_notes', onDelete: 'cascade' }) }, {
    scope: owner(), unique: [['note_id', 'grantee_id']],
  }),
  shared_notes: table({ id: id(), title: text() }, {
    scope: anyOf(owner(), grant({ table: 'note_shares', grantee: 'grantee_id', row: 'note_id', operations: ['read'] })),
    client: { read: ['id', 'title'], create: ['title'], update: ['title'] },
  }),
}, { appRoles: { staff: { assignedBy: 'server' } } });
\`\`\`

POST role setup once after sign-up/profile completion, not GET/every request:
cookie-authenticated GET cannot mutate roles.
Check admin here, or your own assignment rule.
messages use parent(): owner() would hide staff replies from the customer.
Use emailDomain for staff at your verified domain; assignedBy: 'server' when the
app decides (promotion, payment, invitation). An email ending proves identity only
when verified; assigning a role anyway is your app's decision, whose permissions the platform enforces.
Publish pages in an owner-checked endpoint. Share with caller-scoped
sw.db.insert('note_shares', { grantee_id, note_id }); it checks row ownership.
Browser calls THROW, not { error }; catch below.
Browser list: max 100, paginate after; no order (sort locally or in an endpoint).

\`\`\`ts
import { data } from 'somewhere:data';
export async function save(title: string) {
  try { await data.notes.create({ title }); return null; }
  catch (e) { return e instanceof Error ? e.message : 'Save failed'; }
}
export const list = (after?: string) => data.notes.list({ limit: 100, after });
\`\`\`

Teams without verification: own membership table + member(); sw.groups and domain
roles need VERIFIED emails. Members read/create/update tasks; creators or team owners delete while members.
Restrictions narrow operations, not grant read.
Comment-author-or-team-owner deletion stays a small endpoint.
Create the team and its owner membership atomically:

\`\`\`ts
// api/teams.ts
export default sw.endpoint({
  auth: 'required', body: { name: 'string' },
  handler: async ({ user, params, body }, sw) => {
    const id = crypto.randomUUID();
    await sw.db.server.tx([
      { op: 'insert', table: 'teams', values: { id, name: body.name, owner_id: user.id } },
      { op: 'insert', table: 'team_members', values: { id: crypto.randomUUID(), team_id: id, user_id: user.id, role: 'owner' } },
    ]);
    return { id, email: user.email };
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
      id: crypto.randomUUID(), team_id: params.id, user_id: target.id, role: 'member',
    }, { onConflict: 'ignore' });
    return { ok: true };
  },
});
\`\`\`

\`\`\`ts
// api/complete-profile.ts — POST once when an admin assigns staff after sign-up
export default sw.endpoint({
  auth: 'required', body: { userId: 'string' },
  handler: async ({ request, body }, sw) => {
    await sw.auth.requireUser(request, { role: 'admin' });
    await sw.auth.server.setRoles(body.userId, { add: ['staff'] });
    return { ok: true };
  },
});
\`\`\`

Do not hand-write access to app-read/write data: declare who may read/write it.
serverOnly() fits job/import/audit/counter state and protected membership ledgers.
Grant ledgers use owner() without browser writes. Undeclarable: arbitrary predicates
(e.g. expiry) or per-role writable fields (split tables or check that write).

Build src/pages/HomePage.tsx; routes src/App.tsx + src/routes.ts; auth src/auth/hooks.ts.
Auth is wired: keep api/auth/[...path].ts; src/config.ts controls providers.
api/notes/[id]/sub.ts → params.id; underscore files are helpers. POST: default export;
GET/DELETE: named exports.

\`\`\`ts
export const GET = sw.endpoint({ auth: 'required', handler: async (_, sw) => sw.db.from('notes', { limit: 100 }) });
\`\`\`

sw.db applies caller scopes; sw.db.server bypasses them: authorize first.
Reads: from(table, { where, columns, order: [['id', 'asc']], limit, offset }).
Filter: { id: { in: ids } }; unique: [['a', 'b']] in schema.
Writes: insert(table, values), update(table, { where, set }), remove(table, { where }).
tx takes an ARRAY of write intents, never a callback; pre-generate related IDs.

Browser: fetch(path, { method: 'POST', credentials: 'same-origin',
headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) }).
Access cookies refresh automatically. Cookie-auth POST/PATCH/DELETE from scripts
need Origin equal to the app URL.

Publish: npx @somewhere-cloud/cli deploy, then somewhere test for the rules you changed.
One somewhere test run drives the UI and calls the API: signUp(page) uses your sign-up form
(then signOut, signIn with its password, verify with the emailed code), newUser() acts as
several people, and ready(page, 'signed-in' | 'signed-out') waits for the session check.
You do not need a separate browser script.
Deploy raw source, no frontend build; type errors stop upload.
newUser() gives a signed-in page/API client; call N times (owner, member, outsider).
No chosen email argument: assign roles/memberships through your app's authorized POST setup.
Test users are verified and visible to this project's server user lookup.
Email-domain role: signUp(page, { domain: 'staff.example' }), then verify(page, person).
For the complete owner-adds-member-by-email test and its endpoints, run
somewhere docs test and follow Two users sharing through the app.
Diagnose with somewhere errors and somewhere logs.

On demand:
- Server paging: \`somewhere docs sw.db --section server-read-paging\`

## Testing shared access

With the teams and membership endpoints above, the owner adds a fixture by email
and that fixture reads the shared team row:

\`\`\`ts
// tests/team.spec.ts
import { test, expect, data } from '@somewhere-cloud/cli/testing';
test('owner adds a second user by email', async ({ newUser }) => {
  const owner = await newUser();
  const bob = await newUser();
  const name = \`Shared team \${crypto.randomUUID()}\`;
  const created = await owner.request.post('/api/teams', { data: { name } });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  const added = await owner.request.post(\`/api/teams/\${id}/members\`, { data: { email: bob.email } });
  expect(added.ok()).toBeTruthy();
  const response = await data(bob.request, 'teams', { operation: 'get', id });
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).data).toMatchObject({ id, name });
});
\`\`\`
`;

export const SKILLS_POINTER = `Task-specific skills: \`${SKILLS_DIR}/\`. Inspect/update with somewhere skills status/update.`;

export const DECLARED_ACCESS_POINTER = '';

/** One line telling agents the app's data and code can leave:
 *  an evaluating agent concluded the platform had no exits. Kept outside
 *  AGENT_WORKFLOW, which is a byte mirror of the platform's agent workflow. */
export const PORTABILITY_POINTER = 'Data/code export limits: `somewhere docs portability`.';

/** One line: using the app from Claude as its signed-in user (MCP tools). */
export const MCP_POINTER = 'Use this app from Claude as its signed-in user (MCP tools): `somewhere docs sw.endpoint --section mcp-tools-for-claude`.';

export const INIT_AGENTS_MD = `# somewhere.cloud project contract\n${AGENT_WORKFLOW}\n${SKILLS_POINTER}\n${PORTABILITY_POINTER}\n${MCP_POINTER}\n`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
