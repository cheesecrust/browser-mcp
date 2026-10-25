import * as z from 'zod/v4';
import { UserError } from '../browser.js';
import type { HandoffBroker, HandoffSummary } from '../handoff.js';
import { type ToolRegistrar } from './common.js';

function clock(at: number): string {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function describe(summary: HandoffSummary, fresh: boolean, showing: string): string {
  const minutesLeft = Math.max(0, Math.round((summary.expiresAt - Date.now()) / 60_000));
  return [
    fresh ? 'Hand-over link created.' : 'A hand-over link is already active; here it is again.',
    '',
    summary.url,
    '',
    `The person will see the active tab, currently: ${showing}`,
    `Give this link to the person and ask them to: open it, finish the step in the page they see (${summary.reason ?? 'log in or pass the check'}), then press 완료. ` +
      `It stops working after ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'} (${clock(summary.expiresAt)}) or once they press 완료.`,
    'Do not call other browser tools until they say they are done; then call browser_snapshot to continue from where they left the page.',
  ].join('\n');
}

export function registerHandoffTools(tool: ToolRegistrar, broker: HandoffBroker): void {
  tool(
    'browser_request_human',
    {
      title: 'Hand over to a person',
      description:
        'Give the person a link to see this browser live and operate it themselves: for logging in, solving a CAPTCHA, passing a "verify you are human" check or any step the agent must not do on their behalf. ' +
        'Returns a private, short-lived URL to show the person. When they are done they press 완료 in that page and the agent continues with the same browser (their login stays). ' +
        'Calling it again while a link is active returns the same link together with whether the person has finished.',
      input: {
        reason: z
          .string()
          .max(200)
          .optional()
          .describe('One short sentence shown to the person explaining what to do, e.g. "네이버 로그인 후 보안 문자를 풀어 주세요".'),
        minutes: z.number().int().min(1).max(30).optional().describe('How long the link stays valid (default 10).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ reason, minutes }, session) => {
      const previous = broker.current();
      // Make sure there is something to show: the browser is running with a tab that has a page in it.
      const page = await session.page();
      const url = page.url();
      if (!url || url === 'about:blank') {
        throw new UserError(
          'The active tab is blank, so the person would see an empty screen. Open the page first with browser_navigate ' +
            '(the browser may have been restarted, which closes its tabs), then call browser_request_human again.',
        );
      }
      const title = await page.title().catch(() => '');
      const showing = `${title ? `"${title}" ` : ''}${url}`;
      if (previous?.state === 'active' && previous.expiresAt > Date.now()) return describe(previous, false, showing);
      const summary = broker.open({ reason, minutes });
      const prefix =
        previous?.state === 'finished' && previous.finishedAt
          ? `The person finished the previous hand-over at ${clock(previous.finishedAt)}; call browser_snapshot if you only wanted to continue.\n\n`
          : '';
      return prefix + describe(summary, true, showing);
    },
  );
}
