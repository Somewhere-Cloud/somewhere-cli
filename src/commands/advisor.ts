import {callAdvisorRun,consumeAdvisorRun} from '../lib/advisor-runs.js';
import { Command } from 'commander';
import { error, printJson } from '../lib/output.js';
import { callPlatformHelpTool } from '../lib/platform-tools.js';
import { getToken, loadConfig, loadProjectConfig } from '../lib/config.js';
import { ApiClient } from '../lib/client.js';
import { clearAdvisorTurns, gatherAdvisorApp, loadAdvisorTurns, saveAdvisorTurn } from '../lib/advisor-app.js';
import { fetchWithProxy } from '../lib/http.js';
import {
  buildAdvisorContext,
  contextNotice,
  type AdvisorContext,
} from '../lib/advisor-context.js';
export { callPlatformHelpTool };

const ADVISOR_TIMEOUT_MS = 60_000;
const MCP_BASE_URL =
  process.env.SOMEWHERE_MCP_URL?.replace(/\/$/, '') || 'https://mcp.somewhere.cloud/mcp';

function publicAdvisorUrl(): string {
  const url = new URL(MCP_BASE_URL);
  url.pathname = '/advisor';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Anonymous callers cannot authorize a linked project. Keep explicitly
 * attached, redacted local context while removing that private identity. */
export function anonymousAdvisorContext(context: AdvisorContext | undefined): AdvisorContext | undefined {
  if (!context) return undefined;
  const { project_ref: _projectRef, ...publicContext } = context;
  return Object.keys(publicContext).length > 0 ? publicContext : undefined;
}

interface PublicAdvisorResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  data?: { answer?: string;run_id?:string;status?:string;anonymous_capability?:string };
}

export async function callAnonymousAdvisor(
  question: string,
  context?: AdvisorContext,
): Promise<string> {
  const res = await fetchWithProxy(publicAdvisorUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'somewhere-cli',
    },
    body: JSON.stringify({ question, ...(context ? { context } : {}) }),
  }, ADVISOR_TIMEOUT_MS);
  let payload: PublicAdvisorResponse;
  try {
    payload = await res.json() as PublicAdvisorResponse;
  } catch {
    throw new Error(`Advisor returned an invalid response (HTTP ${res.status}).`);
  }
  if (!res.ok || payload.ok !== true) {
    const message = payload.message || 'The advisor could not answer right now.';
    const detail = [payload.error, `HTTP ${res.status}`].filter(Boolean).join(', ');
    throw new Error(`${message}${detail ? ` [${detail}]` : ''}`);
  }
  const answer = payload.data?.answer;
  if(!answer&&payload.data?.run_id){const run=await consumeAdvisorRun(JSON.stringify(payload.data),message=>process.stderr.write(message+'\n'));if(run?.incomplete)process.exitCode=1;if(run?.answer)return run.answer;throw new Error('Advisor run remains incomplete. Resume the saved request.');}
  if (!answer) throw new Error('Advisor returned an empty response.');
  return answer;
}

