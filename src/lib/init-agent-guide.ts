import { FIRST_CLI_PERMISSION } from './first-cli-permission.js';
import { SKILLS_DIR } from './skills-pack.js';

// Generated mirror of somewhere.cloud/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Build, deploy, test

Enough to start a typical app: declare access and use the browser client; docs are for exceptions.

| Requirement | Declaration below |
| --- | --- |
| Each user sees only their own rows | notes: owner() |
| Team: owner invites members; members read/write; creator or team owner deletes | tasks: anyOf(owner(), group()); sw.groups endpoints below |
| Owner/staff record with staff-only child notes | tickets: owner() or appRole(); parent() thread; staff-only notes; staff by verified emailDomain (or grantableBy) |
| Public pages from private drafts | pages: conditional publicRead |
| Share one record read-only | shared_notes/note_shares: read-only grant() |

db/schema.ts is declaration only: imports, constants/spreads, default schema;
no helpers/expressions. id() is random text; owner() stamps user_id. client.read
includes the key. Inside anyOf(), owner() takes only column/read: it stamps the
creator, not create/delete options; group() gates placement (non-member create is
refused); inside anyOf an operation missing from roles allows no group role. Other fields: timestamp({ default: 'now' }), text({ nullable: true });
indexes: [['team_id']].

