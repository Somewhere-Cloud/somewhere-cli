# @somewhere-cloud/cli

Deploy and manage apps on [Somewhere Cloud](https://somewhere.cloud) from your shell.

## Install

```bash
npm install -g @somewhere-cloud/cli
```

Or run directly:

```bash
npx @somewhere-cloud/cli deploy
```

From a project folder, that single command deploys anonymously when no account
is configured and prints the live URL, claim URL, and expiry.

The package installs the `somewhere` command and the short alias `sw`. It also
installs `cli`, the name `npx @somewhere-cloud/cli` resolves to; use
`somewhere` or `sw` in scripts.

## Quick start

```bash
somewhere login          # Optional: OAuth in browser, stores API key (init/deploy work without it)
somewhere init           # Write a starter; signed-in runs also create and link a project
somewhere dev            # Frontend hot reload on localhost; API calls go to your deployed project
somewhere deploy         # Deploy current directory
somewhere logs --follow  # Stream logs
somewhere open           # Open in browser
```

The CLI needs no MCP setup: every command works from the shell, and `somewhere run <script>` executes code against your live project. `somewhere init` keeps AGENTS.md and useful skills, but does not install agent hooks or command-running MCP configuration. Existing agent settings stay unchanged. Run `somewhere typecheck`, `somewhere typecheck --deploy`, or `somewhere typecheck --deploy --watch` explicitly when you want local checks. Use `somewhere mcp install <host>` when you explicitly want MCP tools connected to an agent host.

For optional after-edit checking, explicitly run `somewhere hooks install --host claude-code` (or `--host codex` / `--host cursor`). It installs only the requested project-local deploy-reference typecheck hook, not MCP registration. Follow the reported host trust step. Shell writes do not trigger the hook; run `somewhere typecheck` after edits, or start `somewhere typecheck --deploy --watch`.

## Commands

| Command | What it does |
|---|---|
| `somewhere login` | Authenticate using a device code |
| `somewhere auth login` | Alias of `somewhere login` |
| `somewhere auth roles grant <user> <role>` | Give an app user an app role declared in `db/schema.ts` `appRoles` (user = sign-up address or app user id); `revoke` and `list` alongside |
| `somewhere logout` | Clear stored credentials |
| `somewhere whoami` | Show current user and project count |
| `somewhere init` | Write a starter; signed-in runs also create and link a project |
| `somewhere init --link --project <id> --template auth` | Scaffold an empty directory and link an existing project; non-empty directories are link-only |
| `somewhere projects` | List all projects with status |
| `somewhere project create <name>` | Create a new project |
| `somewhere project view [name]` | Show project details |
| `somewhere project delete <name>` | Delete a project and all its data. The first call returns a confirmation code (valid 10 minutes); run again with `--confirm-code <code>`, or type the project name when asked |
| `somewhere dev` | Frontend hot reload on localhost with your project's own Vite; API requests go to your deployed project |
| `somewhere preview` | Run your whole app on the platform — every save goes to a private URL, and production is untouched until you promote |
| `somewhere deploy` | Deploy current directory to linked project |
| `somewhere deploy --dry-run` | Upload source to compute the deploy diff without publishing |
| `somewhere deploy --scope functions` | Deploy backend only (leave the site untouched) |
| `somewhere deploy --force` | Intentionally overwrite remote changes made since this machine last deployed |
| `somewhere git connect [owner/repo]` | Install/authorize the GitHub App if needed, deploy repository HEAD, then deploy every push |
| `somewhere git status` | Show connected repo, commit, deploy status, logs link, and live URL |
| `somewhere git disconnect` | Stop push-to-deploy; the currently deployed site stays live |
| `somewhere pull` | Download a project's live deployed source + scaffold tsconfig/package.json for local typechecking |
| `somewhere typecheck` | Loads the pulled `tsconfig.json` explicitly (equivalent to project-wide `tsc --noEmit`) — catches a dropped import (TS2304) with file:line; do not append source-file args, which bypass the project config. It never installs the project's dependencies and stops if declared type packages are not installed (run `npm install` first); without TypeScript in the project it fetches it with npx (network, npm cache) and says so |
| `somewhere logs` | Show recent logs |
| `somewhere logs --follow` | Stream logs in real-time |
| `somewhere logs --level error` | Filter by level |
| `somewhere run <script.js>` | Run a one-off script once against the project's live bindings (`sw.db`/`sw.fs`/`sw.ai`…) and print its return value + logs — no deploy |
| `somewhere errors` | Show the most recent exceptions (endpoint, status, error, time) — the curated error view |
| `somewhere rollback` | Revert production to the previous deployed version |
| `somewhere env list` | Show environment variables |
| `somewhere env set KEY --stdin` | Read an env value from stdin |
| `somewhere env delete KEY` | Delete an env var |
| `somewhere env pull` | Write a local `.env` listing the keys the project expects (values blank — secrets never leave the platform) |
| `somewhere status` | Show project + workspace status |
| `somewhere open` | Open project URL in browser |
| `somewhere open --dashboard` | Open the dashboard |
| `somewhere api GET /v1/projects` | Raw API call with auto-auth |
| `somewhere advisor "<question>"` | Ask the platform advisor; local context is attached only with `--file` (never the linked project or your last command) (`--json` for automation) |
| `somewhere docs [topic]` | Read public text docs or an MCP manual topic such as `sw.db` (`--json` supported) |
| `somewhere catalog` | Browse the live platform tool catalog (`--json` for the raw catalog) |
| `somewhere mcp` | Run MCP server over stdio (proxies to mcp.somewhere.cloud) |
| `somewhere mcp install <host>` | Configure an MCP host (`codex`, `claude-code`, `cursor`) |
| `somewhere mcp doctor` | Check MCP setup: login, token, server reachability, host configs |

Short alias: `sw` works everywhere `somewhere` does.

## Auth flow

`somewhere login` starts device-code sign-in: open the displayed page and
approve the code. Use `--browser-callback` for Google sign-in with a localhost
callback. Credentials are saved in `~/.somewhere/config.json` with mode 600.

MCP connections are optional: `somewhere mcp install <host>` configures the
stdio bridge (`somewhere mcp`). The bridge reads the saved credentials when it
starts. Refreshable credentials can renew automatically; if renewal fails,
follow the reported sign-in instructions.

## Init flow

`somewhere init` writes its starter into the current directory, which should be
empty, and prints that directory's path. Signed in, it also creates a project on
the platform and writes **`.somewhere.json`** (project ID, name, subdomain), which
the CLI reads to know which project you're working on, and installs the
starter's pinned dependencies with `npm install` (this downloads from the npm
registry and runs package install scripts). Signed out, it writes the starter
only and installs nothing; `somewhere deploy` creates a temporary project.

