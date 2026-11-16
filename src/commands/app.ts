import { Command } from 'commander';
import {
  AppMcpCliError,
  appLogin,
  appLogout,
  callTool,
  inputShape,
  listTools,
  redactTokens,
} from '../lib/app-mcp.js';
import { bold, dim, error, printJsonError, success, warn } from '../lib/output.js';

interface JsonOption { json?: boolean }

// Everything these commands print passes through redactTokens: an app can echo the
// token it received in a result or an error, and the terminal never shows one.
function printJson(value: unknown): void {
  console.log(redactTokens(JSON.stringify(value ?? null, null, 2)));
}

function fail(err: unknown, json: boolean | undefined): void {
  const message = redactTokens(err instanceof Error ? err.message : String(err));
  if (json) printJsonError(err instanceof AppMcpCliError ? err.code : 'CLI_ERROR', message);
  else error(message, err);
  process.exitCode = 1;
}

export function registerApp(program: Command): void {
  const app = program
    .command('app')
    .description('Sign in to an app built on Somewhere as its user, and call its MCP tools from this terminal')
    .addHelpText('after', `
Sign-in opens a browser on this computer, where you sign in to the app and approve
this terminal. Signing in over SSH, in a container or in a headless shell is not supported.
Your app sign-in is kept apart from your Somewhere developer login and is sent only to that app.
Signing out of the app in the browser also ends the terminal's access.

Examples:
  somewhere app login https://notes.somewhere.site
  somewhere app tools https://notes.somewhere.site
  somewhere app call https://notes.somewhere.site add_note '{"text":"hello"}'
  somewhere app logout https://notes.somewhere.site`);

  app
    .command('login <app-url>')
    .description('Sign in to the app in your browser and approve this terminal')
    .option('--json', 'Print the outcome as JSON')
    .action(async (url: string, opts: JsonOption) => {
      try {
        const result = await appLogin(url, (line) => (opts.json ? process.stderr : process.stdout).write(`  ${line}\n`));
        if (opts.json) printJson({ ok: true, origin: result.origin, client_reused: result.clientReused });
        else {
          success(`Signed in to ${result.origin}.`);
          console.log(dim(`  Next: somewhere app tools ${result.origin}`));
        }
      } catch (err) {
        fail(err, opts.json);
      }
    });

  app
    .command('tools <app-url>')
    .description('List the tools the app offers you: name, description and arguments')
    .option('--json', 'Print the tool list as JSON')
    .action(async (url: string, opts: JsonOption) => {
      try {
        const tools = await listTools(url);
        if (opts.json) {
          printJson(tools);
          return;
        }
        if (!tools.length) {
          console.log(dim('This app offers no tools to your sign-in.'));
          return;
        }
        for (const tool of tools) {
          console.log(bold(tool.name));
          if (tool.description) console.log(redactTokens(`  ${tool.description}`));
          console.log(dim(`  arguments: ${inputShape(tool)}`));
        }
      } catch (err) {
        fail(err, opts.json);
      }
    });

  app
    .command('call <app-url> <tool> [json]')
    .description('Call one of the app\'s tools with JSON arguments and print the result')
    .option('--json', 'Print the complete MCP result as JSON')
    .action(async (url: string, tool: string, json: string | undefined, opts: JsonOption) => {
      try {
        let args: unknown = {};
        if (json !== undefined) {
          try {
            args = JSON.parse(json);
          } catch {
            throw new AppMcpCliError(`The arguments are not valid JSON: ${json}`, 'INVALID_ARGUMENTS');
          }
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new AppMcpCliError('The arguments must be a JSON object, for example \'{"text":"hello"}\'.', 'INVALID_ARGUMENTS');
        }
        const { result } = await callTool(url, tool, args as Record<string, unknown>);
        const text = (result.content ?? []).filter((item) => item.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n');
        if (opts.json) {
          printJson(result);
          if (result.isError) process.exitCode = 1;
          return;
        }
        if (result.isError) {
          error(redactTokens(`${tool} failed: ${text || 'the app returned an error with no message.'}`));
          process.exitCode = 1;
          return;
        }
        if (result.structuredContent !== undefined) printJson(result.structuredContent);
        else console.log(redactTokens(text));
      } catch (err) {
        fail(err, opts.json);
      }
    });

  app
    .command('logout <app-url>')
    .description('Revoke this terminal\'s access to the app and remove the stored sign-in')
    .option('--json', 'Print the outcome as JSON')
    .action(async (url: string, opts: JsonOption) => {
      try {
        const result = await appLogout(url);
        // The local copy is gone either way; a refused revoke still fails the command.
        if (result.signedIn && !result.revoked) process.exitCode = 1;
        if (opts.json) {
          printJson({ ok: result.revoked || !result.signedIn, origin: result.origin, was_signed_in: result.signedIn, revoked: result.revoked, ...(result.revokeProblem ? { revoke_problem: result.revokeProblem } : {}) });
          return;
        }
        if (!result.signedIn) {
          console.log(dim(`Not signed in to ${result.origin}; nothing to remove.`));
          return;
        }
        if (!result.revoked) {
          warn(redactTokens(`Could not revoke the sign-in at the server (${result.revokeProblem}). It stays valid there until it expires or you sign out of the app in the browser.`));
        }
        success(`Removed the sign-in to ${result.origin} from this computer${result.revoked ? ' and revoked it at the server' : ''}.`);
      } catch (err) {
        fail(err, opts.json);
      }
    });
}
