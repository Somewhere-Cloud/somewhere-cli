import { cliInvocation } from '../lib/cli-invocation.js';
import { Command } from 'commander';
import { loadConfig, temporaryConfigExpired, temporaryWorkspaceExpiryMessage } from '../lib/config.js';
import { error, info, printJson, teal } from '../lib/output.js';

/** `somewhere claim`: the claim link of this computer's temporary workspace,
 *  for a signed-out person who deployed and wants to keep the app
 *. Reads the local credential only; nothing is sent. */
export function registerClaim(program: Command) {
  program
    .command('claim')
    .description("Print the claim link for this computer's temporary apps")
    .option('--json', 'Print { claim_url, expires_at } as JSON')
    .action((opts: { json?: boolean }) => {
      const config = loadConfig();
      if (!config?.temporary || !config.claim_url) {
        const message = config?.token
          ? `This terminal has no temporary workspace to claim. Run \`${cliInvocation()} projects\` to see the apps it can access.`
          : `This terminal has no temporary workspace. If you deployed signed out from another terminal, run \`${cliInvocation()} claim\` there. Run \`${cliInvocation()} deploy\` here to start one.`;
        if (opts.json) printJson({ ok: false, error: config?.token ? 'NOT_TEMPORARY' : 'NO_TEMPORARY_WORKSPACE', message });
        else error(message);
        process.exit(1);
      }
      const expired = temporaryConfigExpired(config);
      if (opts.json) {
        printJson({ ok: !expired, claim_url: config.claim_url, expires_at: config.temp_expires_at ?? null, expired });
        if (expired) process.exit(1);
        return;
      }
      if (temporaryConfigExpired(config)) {
        error(temporaryWorkspaceExpiryMessage(config.temp_expires_at));
        process.exit(1);
      }
      info(`Claim link: ${teal(config.claim_url)}`);
      if (config.temp_expires_at) info(`Expires at: ${config.temp_expires_at} (UTC)`);
      info('Open it in a browser and sign in or create an account to keep these apps.');
      if (config.claim_handoff?.handoff_id) {
        info('Choose "Save and connect agent" to work on the saved apps and create new ones. You can choose to include your other apps.');
      } else {
        info(`Run \`${cliInvocation()} login\` to connect this terminal after saving.`);
      }
    });
}
