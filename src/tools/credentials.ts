import * as z from 'zod/v4';
import { describeTarget, UserError } from '../browser.js';
import { hostMatches, type CredentialBroker, type CredentialInfo } from '../vault.js';
import { ACTION, performAction, targetInput, type ToolRegistrar } from './common.js';

function listText(entries: CredentialInfo[]): string {
  if (entries.length === 0) return 'No logins are saved yet.';
  return ['Saved logins (name - site - user):', ...entries.map((entry) => `- ${entry.name} - ${entry.domain} - ${entry.usernameHint}`)].join('\n');
}

export function registerCredentialTools(tool: ToolRegistrar, broker: CredentialBroker): void {
  tool(
    'browser_request_credentials',
    {
      title: 'Saved logins',
      description:
        'List the logins the person has saved for this browser, and give them a link to add or remove one. The agent never sees the user name or password: ' +
        'browser_fill_credential types them into the login page on the server side. Use this when a site asks for a login and no saved entry matches; ' +
        'show the person the link and ask them to store the account, then continue.',
      input: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const entries = await broker.list();
      const { url, expiresAt } = broker.link();
      const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
      return [
        listText(entries),
        '',
        `Link for the person to add or remove logins (valid ${minutes} min, nobody else can use it):`,
        url,
        '',
        'Tell the person the link; after they save the account, use browser_fill_credential with the name they chose. Never ask the person to type a password into the chat.',
      ].join('\n');
    },
  );

  tool(
    'browser_fill_credential',
    {
      title: 'Fill saved login',
      description:
        'Type a saved user name or password into a field of the login page without revealing it. The active tab must be on the site the login was saved for (same domain, HTTPS), ' +
        'otherwise the call is refused. Call it once for the user name field and once for the password field; set submit on the last one to press Enter.',
      input: {
        name: z.string().describe('Name of the saved login, as listed by browser_request_credentials (e.g. "naver").'),
        field: z.enum(['username', 'password']).describe('Which value to type.'),
        ...targetInput,
        submit: z.boolean().optional().describe('Press Enter after typing (submits most forms).'),
      },
      annotations: ACTION,
    },
    async (args, session) => {
      const page = await session.page();
      const credential = await broker.get(args.name.trim().toLowerCase());
      if (!credential) {
        const entries = await broker.list();
        throw new UserError(`No saved login named "${args.name}". ${listText(entries)}\nCall browser_request_credentials to get a link for the person to add it.`);
      }
      const verdict = hostMatches(page.url(), credential.domain);
      if (!verdict.ok) throw new UserError(`Refused to type the ${args.field} for "${args.name}": ${verdict.reason}.`);
      const locator = session.resolveTarget(page, args);
      const value = args.field === 'username' ? credential.username : credential.password;
      const message = `Typed the saved ${args.field} for "${args.name}" into ${describeTarget(args)}${args.submit ? ' and pressed Enter' : ''}.`;
      return performAction(session, page, message, async () => {
        await locator.click();
        await locator.fill(value);
        if (args.submit) await locator.press('Enter');
      });
    },
  );
}
