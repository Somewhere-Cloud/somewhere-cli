import { SKILLS_DIR } from './skills-pack.js';

// Generated mirror of somewhere.cloud/docs/agent-workflow.md. The platform
// docs lint byte-compares this value when SOMEWHERE_CLI_REPO points here.
export const AGENT_WORKFLOW = `## Build, deploy, test

| Does your app verify emails? | Choose the declared access rule |
| --- | --- |
| Yes, invited teams | Use \`group()\` and \`sw.groups\` for invitations, membership and owner/admin permissions. See \`somewhere docs sw.groups --section team-example\`. |
| No, app-managed teams | Use \`member()\` over a server-only roster. Declare author-or-team-owner delete with \`anyOf()\` and a role-filtered branch. See \`somewhere docs declared-data --section teams-without-email-verification\`. |
| Yes, staff by domain | Use \`appRole()\` and \`appRoles: { staff: { emailDomain: 'staff.example' } }\`. The address must be verified. |
| No, staff by invitation | Use \`appRole()\` and \`assignedBy: 'server'\`. Redeem an app-issued invitation and call \`sw.auth.server.setRoles\` inside the sign-up route. See \`somewhere docs sw.auth --section server-assigned-app-roles-setroles\`. |
| Either, personal rows | Use \`owner()\`. The platform stamps the owner from the signed-in user. |
| Either, shared private row | Use a read-only \`grant()\` for a known app-user ID. Share by address only after verification. Adding the grant widens existing caller-scoped reads. See \`somewhere docs declared-data --section read-only-sharing-without-email-verification\`. |
| Either, public pages from private drafts | Use conditional \`client.publicRead\`. Anonymous results can be cached for up to 120 seconds. For fresh pages, read with \`sw.db.server.from\` in a page handler, filter for published rows, select public fields, and set \`Cache-Control: no-store\`. |

### Schema and data

Declare tables in \`db/schema.ts\` with imports, literal values, constants and spreads.
New \`id()\` keys are text. Reference them with \`text({ references: 'table_name' })\`.
Existing integer IDs stay integers. Declare composite uniqueness with \`unique: [['a', 'b']]\`.

- Browser reads and writes use generated \`somewhere:data\`. \`client\` sets allowed operations and fields. Include the key in explicit read lists. Browser calls throw errors, and list pages use the returned \`next\` as \`after\` (at most 100 rows per page).
- \`anyOf()\` grants access through either branch. \`allOf()\` requires both the membership gate and the action rule. \`parent()\` inherits the parent row's access. To let a child author update or delete, declare \`parent({ author, update, delete })\`. It evaluates the child author and the parent operation separately. For staff replies through \`parent()\`, grant staff create permission on the ticket's rule. See \`somewhere docs declared-data --section comments-that-their-author-may-edit\`.
- \`sw.db.from/insert/update/remove\` apply the caller's scope and return \`{ data, count, changes }\`. Use \`where\`, \`columns\`, \`order\`, \`limit\` and \`offset\` for server reads. \`sw.db.tx\` takes an array of write intents. Supply related IDs up front.
- Authorize before \`sw.db.server\` calls, which bypass the caller's scope. Keep declared scopes on records users work with, even when an exceptional write needs server authority. Use \`serverOnly()\` for protected ledgers and job state. Raw SQL uses a separate raw database.
- For booking and help desk schemas, see \`somewhere docs sw.db --section provider-or-booker-and-owner-or-staff-recipes\`. For browser paging, server paging and transactions, see \`somewhere docs sw.db\`.

Use \`client.intake\` for public submissions to a private parent row. See
\`somewhere docs declared-data\` for intake, scoped writes and related rows.

### Routes and auth

- \`src/App.tsx\` and \`src/routes.ts\` route React pages. \`api/notes/[id].ts\` serves \`/api/notes/:id\`. A root \`[...path].ts\` handles document routes, including \`/\`. Underscore-prefixed files are import-only helpers.
- JSON routes use \`sw.endpoint({ auth, body, rateLimit, handler })\`. Set \`auth\` to \`'required'\`, \`'optional'\` or \`'none'\`. Use a limit like \`'30/minute'\`. Read route parameters from the handler's \`params\`. Use a default handler or named HTTP method exports. For streaming, webhooks or custom responses, use a bare \`(req, sw)\` handler and \`sw.params\`. See \`somewhere docs functions\`.
- Keep \`api/auth/[...path].ts\` and extend the starter's \`src/auth/hooks.ts\`. Configure providers in \`src/config.ts\`. Gate private UI on auth state. Password sign-up starts unverified, and signed-in unverified users pass \`auth: 'required'\`. See \`somewhere docs auth-client\`.
- Render a view when the reads it depends on finish. Keep inputs disabled until their initial data and identity are ready, and preserve edits when a late response arrives.
- Browser requests use same-origin cookies. For scripted writes with a cookie session, send the app's origin in the \`Origin\` header. Use the CLI test helper to send data endpoint calls with the deployed contract digest.

### Run and verify

Run \`somewhere typecheck\` and focused tests. \`somewhere deploy-check\` checks compilation and schema without publishing. \`somewhere deploy\` uploads raw source directly to production. When testing changes with real users or data, use \`somewhere preview\`, test with \`somewhere test --preview\`, then promote. See \`somewhere docs dev-environments\`.

Save journeys in \`checks/<name>.json\`, using \`checks/add-a-note.json\` from the notes starter as a model. Keep test IDs when restyling and click the item a person would use. Set \`"signed_in": true\` for a test user and \`"viewports": ["desktop", "mobile"]\` to check both sizes. Saved checks run after deploy. Use \`somewhere test\` to rerun them and \`somewhere verify --flow flow.json\` for a focused journey. For shared access, test the owner, a recipient and an unrelated user separately. The team fixture is in \`somewhere docs sw.groups --section team-example\`. For schedules, trigger \`somewhere cron run <id> --wait\` before asserting its effects. Inspect failures with \`somewhere errors\` and \`somewhere logs\`.

Use \`somewhere docs <topic> --section <id>\` for one section or \`--full\` for all examples. Ask before destructive or paid actions unless the user already authorized them.
`;