export function registerAdvisor(program: Command): void {
  program
    .command('advisor [question]')
    .description('Ask the somewhere.cloud platform advisor; local context is attached only with --file')
    .option('--async', 'Use the durable Advisor candidate when enabled by the server')
    .option('--resume <request-id>', 'Reconnect to the same saved Advisor request')
    .option('--status <request-id>', 'Read one saved Advisor request status')
    .option('--cancel <request-id>', 'Request cancellation of a saved Advisor run')
    .option('--json', 'Print the advisor response in a JSON envelope')
    .option('--file <path>', 'Attach a trimmed, redacted local file as context')
    .option('--no-context', "Send nothing but the question: not this folder's app, earlier questions, or a --file")
    .option('--new', 'Start a new conversation in this folder (forget the earlier questions)')
    .action(async (question: string, opts: { json?: boolean; file?: string; context?: boolean; async?:boolean;resume?:string;status?:string;cancel?:string; new?: boolean }) => {
      try {
        if(opts.async||opts.resume||opts.status||opts.cancel){
          if([opts.resume,opts.status,opts.cancel].filter(Boolean).length>1)throw new Error('Use one resume, status or cancel operation.');
          if(opts.file)throw new Error('File excerpts are not retained by the durable Advisor candidate. Supply the question and command diagnostics.');
          const config=loadConfig(),localContext=opts.context===false?undefined:buildAdvisorContext(),context=config?.token&&config.temporary!==true?localContext:anonymousAdvisorContext(localContext);
          const result=await callAdvisorRun({question,context,requestId:opts.resume??opts.status??opts.cancel,operation:opts.cancel?'cancel':opts.status?'status':'resume',wait:!opts.cancel&&!opts.status,progress:message=>process.stderr.write(message+'\n')});
          if(opts.json)printJson(result);else process.stdout.write((result.answer??JSON.stringify(result))+'\n');
          if(result.incomplete)process.exitCode=1;
          return;
        }
        if(!question)throw new Error('Supply a question or a saved request to resume.');
        const config = loadConfig();
        const permanentCredential = !!config?.token && config.temporary !== true;
        const localContext = opts.context === false ? undefined : buildAdvisorContext(opts.file);
        const context = permanentCredential ? localContext : anonymousAdvisorContext(localContext);
        process.stderr.write(`${contextNotice(context)}\n`);
        // In a folder linked to an app, the CLI reads that app with the user's own sign-in and sends it; the Advisor
        // reads nothing and keeps nothing. Follow-ups live in this folder only, for this app and this account.
        const linked = opts.context === false ? undefined : loadProjectConfig()?.project_id;
        if (linked && !permanentCredential) process.stderr.write("Not signed in, so this folder's app was not sent: `somewhere login` lets the Advisor answer about it.\n");
        const account = permanentCredential ? config?.user?.email ?? null : null;
        const app = linked && permanentCredential ? await gatherAdvisorApp(new ApiClient(getToken()), linked).catch((err: unknown) => {
          process.stderr.write(`Could not read this folder's app (${err instanceof Error ? err.message : String(err)}); asking with the question only.\n`);
          return null;
        }) : null;
        if (opts.new && app) clearAdvisorTurns(process.cwd());
        const earlier = app && account ? loadAdvisorTurns(process.cwd(), app.projectId, account) : [];
        const sentWhat = app ? [app.app_overview ? "this app's overview" : null, app.last_deploy ? 'its last deploy' : null].filter(Boolean).join(' and ') : '';
        if (app) process.stderr.write(`Sent ${sentWhat || 'nothing about this app (it could not be summarized)'}, read with your sign-in${earlier.length ? `, and ${earlier.length} earlier question${earlier.length === 1 ? '' : 's'} from this folder` : ''} (--no-context sends only the question; --new forgets the earlier questions).\n`);
        const sent = app ? { ...(context ?? {}), ...(app.app_overview ? { app_overview: app.app_overview } : {}), ...(app.last_deploy ? { last_deploy: app.last_deploy } : {}), ...(earlier.length ? { earlier: earlier.map(({ question: q, answer: a }) => ({ question: q, answer: a })) } : {}) } : context;
        // Only permanent credentials authorize the authenticated MCP path.
        // Temporary deploy credentials use the public advisor's IP gate, while
        // an expired or rejected permanent credential still fails closed here.
        let answer = permanentCredential
          ? await callPlatformHelpTool('advisor', {
            question,
            ...(sent ? { context: sent } : {}),
          })
          : await callAnonymousAdvisor(question, context);
        if(permanentCredential){const run=await consumeAdvisorRun(answer,message=>process.stderr.write(message+'\n'));if(run){if(run.incomplete)process.exitCode=1;answer=run.answer??JSON.stringify(run);}}
        if (app && account && !/^\s*\{\s*"ok"\s*:\s*false/.test(answer)) saveAdvisorTurn(process.cwd(), app.projectId, account, earlier, { question, answer, at: Date.now() });
        if (opts.json) {
          printJson({ question, answer });
        } else {
          process.stdout.write(answer.endsWith('\n') ? answer : `${answer}\n`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err), err);
        process.exitCode = 1;
      }
    });
}