\`\`\`ts
import { schema, table, id, text, owner, group, anyOf, parent, appRole, boolean, grant } from 'somewhere/db';
export default schema({
  notes: table({ id: id(), title: text() }, { scope: owner(), client: { read: ['id', 'title'], create: ['title'], update: ['title'], delete: true },
  }),
  tasks: table({ id: id(), team_id: text(), title: text() }, {
    scope: anyOf(owner(), group({ column: 'team_id', roles: { read: ['owner', 'admin', 'member'],
      create: ['owner', 'admin', 'member'], update: ['owner', 'admin', 'member'], delete: ['owner'] } })),
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
}, { appRoles: { staff: { emailDomain: 'staff.example' } } });
\`\`\`

Who is staff is your app's decision; the platform enforces what the role may do.
First choice, as above: emailDomain. The role holds once the person verifies an address
at that domain; no grant code. An email ending alone proves nothing: anyone can sign up
as anyone@your-domain without owning that mailbox. Without verification, grant only from
something the visitor cannot choose, such as an invitation your app issued, checked inside
the sign-up route: single use, bound to one account, its link delivered only to that person:
somewhere docs sw.auth --section server-assigned-app-roles-setroles.
messages use parent(): owner() would hide staff replies from the customer.
A staff reply is a messages row, and creating a parent() child needs create on the parent
for that person: its owner, or a role listed under the parent's create. Read or update is
not enough. So tickets lists create: ['staff']; without it every staff reply is refused
(403 POLICY_AUTHORITY_REQUIRED).
Publish pages in an owner-checked endpoint. Share with caller-scoped
sw.db.insert('note_shares', { grantee_id, note_id }); it checks row ownership.
Browser calls THROW, not { error }; catch below.
Browser list: paginate with after. Sort locally or in an endpoint.

\`\`\`ts
import { data } from 'somewhere:data';
export async function save(title: string) {
  try { await data.notes.create({ title }); return null; }
  catch (e) { return e instanceof Error ? e.message : 'Save failed'; }
}
export const list = (after?: string) => data.notes.list({ limit: 100, after });
\`\`\`

A page that needs several reads: start them together and show it once every read it depends on has answered.
Keep an input disabled until the data it depends on has loaded, including who the user is.
Never let a late answer overwrite what the user typed: fill an input from loaded data only before it is enabled.

Teams are built-in groups: the platform keeps the team, invitations, roster, removal,
leaving, last owner. Starting a team needs a signed-in user; joining needs a verified
email (a password sign-up joins once it enters its emailed code).
No email verification in your app: keep membership in your own table with member() (somewhere docs sw.groups --section relationships-that-are-not-teams) and assign staff with setRoles in the sign-up route (above).
The browser cannot call
sw.groups: pass each call through an endpoint. A parent() child's delete follows the task
(creator or team owner), so "comment author or team owner deletes" is an endpoint.
Staff making others staff: appRoles { staff: { grantableBy: ['staff'] } } and
sw.groups.appRoles.grant(request, userId, 'staff') in an endpoint (never to oneself).
Complete apps and specs: somewhere docs sw.groups --section team-example or staff-example.

\`\`\`ts
// api/teams.ts — GET my teams (completes invitations to me); POST starts one I own
const refusal = (e: { code: string; message: string; status: number }) =>
  Response.json({ error: e.code, message: e.message }, { status: e.status });
export const GET = sw.endpoint({ auth: 'required', handler: async ({ request }, sw) => {
  const page = await sw.groups.list(request, { limit: 100 });
  return page.error ? refusal(page.error) : { teams: page.data.items, next_cursor: page.data.next_cursor };
} });
export default sw.endpoint({ auth: 'required', body: { name: 'string' }, handler: async ({ request, body }, sw) => {
  const made = await sw.groups.create(request, { name: body.name });
  return made.error ? refusal(made.error) : { id: made.data.id };
} });
\`\`\`

\`\`\`ts
// api/teams/[id]/invitations.ts — owners invite; others 403; a member's address 409 ALREADY_MEMBER
export default sw.endpoint({ auth: 'required', body: { email: 'string' }, handler: async ({ request, params, body }, sw) => {
  const sent = await sw.groups.invite(request, params.id, { email: body.email, role: 'member', redirect_uri: '/' });
  return sent.error ? Response.json({ error: sent.error.code }, { status: sent.error.status }) : { delivery: sent.data.delivery };
} });
\`\`\`

Same shape: sw.groups.get/members(request, id), remove(request, id, userId), leave(request, id)
(last owner: 409 LAST_OWNER), delete(request, id) by owners.

Do not hand-write access to app-read/write data: declare who may read/write it.
serverOnly() fits job/import/audit/counter state.
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
Caller-scoped sw.db.insert needs no client.create grant: client limits only the browser.
Reads: from(table, { where, columns, order: [['id', 'asc']], limit, offset }).
Filter: { id: { in: ids } }; unique: [['a', 'b']] in schema.
Writes: insert(table, values), update(table, { where, set }), remove(table, { where }).
tx takes an ARRAY of write intents, never a callback; pre-generate related IDs.

Browser: fetch(path, { method: 'POST', credentials: 'same-origin',
headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) }).
Access cookies refresh automatically. Cookie-auth POST/PATCH/DELETE from scripts
need Origin equal to the app URL.

After every deploy the platform checks the live app in its own browser: pages load signed out and as a
test user, a stranger and a signed-out visitor cannot read a person's data, and your saved checks pass.
Save each journey you want re-checked after every deploy as checks/<plain-name>.json; the platform runs them
in its browser after each deploy and \`somewhere test\` runs them now.
${FIRST_CLI_PERMISSION}
Run them now: npx @somewhere-cloud/cli test (one PASS or FAIL line per check, failures first; exit 1 when one fails).
A saved check is the somewhere verify --flow actions list; "signed_in": true runs it as a test user the platform
creates and removes, and "viewports": ["desktop", "mobile"] runs it at both sizes:
  { "actions": [ { "fill": "[data-testid=note-title]", "value": "Lunch with Ana 42" },
      { "click": "[data-testid=note-save]" },
      { "expect": { "selector": "[data-testid=note-item]", "text": "Lunch with Ana 42" } } ],
    "signed_in": true, "viewports": ["desktop", "mobile"] }
Find controls by data-testid so renaming a button does not break a check; keep the ids when you restyle.
The notes starter ships this one as checks/add-a-note.json (note-title, note-save, note-item): start from it.
Open a list item by clicking the item element itself (what a person clicks), not a link inside it.
Deploy raw source, no frontend build; type errors stop upload.
The complete team spec, with removal and leaving: somewhere docs sw.groups --section team-example.
Diagnose with somewhere errors and somewhere logs.

On demand:
- Server paging: \`somewhere docs sw.db --section server-read-paging\`

## Testing shared access

With the team endpoints above, the owner invites a fixture by email; test users are verified,
so its next GET /api/teams shows the team. A test user who still owns a team is not deleted:
delete the team last (api/teams/[id].ts DELETE: sw.groups.delete). Group calls take
about a second, so raise the timeout:

\`\`\`ts
// tests/team.spec.ts
import { test, expect } from '@somewhere-cloud/cli/testing';
test.describe.configure({ timeout: 90_000 });
test('owner invites a second user by email', async ({ newUser }) => {
  const [owner, bob] = await Promise.all([newUser(), newUser()]);
  const { id } = await (await owner.request.post('/api/teams', { data: { name: 'Shared team' } })).json();
  expect((await owner.request.post(\`/api/teams/\${id}/invitations\`, { data: { email: bob.email } })).ok()).toBeTruthy();
  const { teams } = await (await bob.request.get('/api/teams')).json();
  expect(teams).toContainEqual(expect.objectContaining({ id, role: 'member' }));
  expect((await owner.request.delete(\`/api/teams/\${id}\`)).status()).toBe(204);
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

/** One line on what a preview cannot do today, so no agent learns it by failing.
 *  Rewrite it when previews gain these (the full list: docs dev-environments). */
export const PREVIEW_POINTER = 'somewhere preview runs your change on a copy of production data with its own sign-in: a preview starts with no users (sign up in it or `somewhere preview user-add`), its sign-in mail is captured (`somewhere preview mail`), and rows private to a production user stay hidden from preview users. Server user lookup, roles and built-in teams work in a preview (its own users, its own copy; team invitations are captured); jobs/cron handlers do not yet: check those in production after promoting (`somewhere docs dev-environments`). Test your change in the preview before you promote it: `somewhere test --preview`.';

const TEST_ACCESS_RULES = `## Testing access rules

