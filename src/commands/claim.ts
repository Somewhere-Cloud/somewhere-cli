import { Command } from 'commander';
import { cliConfigPathForDisplay, loadConfig, temporaryConfigExpired } from '../lib/config.js';
import { error, info, printJson, teal } from '../lib/output.js';

/** `somewhere claim`: the claim URL of this computer's temporary workspace,
 *  for a signed-out person who deployed and wants to keep the app
 *. Reads the local credential only; nothing is sent. */
export function registerClaim(program: Command) {
  program
    .command('claim')
    .description("Print the claim URL that keeps this computer's temporary (signed-out) projects")
    .option('--json', 'Print { claim_url, expires_at } as JSON')
    .action((opts: { json?: boolean }) => {
      const config = loadConfig();
      if (!config?.temporary || !config.claim_url) {
        const message = config?.token
          ? 'This computer is signed in to an account, so there is nothing to claim: its projects are already yours (`somewhere projects`).'
          : `This computer has no temporary workspace (nothing in ${cliConfigPathForDisplay()}). If you deployed signed out from another terminal, run \`somewhere claim\` there; or run \`somewhere deploy\` here to start one.`;
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
      if (expired) {
        error(`This computer's temporary workspace expired at ${config.temp_expires_at}; unclaimed projects are gone. Run \`somewhere deploy\` to start a new one.`);
        process.exit(1);
      }
      info(`Claim URL: ${teal(config.claim_url)}`);
      if (config.temp_expires_at) info(`Expires at: ${config.temp_expires_at} (UTC)`);
      info('Open it in a browser and sign in (or create an account) to keep these projects. Choose "Save project and connect agent" to sign this CLI in as well; otherwise run `somewhere login` here afterwards.');
    });
}
