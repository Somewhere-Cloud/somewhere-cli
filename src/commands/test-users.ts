import { Command } from 'commander';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ApiClient, CliApiError } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { error, printJson, printJsonError, success, info, warn } from '../lib/output.js';
import { resolveProjectRef } from '../lib/platform-command.js';
import {
  CLEANUP_RECEIPT_FILE, MANIFEST_FILE, MAX_PER_CREATE, RETAINED_NOTE, TEST_STATE_DIR,
  buildStorageState, createTestIdentities, ensureGitignored, ensurePrivateDir, expiryOf, freshTestAddress,
  messagesAfter, parseActorSpecs, parseSince, productionOrigin, readManifest, removeStateFiles, stateDir,
  writeManifest, writePrivateFile,
  type IssuedIdentity, type ManifestActor, type TestManifest, type TestRole,
} from '../lib/test-identities.js';

interface Target { client: ApiClient; root: string; projectId: string; subdomain: string; origin: string; host: string }

/** The current folder must be linked to the target project: state never lands anywhere else. */
async function resolveTarget(projectOpt: string | undefined, originOpt?: string): Promise<Target> {
  const root = process.cwd();
  const linked = loadProjectConfig(root);
  if (!linked?.project_id) {
    throw Object.assign(new Error('Run this from the project folder (the one with .somewhere.json): test state is kept in that project\'s .somewhere/test/, never anywhere else.'), { code: 'NOT_A_PROJECT_FOLDER' });
  }
  const client = new ApiClient(getToken());
  const ref = resolveProjectRef(projectOpt);
  const project = await client.call<{ id?: string; subdomain?: string }>('GET', `/projects/${encodeURIComponent(ref)}`);
  if (typeof project?.id !== 'string' || typeof project.subdomain !== 'string') throw new Error('The platform did not return this project\'s id and address.');
  if (project.id !== linked.project_id) {
    throw Object.assign(new Error(`This folder is linked to ${linked.project_id}, not ${project.id}. Run it from that project's folder.`), { code: 'PROJECT_FOLDER_MISMATCH' });
  }
  const urls = await client.call<{ prod_fallback?: string }>('GET', `/projects/${encodeURIComponent(project.id)}/urls`);
  const { origin, host } = productionOrigin(urls?.prod_fallback, originOpt);
  return { client, root, projectId: project.id, subdomain: project.subdomain, origin, host };
}