In a linked test app, run \`somewhere test-users prepare alice bob\`. For an
owner() table with client create and read, create a fixture as Alice and read it
as both users:

\`\`\`sh
ID=$(somewhere data create notes --as alice --values '{"title":"Access test"}' | jq -er 'select(.status == 200 and .kind == "ok") | .data.id') &&
somewhere data get notes --as alice --id "$ID" | jq -e '.status == 200 and .kind == "ok"' &&
somewhere data get notes --as bob --id "$ID" | jq -e '.status == 200 and .kind == "empty" and .data == null and .access == {"filtered":true,"by":"owner"}'
\`\`\`

200 with access.filtered means the rule constrained the read, even when rows
are returned. 404 DATA_NOT_FOUND on update or delete hides whether the row
exists. 401 AUTH_REQUIRED needs a signed-in session. 403 names the access rule
or operation that refused the call. DATA_CONTRACT_* means the operation never
ran. Assert the exact outcome in handed-over tests and confirm a refused write
left the owner's fixture unchanged.
`;

export const INIT_AGENTS_MD = `# somewhere.cloud project contract
${FIRST_CLI_PERMISSION}

${SKILLS_POINTER}

Build your app. Deploy the raw source and run its tests: \`npx @somewhere-cloud/cli deploy && npx @somewhere-cloud/cli test\`.

For an app with sign-in, keep the starter's auth gate. Render private UI only after the session is confirmed. Keep the pending and retry views. In a browser test wait for the expected screen; if the SDK publishes \`data-sw-auth\` on \`<html>\`, first wait for the expected sign-in state there.

${AGENT_WORKFLOW}\n${TEST_ACCESS_RULES}\n${PORTABILITY_POINTER}\n${MCP_POINTER}\n${PREVIEW_POINTER}\n`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