Init writes no MCP configuration; `somewhere mcp install <host>` connects an
agent host when you want one.

## Deploy

`somewhere deploy` reads all files in the current directory (skipping `node_modules`, `.git`, `.env`, etc.), sends them to the platform, and they're live at `{subdomain}.somewhere.site`. Deploy **raw source** — the platform compiles JSX/TSX, resolves npm imports, and bundles for you. Don't run a build step first.

Files under `functions/` (and root-level `api/` and `_lib/`) are deployed as server-side functions.

Files under `public/` deploy at the site root, matching Vite's convention: `public/images/logo.png` serves as `/images/logo.png`.

To exclude local-only files from deploy, add gitignore-style patterns to `.somewhereignore` in the project root. The CLI also respects the root `.gitignore`. `.somewhereignore` is applied after `.gitignore`, so it can add deploy-only excludes or `!` re-includes. Built-in safety excludes such as `node_modules`, `.git`, `.env`, `dist`, and dotfiles still apply.

After each successful linked deploy or pull, the CLI records the current deployed version in `.somewhere.json`. If the project changed elsewhere since that version, the next deploy refuses before overwriting anything and names the changed files. Run `somewhere pull` to bring remote source back locally, or `somewhere deploy --force --yes` to overwrite intentionally.

## GitHub push-to-deploy

```bash
somewhere git connect owner/repo
```

The CLI uses the GitHub App, not a pasted personal access token. It opens
GitHub only when the account or repository still needs authorization, resumes
automatically, deploys the repository's default-branch HEAD immediately, and
waits for that exact commit before printing its status, logs link, and live
URL. Later pushes to the connected branch deploy automatically.

Use `--project <id-or-slug>` outside a linked directory, `--branch <name>` for
a non-default branch, and `--root <directory>` for a monorepo app. `connect`,
`status`, and `disconnect` support `--json`. Disconnecting stops future GitHub
deploys but does not undeploy the current site.

### Deploy options

| Flag | What it does |
|---|---|
| `--scope functions` | Deploy only the backend functions; leave the site untouched |
| `--scope static` | Deploy only the site; leave functions untouched |
| `--dry-run` | Upload source and show what would change without publishing |
| `--replace-functions` | Drop deployed functions not present locally. A full deploy already does this and names each removed function; use it with `--scope functions`, which otherwise keeps them |
| `--project <id>` | Deploy to a specific project instead of the linked one |
| `--force` | Overwrite remote changes even when this machine has an older deployed version |
| `--yes` | Skip the `--force` confirmation prompt |

After a successful deploy the CLI prints a **build log** — the entry chunk, each compiled chunk with its size, each function with its size, and any compiler warnings.

```bash
somewhere deploy --dry-run            # preview the diff first
somewhere deploy --scope functions    # ship a backend fix without touching the site
somewhere deploy --force --yes        # overwrite remote edits intentionally
```

## Development: `somewhere dev`

`somewhere dev` is frontend hot reload. It serves your frontend on localhost
with the project's own Vite, and sends API requests to your deployed project,
so pages talk to the backend that is live. Save a frontend file and the page
updates.

```bash
somewhere dev              # serve on http://localhost:8787
somewhere dev --port 3000  # pick the port
somewhere dev --open       # open the browser once it is serving
```

