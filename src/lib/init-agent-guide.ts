import { SKILLS_DIR } from './skills-pack.js';

// Generated mirror of somewhere.cloud/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Build, deploy, test

This core holds the call shapes and access patterns for a typical app; docs are for
exceptions. Declare access and use the generated browser client. Pick your shape:

| Requirement | Declaration below |
| --- | --- |
| Each user sees only their own rows | notes: owner() |
| Team: owner adds members; members read/write; per-row creator rights | teams/team_members/tasks: member() + owner() |
| Owner and staff see a record; staff-only child notes | tickets: owner() or appRole(); messages: parent(); staff_notes: appRole() |
| Public pages from private drafts | pages: owner(), publicRead with published condition |
| Share one record read-only with another account | shared_notes + note_shares: owner() or read-only grant() |

db/schema.ts: declarations only (imports, constants/spreads, default schema); no
helpers/expressions. id() is random text; owner() stamps user_id. Include the key in
client.read. Also: timestamp({ default: 'now' }), text({ nullable: true }), indexes: [['team_id']].

\`\`\`ts
import { schema, table, id, text, owner, member, anyOf, serverOnly, parent, appRole, boolean, grant } from 'somewhere/db';
export default schema({
  notes: table({ id: id(), title: text() }, { scope: owner(), client: { read: ['id', 'title'], create: ['title'], update: ['title'], delete: true },
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
}, { appRoles: { staff: { emailDomain: 'staff.example.com' } } });
\`\`\`

messages inherit ticket access: owner() would hide a staff reply from the customer.
Staff roles here require verified domain email; never infer roles from unverified email.
Publish pages through an owner-checked endpoint setting published; not a browser write.
Share through an endpoint using caller-scoped sw.db.insert('note_shares', { grantee_id,
note_id }); the declaration checks ownership. Never grant browser writes to ledgers.

Browser data comes from the schema. list: max 100, after cursor, no order; sort
in the browser or an endpoint.

\`\`\`ts
import { data } from 'somewhere:data';
async function notes() {
  const { data: note } = await data.notes.create({ title: 'Hello' });
  if (note) await data.notes.update(note.id, { title: 'Updated' });
  const page = await data.notes.list({ limit: 100 });
  if (page.has_more && page.next) return data.notes.list({ after: page.next });
  return page;
}
\`\`\`

Teams without verification: own membership table + member(); sw.groups and domain
roles need VERIFIED emails. Members read/create/update tasks; creators delete while
members. A team-owner delete is one checked endpoint; keep other access declared.
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
      { op: 'insert', table: 'team_members', values: { id: crypto.randomUUID(), team_id: id, user_id: user.id } },
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
      id: crypto.randomUUID(), team_id: params.id, user_id: target.id,
    }, { onConflict: 'ignore' });
    return { ok: true };
  },
});
\`\`\`

Do not mark app-read/write data serverOnly() and hand-write access checks: declare
who may read/write it; the platform enforces it. Server-only fits job/import/audit/
counter state, membership ledgers, and undeclarable rules: arbitrary predicates
(e.g. expiry), or different writable fields per role (split tables or check that write).
Grant ledgers need owner() scope and no browser writes. Keep other access declared.

Starter: src/pages/HomePage.tsx; routes src/App.tsx + src/routes.ts; layout
src/pages/SignedInLayout.tsx. Auth hooks: src/auth/hooks.ts; useAuth from
@somewhere-cloud/sdk/react: signIn/signUp({ email, password }); sign-up signs in.
Keep api/auth/[...path].ts. src/config.ts controls providers/verification.

Files: api/notes.ts → /api/notes; api/notes/[id]/sub.ts → /api/notes/:id/sub
(params.id). Underscore-prefixed files are helpers. GET/DELETE: named exports;
POST: default export. Objects return JSON 200; Response.json sets other statuses.

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

Structured sw.db calls apply caller scopes; sw.db.server bypasses them: authorize first.
Reads: from(table, { where, columns, order: [['id', 'asc']], limit, offset }).
Filters include { id: { in: ids } }; schema uniqueness is unique: [['a', 'b']].
Writes: insert(table, values), update(table, { where, set }), remove(table, { where }).
Transactions are ARRAYs of write intents (above), never callbacks; pre-generate
IDs.

Browser: fetch(path, { method: 'POST', credentials: 'same-origin',
headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) }).
Access cookies refresh automatically. Cookie-auth POST/PATCH/DELETE from scripts
need Origin equal to the app URL.

Publish: somewhere typecheck → npx @somewhere-cloud/cli deploy → somewhere verify → somewhere test.
Deploy raw source, no frontend build. Type errors stop before upload; explicit
override: somewhere deploy --allow-type-errors.
Tests: newUser() gives a signed-in user with its own browser page and API request client; call as many times as needed (owner, member, outsider).
newUser() accepts no chosen email; grant roles or insert memberships in test setup through your app's own authorized server endpoint.
Diagnose with somewhere errors and somewhere logs.

On demand:
- Membership/parent: \`somewhere docs sw.db --section owner-or-member-and-parent-access\`
- Server paging: \`somewhere docs sw.db --section server-read-paging\`
- Direct HTTP data tests: \`somewhere docs declared-data --section calling-the-data-endpoint-directly\`
- Endpoint inputs: \`somewhere docs sw.endpoint --section what-your-handler-receives\`
`;

export const SKILLS_POINTER = `Task-specific skills: \`${SKILLS_DIR}/\`. Inspect/update with somewhere skills status/update.`;

export const DECLARED_ACCESS_POINTER = '';

/** One line telling agents the app's data and code can leave:
 *  an evaluating agent concluded the platform had no exits. Kept outside
 *  AGENT_WORKFLOW, which is a byte mirror of the platform's agent workflow. */
export const PORTABILITY_POINTER = 'Data/code export limits: `somewhere docs portability`.';

export const INIT_AGENTS_MD = `# somewhere.cloud project contract\n${AGENT_WORKFLOW}\n${SKILLS_POINTER}\n${PORTABILITY_POINTER}\n`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