export const SKILLS_POINTER = `Task-specific skills: \`${SKILLS_DIR}/\`. Inspect/update with somewhere skills status/update.`;

export const DECLARED_ACCESS_POINTER = '';

/** One line telling agents the app's data and code can leave:
 *  an evaluating agent concluded the platform had no exits. Kept outside
 *  AGENT_WORKFLOW, which is a byte mirror of the platform's agent workflow. */
export const PORTABILITY_POINTER = 'Data/code export limits: `somewhere docs portability`.';

/** One line: using the app from Claude as its signed-in user (MCP tools). */
export const MCP_POINTER = 'App MCP tools: `somewhere docs app-mcp`.';

/** One line on what a preview cannot do today, so no agent learns it by failing.
 *  Rewrite it when previews gain these (the full list: docs dev-environments). */
export const PREVIEW_POINTER = 'Preview users are separate from live users. Sign up in the preview or use `somewhere preview user-add`. Check captured mail with `somewhere preview mail`.';

export const INIT_AGENTS_MD = `# somewhere.cloud project contract
${AGENT_WORKFLOW}
${SKILLS_POINTER}
Without a global CLI, use \`npx @somewhere-cloud/cli deploy\` and \`npx @somewhere-cloud/cli test\`.

For a signed-in browser test, wait for the SDK's expected \`data-sw-auth\` state when available. See \`somewhere docs auth-client --section wait-for-auth-in-a-browser-test\`. For direct data checks, prepare fixture users with \`somewhere test-users prepare alice bob\`, then call \`somewhere data get notes --as alice --id <id>\` as each user. Assert the exact outcome. See \`somewhere docs test --section testing-access-rules\`.

${PORTABILITY_POINTER}
${MCP_POINTER}
${PREVIEW_POINTER}
`;
export const INIT_CLAUDE_MD = 'Read AGENTS.md for project instructions.\n';