function fail(opts: { json?: boolean }, cause: unknown, extra?: Record<string, unknown>): void {
  const code = cause instanceof CliApiError ? cause.code : (cause as { code?: string })?.code ?? 'TEST_USERS_FAILED';
  const message = cause instanceof Error ? cause.message : String(cause);
  if (opts.json) printJsonError(code, message, extra);
  else error(`${message} [${code}]`, cause);
  process.exitCode = 1;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function registerTestUsers(program: Command): void {
  const group = program
    .command('test-users')
    .description('Signed-in test users for local Playwright, agent-browser and hosted verify: prepare, address, inbox, cleanup')
    .addHelpText('after', [
      '',
      'State is kept in this project folder only: .somewhere/test/ (private files, gitignored). It holds each',
      'actor\'s app session, never your developer key. Prepared actors are preverified; they are not evidence',
      'that signup or email verification works. Use `address` + `inbox` for real signup tests.',
      `${RETAINED_NOTE}`,
    ].join('\n'));

  group
    .command('prepare <actors...>')
    .description('Create preverified test users and write one Playwright storageState file per actor (e.g. alice bob:admin)')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--origin <url>', 'Only the project\'s production origin is supported; anything else is refused')
    .option('--json', 'Print the manifest (no tokens) as JSON')
    .addHelpText('after', [
      '',
      'Writes .somewhere/test/<actor>.state.json (a standard Playwright storageState) and manifest.json.',
      'Playwright:     browser.newContext({ storageState: ".somewhere/test/alice.state.json" })',
      'Save the context back after each run:  await context.storageState({ path: ".somewhere/test/alice.state.json" })',
      'The app refreshes the short-lived access token and rotates the session on its first refresh, so an unsaved',
      'file stops working after a run that refreshed it. Each session lasts the platform test-session lifetime',
      '(about 1 hour; run prepare again after that). Each identity expires after 24 hours.',
    ].join('\n'))
    .action(async (actorValues: string[], opts: { project?: string; origin?: string; json?: boolean }) => {
      let specs;
      try { specs = parseActorSpecs(actorValues); } catch (cause) { fail(opts, cause); return; }
      let target: Target;
      try { target = await resolveTarget(opts.project, opts.origin); } catch (cause) { fail(opts, cause); return; }
      const dir = stateDir(target.root);
      let existing: TestManifest | null = null;
      try { existing = readManifest(target.root); } catch (cause) { fail(opts, cause); return; }
      if (existing && existing.actors.length) {
        fail(opts, Object.assign(new Error(`${TEST_STATE_DIR}/${MANIFEST_FILE} still records ${existing.actors.length} test user(s) from run ${existing.run_id}. Run \`somewhere test-users cleanup\` first.`), { code: 'TEST_USERS_NOT_CLEANED' }));
        return;
      }
      ensurePrivateDir(dir);
      const gitignore = ensureGitignored(target.root);
      const manifest: TestManifest = {
        schema: 1, project_id: target.projectId, origin: target.origin, run_id: `tu_${randomBytes(6).toString('hex')}`,
        created_at: new Date().toISOString(), actors: [], status: 'preparing', retained_note: RETAINED_NOTE,
      };
      writeManifest(target.root, manifest);

      const record = (spec: { name: string; role: TestRole }, issued: IssuedIdentity, receivedAt: number) => {
        const times = expiryOf(issued, receivedAt);
        const file = `${spec.name}.state.json`;
        writePrivateFile(join(dir, file), JSON.stringify(buildStorageState(target.origin, target.host, issued, times), null, 2) + '\n');
        const actor: ManifestActor = {
          name: spec.name, user_id: issued.user.id, email: issued.user.email, role: spec.role,
          created_at: typeof issued.user.created_at === 'number' ? iso(issued.user.created_at * 1000) : iso(receivedAt),
          access_expires_at: iso(times.accessExpiresAt), session_expires_at: iso(times.sessionExpiresAt), state_file: file,
        };
        manifest.actors.push(actor);
        writeManifest(target.root, manifest); // recorded as soon as it exists, so cleanup can always reconcile
      };

      let failure: unknown = null;
      for (const role of ['user', 'admin'] as const) {
        const wanted = specs.filter((spec) => spec.role === role);
        for (let at = 0; at < wanted.length && !failure; at += MAX_PER_CREATE) {
          const chunk = wanted.slice(at, at + MAX_PER_CREATE);
          try {
            const { issued, receivedAt } = await createTestIdentities(target.client, target.projectId, role, chunk.length, 'pw');
            issued.forEach((identity, index) => record(chunk[index], identity, receivedAt));
          } catch (cause) {
            const partial = cause as { issued?: IssuedIdentity[]; receivedAt?: number };
            (partial.issued ?? []).forEach((identity, index) => { if (chunk[index]) record(chunk[index], identity, partial.receivedAt ?? Date.now()); });
            failure = cause;
          }
        }
      }
      manifest.status = failure ? 'partial' : 'prepared';
      writeManifest(target.root, manifest);

      if (opts.json) {
        if (failure) fail(opts, failure, { manifest, state_dir: TEST_STATE_DIR, created: manifest.actors.length, requested: specs.length });
        else printJson({ manifest, state_dir: TEST_STATE_DIR, gitignore });
        return;
      }
      for (const actor of manifest.actors) {
        info(`${actor.name} (${actor.role})  ${actor.email}  user ${actor.user_id}`);
        info(`  ${TEST_STATE_DIR}/${actor.state_file}  session until ${actor.session_expires_at}`);
      }
      if (gitignore !== 'present') info(`${gitignore === 'created' ? 'Created' : 'Updated'} .gitignore to ignore ${TEST_STATE_DIR}/.`);
      info(RETAINED_NOTE);
      if (failure) {
        fail(opts, failure);
        warn(`Prepared ${manifest.actors.length} of ${specs.length} actors; the ones created are recorded in ${TEST_STATE_DIR}/${MANIFEST_FILE}. Run \`somewhere test-users cleanup\` to remove them.`
          + ' If the platform may have created more than were returned, they expire 24 hours after creation.');
      } else {
        success(`Prepared ${manifest.actors.length} signed-in test user${manifest.actors.length === 1 ? '' : 's'} for ${target.origin}.`);
      }
    });

  group
    .command('address')
    .description('A fresh test-mailbox address and checkpoint, for testing real signup, verification or invitation')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--name <prefix>', 'Address prefix (lowercase letters, digits, -)', 'signup')
    .option('--json', 'Print { address, checkpoint } as JSON')
    .action(async (opts: { project?: string; name: string; json?: boolean }) => {
      try {
        const target = await resolveTarget(opts.project);
        const address = freshTestAddress(target.subdomain, opts.name);
        const checkpoint = Date.now();
        if (opts.json) { printJson({ address, checkpoint, checkpoint_iso: iso(checkpoint) }); return; }
        info(`Address:    ${address}`);
        info(`Checkpoint: ${checkpoint}  (${iso(checkpoint)})`);
        info('Sign up or invite with this address in the app, then read only mail newer than the checkpoint:');
        info(`  somewhere test-users inbox ${address} --since ${checkpoint} --wait 10000`);
      } catch (cause) { fail(opts, cause); }
    });

  group
    .command('inbox <actorOrAddress>')
    .description('The newest verification code (or link) sent to a test address after a checkpoint')
    .requiredOption('--since <time>', 'Only mail created after this time (epoch ms or ISO), e.g. the checkpoint from `address`')
    .option('--wait <ms>', 'Wait up to this long for new mail (max 10000)', '0')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--json', 'Print the message as JSON')
    .option('--include-link', 'With --json: include the magic link')
    .option('--link-out <file>', `Write the magic link to a private file under ${TEST_STATE_DIR}/`)
    .action(async (who: string, opts: { since: string; wait: string; project?: string; json?: boolean; includeLink?: boolean; linkOut?: string }) => {
      try {
        const since = parseSince(opts.since);
        const waitMs = Number(opts.wait);
        if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10_000) throw new Error('--wait must be 0-10000 milliseconds.');
        if (opts.includeLink && !opts.json) throw new Error('--include-link needs --json.');
        const target = await resolveTarget(opts.project);
        let address = who;
        if (!who.includes('@')) {
          const actor = readManifest(target.root)?.actors.find((item) => item.name === who);
          if (!actor) throw Object.assign(new Error(`No prepared actor named "${who}" in ${TEST_STATE_DIR}/${MANIFEST_FILE}. Pass an address instead.`), { code: 'UNKNOWN_ACTOR' });
          address = actor.email;
        }
        const body = await target.client.call<{ messages?: unknown }>('GET', '/email/test-inbox', undefined,
          { project_id: target.projectId, address, limit: 20, since, wait_ms: waitMs || undefined }, { timeoutMs: waitMs + 30_000 });
        const [newest] = messagesAfter(body?.messages, address, since);
        if (!newest) {
          throw Object.assign(new Error(`No mail to ${address} newer than ${iso(since)}${waitMs ? ` after waiting ${waitMs} ms` : ''}. Older mail is never returned; send again from the app if needed.`), { code: 'TEST_INBOX_NO_NEW_MESSAGE' });
        }
        let linkFile: string | undefined;
        if (opts.linkOut) {
          if (!newest.magic_link) throw Object.assign(new Error('The newest message has no magic link.'), { code: 'NO_MAGIC_LINK' });
          const name = basename(opts.linkOut);
          if (name !== opts.linkOut || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error(`--link-out takes a file name; it is written under ${TEST_STATE_DIR}/.`);
          ensurePrivateDir(stateDir(target.root));
          writePrivateFile(join(stateDir(target.root), name), newest.magic_link + '\n');
          linkFile = `${TEST_STATE_DIR}/${name}`;
        }
        const message = {
          id: newest.id, to: newest.to, subject: newest.subject, created_at: newest.created_at,
          verification_code: newest.verification_code, magic_link_present: !!newest.magic_link,
          ...(opts.includeLink && newest.magic_link ? { magic_link: newest.magic_link } : {}),
          ...(linkFile ? { magic_link_file: linkFile } : {}),
        };
        if (opts.json) { printJson({ address, since, message }); return; }
        info(`${newest.subject}  (${newest.created_at})`);
        if (newest.verification_code) info(`verification_code: ${newest.verification_code}`);
        if (newest.magic_link) info(linkFile ? `magic link written to ${linkFile}` : 'magic link: present (use --json --include-link, or --link-out <file>)');
        if (!newest.verification_code && !newest.magic_link) info('This message has no verification code or link.');
      } catch (cause) { fail(opts, cause); }
    });

  group
    .command('cleanup')
    .description('Delete the test users this folder prepared and remove their local state; app data is kept')
    .option('-p, --project <project>', 'Project slug or ID; defaults to the linked project')
    .option('--keep-state', 'Keep the local state files')
    .option('--json', 'Print the cleanup receipt as JSON')
    .action(async (opts: { project?: string; keepState?: boolean; json?: boolean }) => {
      try {
        const target = await resolveTarget(opts.project);
        const manifest = readManifest(target.root);
        if (!manifest || !manifest.actors.length) {
          if (opts.json) printJson({ identities: { requested: 0 }, note: `Nothing recorded in ${TEST_STATE_DIR}/${MANIFEST_FILE}.` });
          else info(`Nothing to clean up: ${TEST_STATE_DIR}/${MANIFEST_FILE} records no test users.`);
          return;
        }
        if (manifest.project_id !== target.projectId) throw Object.assign(new Error(`The manifest belongs to ${manifest.project_id}, not ${target.projectId}.`), { code: 'PROJECT_FOLDER_MISMATCH' });
        const ids = manifest.actors.map((actor) => actor.user_id);
        let deleteError: string | null = null;
        try {
          await target.client.call('DELETE', '/auth/test-users', { project_id: target.projectId, ids });
        } catch (cause) {
          deleteError = cause instanceof CliApiError ? `${cause.code}: ${cause.message}` : cause instanceof Error ? cause.message : String(cause);
        }
        // Read back rather than trusting the delete response.
        let live: Set<string> | null = null;
        try {
          const listed = await target.client.call<{ identities?: Array<{ id?: string }> }>('GET', '/auth/test-users', undefined, { project_id: target.projectId });
          live = new Set((listed?.identities ?? []).map((item) => String(item.id)));
        } catch { live = null; }
        const removed = live ? ids.filter((id) => !live!.has(id)) : [];
        const remaining = live ? ids.filter((id) => live!.has(id)) : [];
        const unknown = live ? [] : ids;
        const removedActors = manifest.actors.filter((actor) => removed.includes(actor.user_id));
        const localRemoved = opts.keepState ? [] : removeStateFiles(target.root, removedActors);
        const receipt = {
          at: new Date().toISOString(), run_id: manifest.run_id, project_id: manifest.project_id, origin: manifest.origin,
          identities: { requested: ids.length, removed, remaining, unknown, ...(deleteError ? { delete_error: deleteError } : {}) },
          sessions: removed.length ? 'removed together with each removed identity' : 'none removed',
          app_data_files_and_test_mail: 'retained: ' + RETAINED_NOTE,
          local_state: { removed: localRemoved, kept: manifest.actors.map((actor) => actor.state_file).filter((file) => !localRemoved.includes(file)) },
          actors: manifest.actors.map(({ name, user_id, email, role, created_at }) => ({ name, user_id, email, role, created_at })),
        };
        writePrivateFile(join(stateDir(target.root), CLEANUP_RECEIPT_FILE), JSON.stringify(receipt, null, 2) + '\n');
        // Keep the manifest while anything is left to reconcile; otherwise the receipt is the record.
        const left = manifest.actors.filter((actor) => !removed.includes(actor.user_id));
        if (left.length) writeManifest(target.root, { ...manifest, actors: left, status: 'partial' });
        else rmSync(join(stateDir(target.root), MANIFEST_FILE), { force: true });
        if (opts.json) { printJson(receipt); if (left.length) process.exitCode = 1; return; }
        info(`Identities: ${removed.length} removed, ${remaining.length} remaining, ${unknown.length} unknown (of ${ids.length}).`);
        if (deleteError) warn(`Delete reported: ${deleteError}`);
        info(`Sessions: ${receipt.sessions}.`);
        info(`App data, files and test mail: ${receipt.app_data_files_and_test_mail}`);
        info(`Local state: ${localRemoved.length} removed, ${receipt.local_state.kept.length} kept. Receipt: ${TEST_STATE_DIR}/${CLEANUP_RECEIPT_FILE}`);
        if (left.length) { warn(`${left.length} test user(s) are still recorded in ${TEST_STATE_DIR}/${MANIFEST_FILE}; run cleanup again.`); process.exitCode = 1; }
        else success('Test users removed.');
      } catch (cause) { fail(opts, cause); }
    });
}

/** Exported for tests: a manifest on disk never contains a token. */
export function manifestHasNoSecrets(root: string): boolean {
  const path = join(stateDir(root), MANIFEST_FILE);
  if (!existsSync(path)) return true;
  return !/access_token|refresh_token|session_token|eyJ/.test(readFileSync(path, 'utf8'));
}
