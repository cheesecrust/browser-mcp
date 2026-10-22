import { access } from 'node:fs/promises';
import * as z from 'zod/v4';
import { describeTarget, UserError } from '../browser.js';
import { ACTION, pageResult, performAction, settle, targetInput, type ToolRegistrar } from './common.js';

export function registerInteractionTools(tool: ToolRegistrar): void {
  tool(
    'browser_click',
    {
      title: 'Click',
      description: 'Click an element (by snapshot ref or selector) and return the updated page snapshot.',
      input: {
        ...targetInput,
        button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left).'),
        doubleClick: z.boolean().optional().describe('Double-click instead of a single click.'),
        modifiers: z
          .array(z.enum(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift']))
          .optional()
          .describe('Modifier keys held while clicking.'),
      },
      annotations: ACTION,
    },
    async (args, session) => {
      const page = await session.page();
      const locator = session.resolveTarget(page, args);
      const options = { button: args.button, modifiers: args.modifiers };
      return performAction(
        session,
        page,
        `${args.doubleClick ? 'Double-clicked' : 'Clicked'} ${describeTarget(args)}.`,
        () => (args.doubleClick ? locator.dblclick(options) : locator.click(options)),
      );
    },
  );

  tool(
    'browser_type',
    {
      title: 'Type text',
      description:
        'Type text into an editable element (input, textarea, contenteditable). Replaces the existing value unless clear is false. Set submit to press Enter afterwards.',
      input: {
        ...targetInput,
        text: z.string().describe('Text to type.'),
        submit: z.boolean().optional().describe('Press Enter after typing (submits most forms).'),
        slowly: z
          .boolean()
          .optional()
          .describe('Type one character at a time, firing key events (needed for autocomplete or masked inputs).'),
        clear: z.boolean().optional().describe('Clear the current value first (default true). false appends.'),
      },
      annotations: ACTION,
    },
    async (args, session) => {
      const page = await session.page();
      const locator = session.resolveTarget(page, args);
      const clear = args.clear !== false;
      const message = `Typed ${JSON.stringify(args.text)} into ${describeTarget(args)}${
        args.submit ? ' and pressed Enter' : ''
      }.`;
      return performAction(session, page, message, async () => {
        if (args.slowly || !clear) {
          await locator.click();
          if (clear) await locator.fill('');
          else await locator.press('End');
          await locator.pressSequentially(args.text);
        } else {
          await locator.fill(args.text);
        }
        if (args.submit) await locator.press('Enter');
      });
    },
  );

  tool(
    'browser_press_key',
    {
      title: 'Press key',
      description:
        'Press a keyboard key or combination, e.g. "Enter", "Tab", "Escape", "ArrowDown", "Backspace", "a", "Control+a", "Shift+Tab". Sent to the given element, or to the focused element when no target is given.',
      input: {
        key: z.string().describe('Key name as understood by Playwright (keyboard.press).'),
        ...targetInput,
      },
      annotations: ACTION,
    },
    async (args, session) => {
      const page = await session.page();
      const targeted = Boolean(args.ref || args.selector);
      const action = targeted
        ? () => session.resolveTarget(page, args).press(args.key)
        : () => page.keyboard.press(args.key);
      return performAction(
        session,
        page,
        `Pressed ${args.key}${targeted ? ` on ${describeTarget(args)}` : ''}.`,
        action,
      );
    },
  );

  tool(
    'browser_hover',
    {
      title: 'Hover',
      description: 'Move the mouse over an element (reveals hover menus and tooltips) and return the updated snapshot.',
      input: { ...targetInput },
      annotations: ACTION,
    },
    async (args, session) => {
      const page = await session.page();
      const locator = session.resolveTarget(page, args);
      return performAction(session, page, `Hovered over ${describeTarget(args)}.`, () => locator.hover());
    },
  );

  tool(
    'browser_select_option',
    {
      title: 'Select option',
      description: 'Choose option(s) in a <select> element by value or by visible label.',
      input: {
        ...targetInput,
        values: z
          .array(z.string())
          .min(1)
          .describe('Option value(s) or label(s) to select. Several values only apply to multi-selects.'),
      },
      annotations: ACTION,
    },
    async (args, session) => {
      const page = await session.page();
      const locator = session.resolveTarget(page, args);
      return performAction(
        session,
        page,
        `Selected ${args.values.map((v) => JSON.stringify(v)).join(', ')} in ${describeTarget(args)}.`,
        async () => {
          const selected = await locator.selectOption(args.values);
          if (selected.length === 0) throw new UserError('No option matched the given values.');
        },
      );
    },
  );

  tool(
    'browser_scroll',
    {
      title: 'Scroll',
      description:
        'Scroll the page by a distance, or scroll an element into view when ref or selector is given. Returns the new scroll position.',
      input: {
        ...targetInput,
        direction: z.enum(['down', 'up', 'left', 'right']).optional().describe('Scroll direction (default down).'),
        amount: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Distance in pixels (default: 80% of the viewport in the scroll direction).'),
      },
      annotations: ACTION,
    },
    async (args, session) => {
      const page = await session.page();
      session.assertNoDialog(page);
      let message: string;
      if (args.ref || args.selector) {
        await session.resolveTarget(page, args).scrollIntoViewIfNeeded();
        message = `Scrolled ${describeTarget(args)} into view.`;
      } else {
        const direction = args.direction ?? 'down';
        const viewport = page.viewportSize() ?? session.config.viewport;
        const horizontal = direction === 'left' || direction === 'right';
        const amount = args.amount ?? Math.round((horizontal ? viewport.width : viewport.height) * 0.8);
        const [dx, dy] =
          direction === 'down'
            ? [0, amount]
            : direction === 'up'
              ? [0, -amount]
              : direction === 'right'
                ? [amount, 0]
                : [-amount, 0];
        await page.mouse.wheel(dx, dy);
        await page.waitForTimeout(150);
        message = `Scrolled ${direction} by ${amount}px.`;
      }
      const position = await page
        .evaluate(() => ({
          x: Math.round(window.scrollX),
          y: Math.round(window.scrollY),
          maxX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
          maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
        }))
        .catch(() => undefined);
      const where = position
        ? ` Scroll position: x=${position.x}/${position.maxX}, y=${position.y}/${position.maxY}${
            position.y >= position.maxY ? ' (bottom reached)' : ''
          }.`
        : '';
      return `${message}${where}`;
    },
  );

  tool(
    'browser_drag',
    {
      title: 'Drag and drop',
      description: 'Drag one element and drop it onto another.',
      input: {
        sourceRef: z.string().optional().describe('Ref of the element to drag.'),
        sourceSelector: z.string().optional().describe('Selector of the element to drag (when no sourceRef).'),
        targetRef: z.string().optional().describe('Ref of the drop target.'),
        targetSelector: z.string().optional().describe('Selector of the drop target (when no targetRef).'),
      },
      annotations: ACTION,
    },
    async (args, session) => {
      const page = await session.page();
      const source = { ref: args.sourceRef, selector: args.sourceSelector };
      const target = { ref: args.targetRef, selector: args.targetSelector };
      const from = session.resolveTarget(page, source);
      const to = session.resolveTarget(page, target);
      return performAction(
        session,
        page,
        `Dragged ${describeTarget(source)} onto ${describeTarget(target)}.`,
        () => from.dragTo(to),
      );
    },
  );

  tool(
    'browser_file_upload',
    {
      title: 'Upload files',
      description: 'Set the files of an <input type="file"> element. Pass an empty list to clear the selection.',
      input: {
        ...targetInput,
        paths: z
          .array(z.string())
          .describe('Paths of local files to upload (absolute; on a shared server, relative to the files folder of your workspace).'),
      },
      annotations: ACTION,
    },
    async (args, session) => {
      const page = await session.page();
      session.assertNoDialog(page);
      const files = args.paths.map((file) => session.resolvePath(file, 'files'));
      for (const file of files) {
        await access(file).catch(() => {
          throw new UserError(`File not found: ${session.displayPath(file)}`);
        });
      }
      await session.resolveTarget(page, args).setInputFiles(files);
      const count = files.length;
      return `Set ${count} file${count === 1 ? '' : 's'} on ${describeTarget(args)}${
        count ? `: ${files.map((file) => session.displayPath(file)).join(', ')}` : ''
      }.`;
    },
  );

  tool(
    'browser_wait_for',
    {
      title: 'Wait for',
      description:
        'Wait until a condition holds: text appears or disappears, an element reaches a state, the page reaches a load state, or a fixed time passes. Then return the snapshot.',
      input: {
        text: z.string().optional().describe('Wait until this text is visible somewhere on the page.'),
        textGone: z.string().optional().describe('Wait until this text is no longer visible.'),
        selector: z.string().optional().describe('Wait for an element matching this selector.'),
        state: z
          .enum(['visible', 'hidden', 'attached', 'detached'])
          .optional()
          .describe('State the selector must reach (default visible).'),
        loadState: z
          .enum(['load', 'domcontentloaded', 'networkidle'])
          .optional()
          .describe('Wait until the page reaches this load state.'),
        timeMs: z.number().int().min(0).max(60_000).optional().describe('Wait this many milliseconds unconditionally.'),
        timeout: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum wait in milliseconds (default: server action timeout).'),
      },
      annotations: ACTION,
    },
    async (args, session) => {
      const page = await session.page();
      session.assertNoDialog(page);
      const timeout = args.timeout ?? session.config.actionTimeout;
      const done: string[] = [];
      if (args.timeMs !== undefined) {
        await page.waitForTimeout(args.timeMs);
        done.push(`waited ${args.timeMs}ms`);
      }
      if (args.loadState) {
        await page.waitForLoadState(args.loadState, { timeout });
        done.push(`page reached "${args.loadState}"`);
      }
      if (args.text !== undefined) {
        await page.getByText(args.text).first().waitFor({ state: 'visible', timeout });
        done.push(`text ${JSON.stringify(args.text)} is visible`);
      }
      if (args.textGone !== undefined) {
        await page.getByText(args.textGone).first().waitFor({ state: 'hidden', timeout });
        done.push(`text ${JSON.stringify(args.textGone)} is gone`);
      }
      if (args.selector !== undefined) {
        const state = args.state ?? 'visible';
        await page.locator(args.selector).first().waitFor({ state, timeout });
        done.push(`${JSON.stringify(args.selector)} is ${state}`);
      }
      if (done.length === 0) {
        throw new UserError('Specify at least one of text, textGone, selector, loadState or timeMs.');
      }
      return pageResult(session, page, `Done waiting: ${done.join('; ')}.`);
    },
  );

  tool(
    'browser_handle_dialog',
    {
      title: 'Handle dialog',
      description:
        'Accept or dismiss the open alert/confirm/prompt dialog on the active tab. Other tools refuse to run while a dialog is open.',
      input: {
        accept: z.boolean().describe('true to accept (OK), false to dismiss (Cancel).'),
        promptText: z.string().optional().describe('Text to enter when the dialog is a prompt (only used with accept).'),
      },
      annotations: ACTION,
    },
    async ({ accept, promptText }, session) => {
      const page = await session.page();
      const message = await session.handleDialog(page, accept, promptText);
      // Give a chained dialog (alert after confirm, etc.) a moment to register before describing the page.
      await page.waitForTimeout(100);
      await settle(page);
      return pageResult(session, page, message);
    },
  );
}