It needs a signed-in, linked project that has been deployed at least once, and
the frontend's dependencies installed (`npm install`). Backend code — `api/`
functions and `db/schema.ts` — runs only on the platform: change it with
`somewhere deploy`, or work on the whole app with `somewhere preview`. There is
no local function runtime.

`somewhere dev` runs none of your own commands; extra arguments are refused.

## `somewhere preview`

There are two loops, and they are named after where the app runs.
`somewhere dev` serves the frontend from your machine against the deployed
backend. `somewhere preview` runs the whole app on the platform.

`somewhere preview` sends every save to a private URL, reachable only by you
until you share the link. The build is the one production would get. The
database starts as a separate copy of your production data, rows included,
taken when the preview was created, so you test against real-shaped data and
nothing you try in a preview can change production rows. Because that copy is
real data, the link is what grants access to it; treat sharing one as sharing
that copy. After each update the
command prints that URL and the `somewhere promote` command that makes those
exact bytes live. Reach for it when you want a URL to send someone, or when the
agent doing the work reaches the platform over MCP and has no local machine to
serve from.

Nothing your users see changes while you preview. Production keeps serving what
you last promoted.

The URL is single-use and short-lived by design: opening it exchanges it for a
private session in that browser, and saving a file replaces it with a new one.
Use the newest URL the command printed. Anyone without a live URL — signed out,
or signed in as someone else — gets a 404.

A preview is built against your live version, so a project that has never been
published has nothing for the first one to build on. On such a project
`somewhere preview` asks before publishing once (`--publish-first` gives that
consent up front in a script), and every preview after that stays private to you
and never changes what is live.

Whether your plan includes `somewhere preview` comes from the platform: when it
does not, the command says so and names the plans that do (see
https://somewhere.cloud/pricing). `somewhere dev` and deploying work on every
plan.

## Browser data and auth

The default starter includes cookie-based sign-in. Add private notes with
`somewhere init --features auth,private-data` in an empty directory. Its
`db/schema.ts` declares the note fields, permitted browser operations and
`owner()` access rule. The generated client applies that rule on the server;
browser code sends no developer key or user filter.

```ts
import { data } from 'somewhere:data';

const page = await data.notes.list({ limit: 20 });
const created = await data.notes.create({ title: 'First note', body: '' });
if (created.data) {
  await data.notes.update(created.data.id, { title: 'Updated note' });
  await data.notes.delete(created.data.id);
}
```

`page.data` holds the rows and `page.has_more` indicates another page. Available
methods and fields come from your schema. Failed operations throw; handle errors
in your application's UI.

For auth, use the starter's shared client from `src/services/auth.ts`:

```ts
import { auth } from './services/auth';

await auth.signIn({ email: 'person@example.com', password: 'your password' });
// The starter handles sign-in errors and any required email-code step.
await auth.signOut();
```

That service creates one `createSomewhereAuth()` instance from
`@somewhere-cloud/sdk/auth`. The starter mounts `somewhereAuth` from
`@somewhere-cloud/sdk/server` at `api/auth/[...path].ts`. Sessions use same-origin
httpOnly cookies; app code does not store a developer key. Keep the starter's
pending, error and email-code UI when building your own forms.

Use same-origin `fetch('/api/your-function')` for your application functions.
Server functions use the supplied `sw` runtime for trusted data access and must
check the caller's authority. The minimal starter demonstrates a public,
read-only `/api/greeting` function; it does not grant browser database access.

## Requirements

Node.js >= 22.19.0. On an older Node.js every command stops with a message naming the required version.

## License

MIT © Somewhere HQ, Inc.

## Test any Somewhere app

Add the CLI with `npm install --save-dev @somewhere-cloud/cli`, then import
`createUser`, `signIn`, `UserSession`, `expectRefusal`, and `waitForApp` from
`@somewhere-cloud/cli/testing` in Node tests. No starter is required.

```ts
import { createUser, expectStatus } from '@somewhere-cloud/cli/testing';
const user = await createUser(process.env.APP_URL!);
await expectStatus(await user.request('/api/auth/me'), 200);
```

The app must mount the packaged auth handler at `/api/auth`. `createUser` creates
an independent throwaway user at the platform test domain; it does not use admin
credentials. `signIn(url, email, password)` supports an existing test user.
Sessions retain cookies and send the app Origin. `session.data(table, contract,
{ operation: 'list' })` posts the browser runtime shape; supply the deployed
browser client's contract digest. `expectRefusal(response, 403, 'DATA_ACCESS_DENIED')`
requires both the exact status and code: malformed 400 requests fail.

Browser tests can call `waitForApp(page, 'signed-in')` or `'signed-out'`; omit the
state for either ready state. Add `data-app-state` to your own app's confirmed auth
boundary (the starter already does). Do not mark loading or unconfirmed logout ready.
Each test owns its fixture. Rerun only a failing test with `--test-name-pattern`;
a pass means the checks you wrote passed; say which requirements they do not cover.
