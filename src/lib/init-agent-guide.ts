import { SKILLS_DIR } from './skills-pack.js';

// Generated mirror of somewhere.cloud/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Build, deploy, test

Enough to start a typical app: declare access, use the generated browser client;
docs are for exceptions. Complete schema and calls below.

| Requirement | Declaration below |
| --- | --- |
| Each user sees only their own rows | notes: owner() |
| Team: owner adds members; members read/write; creator rights | teams/team_members/tasks: owner() + member(); role-owner delete branch |
| Owner/staff record with staff-only child notes | tickets: owner() or server-assigned appRole(); messages: parent(); staff_notes: appRole() |
| Public pages from private drafts | pages: conditional publicRead |
| Share one record read-only with another account | shared_notes/note_shares: read-only grant() |

db/schema.ts is declaration only: imports, constants/spreads, default schema;
no helpers/expressions. id() is random text; owner() stamps user_id. client.read
includes the key. Other fields: timestamp({ default: 'now' }), text({ nullable: true });
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
    client: { read: ['id', 'subject'], create: ['subject'], update: ['subject'] },
  }),
  messages: table({ id: id(), ticket_id: text({ references: 'tickets' }), body: text() }, {
    scope: parent({ via: 'ticket_id' }),
    client: { read: ['id', 'ticket_id', 'body'], create: ['ticket_id', 'body'] },
  }),
  staff_notes: table({ id: id(), ticket_id: text({ references: 'tickets' }), body: text() }, {
    scope: appRole({ roles: { read: ['staff'], create: ['staff'] } }),
    client: { read: ['id', 'ticket_id', 'body'], create: ['ticket_id', 'body'] },
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

messages use parent(): owner() would hide staff replies from the customer.
Use emailDomain for staff at your verified domain; assignedBy: 'server' when the
app decides (admin promotion, payment, invitation); never use an unverified email ending.
Publish pages in an owner-checked endpoint. Share with caller-scoped
sw.db.insert('note_shares', { grantee_id, note_id }); it checks row ownership.
Browser list: max 100, paginate after; no order (sort locally or in an endpoint).

\`\`\`ts
import { data } from 'somewhere:data';
async function notes(after?: string) {
  const { data: note } = await data.notes.create({ title: 'Hello' });
  if (note) await data.notes.update(note.id, { title: 'Updated' });
  return data.notes.list({ limit: 100, after }); // next page: after = previous.next
}
\`\`\`

Teams without verification: own membership table + member(); sw.groups and domain
roles need VERIFIED emails. Members read/create/update tasks; creators or team owners delete while members.
A restriction only narrows who may do its operations; it never grants read.
Comment-author-or-team-owner deletion stays a small endpoint.
Create the team and its owner membership atomically:

\`\`\`ts
// api/teams.ts
export default sw.endpoint({
  auth: 'required', body: { name: 'string' },
  handler: async ({ user, params, body }, sw) => {
    const creatorEmail = user.email; // required auth supplies id and email
    const id = crypto.randomUUID();
    await sw.db.server.tx([
      { op: 'insert', table: 'teams', values: { id, name: body.name, owner_id: user.id } },
      { op: 'insert', table: 'team_members', values: { id: crypto.randomUUID(), team_id: id, user_id: user.id, role: 'owner' } },
    ]);
    return { id, creatorEmail };
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
// api/_roles.ts — called by a server endpoint AFTER it authorizes the promotion
export async function assignStaff(userId: string, sw: SomewhereRuntimeContext) {
  await sw.auth.server.setRoles(userId, { add: ['staff'] });
}
\`\`\`

Do not mark app-read/write data serverOnly() and hand-write access checks: declare
who may read/write it; the platform enforces it. Server-only fits job/import/audit/
counter state, membership ledgers, and undeclarable rules: arbitrary predicates
(e.g. expiry), or different writable fields per role (split tables or check that write).
Grant ledgers need owner() scope and no browser writes. Keep other access declared.

Starter: src/pages/HomePage.tsx; routes src/App.tsx + src/routes.ts; auth hooks
src/auth/hooks.ts. useAuth from @somewhere-cloud/sdk/react: signIn/signUp({ email,
password }); sign-up signs in. Keep api/auth/[...path].ts; src/config.ts controls providers.
api/notes/[id]/sub.ts → /api/notes/:id/sub (params.id); underscore files are helpers.
POST: default export; GET/DELETE: named exports. Objects return JSON 200;
Response.json sets status.

\`\`\`ts
export const GET = sw.endpoint({
  auth: 'required',
  handler: async (_, sw) => sw.db.from('notes', { limit: 100 }),
});
export const DELETE = sw.endpoint({
  auth: 'required',
  handler: async ({ params }, sw) => sw.db.remove('notes', { where: { id: params.id } }),
});
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

Publish: somewhere typecheck → npx @somewhere-cloud/cli deploy → somewhere verify → somewhere test.
Deploy raw source, no frontend build. Type errors stop upload; override: somewhere deploy --allow-type-errors.
Tests: newUser() gives its own signed-in browser page and API request client; call N times (owner, member, outsider).
No chosen email argument: grant roles or insert memberships in setup through your app's authorized server endpoint.
Diagnose with somewhere errors and somewhere logs.

On demand:
- Server paging: \`somewhere docs sw.db --section server-read-paging\`
- Direct HTTP data tests: \`somewhere docs declared-data --section calling-the-data-endpoint-directly\`
`;

export const SKILLS_POINTER = `Task-specific skills: \`${SKILLS_DIR}/\`. Inspect/update with somewhere skills status/update.`;

export const DECLARED_ACCESS_POINTER = '';

/** One line telling agents the app's data and code can leave:
 *  an evaluating agent concluded the platform had no exits. Kept outside
 *  AGENT_WORKFLOW, which is a byte mirror of the platform's agent workflow. */
export const PORTABILITY_POINTER = 'Data/code export limits: `somewhere docs portability`.';

export const INIT_AGENTS_MD = `# somewhere.cloud project contract\n${AGENT_WORKFLOW}\n${SKILLS_POINTER}\n${PORTABILITY_POINTER}\n`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
