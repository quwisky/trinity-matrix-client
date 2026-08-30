import {
  enter,
  pickFiles,
  png,
  renderComposer,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { beforeEach, describe, expect, it } from 'vitest';
import { SLASH_COMMANDS } from '@trinity/util/matrix';
import {
  MessageComposerComponent,
  type ComposerSubmit,
} from './message-composer.component';

describe('MessageComposerComponent — the @mention and /command autocompletes', () => {
  beforeEach(() => stubObjectUrls());

  describe('mention autocomplete', () => {
    const MEMBERS = [
      { userId: '@alice:hs', roomDisplayName: 'Alice' },
      { userId: '@bob:hs', roomDisplayName: 'Bob' },
    ];

    it('opens the member menu for an @query and inserts the pick', async () => {
      const { fixture, container } = await renderComposer({ members: MEMBERS });
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;

      ta.value = 'hey @al';
      ta.selectionStart = ta.selectionEnd = 7;
      cmp.onInput({ target: ta } as unknown as Event);

      // Only Alice matches "al"; the menu is open.
      expect(cmp.menus.mentionOpen()).toBe(true);
      expect(cmp.menus.mentionMatches().map((m) => m.userId)).toEqual([
        '@alice:hs',
      ]);

      ta.selectionStart = 7;
      cmp.menus.acceptMention();

      expect(cmp.text()).toBe('hey @Alice ');
      expect(cmp.menus.mentionOpen()).toBe(false);
    });

    it('emits the @-mentioned users on submit', async () => {
      const { fixture, container } = await renderComposer({ members: MEMBERS });
      const cmp = fixture.componentInstance;
      let submit: ComposerSubmit | undefined;
      cmp.submitText.subscribe((e) => (submit = e));

      const ta = container.querySelector('textarea') as HTMLTextAreaElement;
      ta.value = 'hi @al';
      ta.selectionStart = ta.selectionEnd = 6;
      cmp.onInput({ target: ta } as unknown as Event);
      ta.selectionStart = 6;
      cmp.menus.acceptMention();

      cmp.onEnter(enter());

      expect(submit?.text).toBe('hi @Alice');
      expect(submit?.mentions).toEqual([
        { userId: '@alice:hs', display: '@Alice' },
      ]);
    });

    it('drops a mention whose text was deleted before sending', async () => {
      const { fixture, container } = await renderComposer({ members: MEMBERS });
      const cmp = fixture.componentInstance;
      let submit: ComposerSubmit | undefined;
      cmp.submitText.subscribe((e) => (submit = e));

      const ta = container.querySelector('textarea') as HTMLTextAreaElement;
      ta.value = '@al';
      ta.selectionStart = ta.selectionEnd = 3;
      cmp.onInput({ target: ta } as unknown as Event);
      ta.selectionStart = 3;
      cmp.menus.acceptMention(); // text = "@Alice "

      // The user deletes the mention text before sending.
      cmp.text.set('never mind');
      cmp.onEnter(enter());

      expect(submit?.text).toBe('never mind');
      expect(submit?.mentions).toEqual([]);
    });

    it('does not open the menu for an @ inside a word (e.g. an email)', async () => {
      const { fixture, container } = await renderComposer({ members: MEMBERS });
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;

      ta.value = 'mail a@bob';
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      cmp.onInput({ target: ta } as unknown as Event);

      expect(cmp.menus.mentionOpen()).toBe(false); // '@' not at a word boundary
    });

    it('navigates the menu with the arrow keys and accepts with Tab', async () => {
      const { fixture, container } = await renderComposer({ members: MEMBERS });
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;

      ta.value = '@';
      ta.selectionStart = ta.selectionEnd = 1;
      cmp.onInput({ target: ta } as unknown as Event);
      expect(cmp.menus.mentionMatches().map((m) => m.roomDisplayName)).toEqual([
        'Alice',
        'Bob',
      ]);

      cmp.onArrowDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(cmp.menus.mentionActiveIndex()).toBe(1); // Bob highlighted

      ta.selectionStart = 1;
      cmp.onTab(new KeyboardEvent('keydown', { key: 'Tab' }));
      expect(cmp.text()).toBe('@Bob ');
    });

    it('forgets tracked mentions when the conversation changes', async () => {
      const { fixture, container } = await renderComposer({
        roomId: '!a:hs',
        members: MEMBERS,
      });
      const cmp = fixture.componentInstance;
      let submit: ComposerSubmit | undefined;
      cmp.submitText.subscribe((e) => (submit = e));

      const ta = container.querySelector('textarea') as HTMLTextAreaElement;
      ta.value = '@al';
      ta.selectionStart = ta.selectionEnd = 3;
      cmp.onInput({ target: ta } as unknown as Event);
      ta.selectionStart = 3;
      cmp.menus.acceptMention(); // tracks @Alice for room A

      // Switch rooms, then type similar text by hand (not via the menu).
      fixture.componentRef.setInput('roomId', '!b:hs');
      fixture.detectChanges();
      cmp.text.set('@Alice again');
      cmp.onEnter(enter());

      expect(submit?.mentions).toEqual([]); // the old room's tracking was dropped
    });
  });

  describe('slash autocomplete', () => {
    /** Type `value` into the real textarea and put the caret at its end. */
    function typeSlash(
      cmp: MessageComposerComponent,
      ta: HTMLTextAreaElement,
      value: string,
    ): void {
      ta.value = value;
      ta.selectionStart = ta.selectionEnd = value.length;
      cmp.onInput({ target: ta } as unknown as Event);
    }

    it('opens on a bare slash at the start and completes the pick with a trailing space', async () => {
      const { fixture, container } = await renderComposer();
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;

      typeSlash(cmp, ta, '/');
      expect(cmp.menus.slashOpen()).toBe(true);
      expect(cmp.menus.slashMatches().length).toBe(SLASH_COMMANDS.length);

      typeSlash(cmp, ta, '/shr');
      expect(cmp.menus.slashMatches().map((c) => c.name)).toEqual(['shrug']);

      cmp.onEnter(enter());

      // The trailing space matters: `parseSlashCommand` needs it before it reads an argument.
      expect(cmp.text()).toBe('/shrug ');
      expect(cmp.menus.slashOpen()).toBe(false);
    });

    it('does not send the message while the menu is open', async () => {
      const { fixture, container } = await renderComposer();
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;
      let sent = 0;
      cmp.submitText.subscribe(() => sent++);

      typeSlash(cmp, ta, '/me');
      cmp.onEnter(enter());
      expect(sent).toBe(0);

      // …and once accepted, the next Enter sends as normal.
      typeSlash(cmp, ta, '/me waves');
      cmp.onEnter(enter());
      expect(sent).toBe(1);
    });

    it('never offers a command mid-message, where the send path would not parse one', async () => {
      const { fixture, container } = await renderComposer();
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;

      typeSlash(cmp, ta, 'and/or');
      expect(cmp.menus.slashOpen()).toBe(false);

      typeSlash(cmp, ta, 'see /me');
      expect(cmp.menus.slashOpen()).toBe(false);
    });

    it('moves the highlight with both arrow keys before accepting', async () => {
      const { fixture, container } = await renderComposer();
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;

      typeSlash(cmp, ta, '/');
      cmp.onArrowDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(cmp.menus.slashActiveIndex()).toBe(1);
      cmp.onArrowUp(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      expect(cmp.menus.slashActiveIndex()).toBe(0);

      cmp.onTab(new KeyboardEvent('keydown', { key: 'Tab' }));
      expect(cmp.text()).toBe(`/${SLASH_COMMANDS[0].name} `);
    });

    it('ArrowUp claims the key from the textarea while the menu is open', async () => {
      // Unclaimed, ArrowUp is the textarea's own "move up a line", which moves the caret off
      // the fragment the menu is anchored to — so the highlight has to consume the key.
      const { fixture, container } = await renderComposer();
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;

      typeSlash(cmp, ta, '/');
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        cancelable: true,
      });
      cmp.onArrowUp(event);

      expect(event.defaultPrevented).toBe(true);
      expect(cmp.menus.slashActiveIndex()).toBe(SLASH_COMMANDS.length - 1);
    });

    it('closes on Escape before anything else the key would cancel', async () => {
      // Against the emoji PICKER rather than a reply, which is what this used to use: a reply
      // is now one of the three states that offers no commands at all, so the menu could never
      // have been open to be closed first. The rung order is the same claim either way — the
      // slash menu sits above the picker, and one Escape takes exactly one thing away.
      const { fixture, container } = await renderComposer();
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;
      cmp.toggleEmojiPicker();
      expect(cmp.pickerOpen()).toBe(true);

      typeSlash(cmp, ta, '/sh');
      cmp.onEscape();
      expect(cmp.menus.slashOpen()).toBe(false);
      expect(cmp.pickerOpen()).toBe(true);

      cmp.onEscape();
      expect(cmp.pickerOpen()).toBe(false);
    });

    it('closes when the field loses focus', async () => {
      const { fixture, container } = await renderComposer();
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;

      typeSlash(cmp, ta, '/');
      cmp.onBlur();

      expect(cmp.menus.slashOpen()).toBe(false);
    });

    it.each([
      ['replying', { replyingTo: 'Alice' }],
      ['editing', { editing: true }],
    ])(
      'offers nothing while %s, where the send path would not parse one',
      async (_label, inputs) => {
        // The other half of "only where the send path would parse one". `send` runs
        // `slashCommandContent`; `replyMessageContent` and `editMessageContent` never see it,
        // so a completed `/me waves` would arrive in the room as those nine characters.
        const { fixture, container } = await renderComposer(inputs);
        const cmp = fixture.componentInstance;
        const ta = container.querySelector('textarea') as HTMLTextAreaElement;

        typeSlash(cmp, ta, '/');

        expect(cmp.menus.slashOpen()).toBe(false);
      },
    );

    it('offers nothing once a file is staged, where the caption is sent as written', async () => {
      const { fixture, container } = await renderComposer();
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;

      pickFiles(cmp, [png('shot.png')]);
      fixture.detectChanges();
      expect(cmp.hasStaged()).toBe(true);

      typeSlash(cmp, ta, '/');

      expect(cmp.menus.slashOpen()).toBe(false);
    });

    it('lets Enter send normally in a state that offers no commands', async () => {
      // The gate must not swallow the key: with no menu, `/me waves` is an ordinary message
      // and Enter has to send it rather than being cancelled by a ladder rung.
      const { fixture, container } = await renderComposer({
        replyingTo: 'Alice',
      });
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;
      const sent: string[] = [];
      cmp.submitText.subscribe((e) => sent.push(e.text));

      typeSlash(cmp, ta, '/me waves');
      cmp.onEnter(enter());

      expect(sent).toEqual(['/me waves']);
    });

    it('closes the menu when a send clears the composer', async () => {
      // The engine reads its own `query`, not the textarea, so emptying the box does not close
      // it. Left open, `accept` finds no trigger in the empty text and returns null while
      // `open` stays true — `onEnter` then cancels the key and returns, and Enter does nothing
      // at all until the next keystroke. Driven through `submit()` rather than a click,
      // because a click blurs first and blur closes it for a different reason.
      const { fixture, container } = await renderComposer();
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;

      typeSlash(cmp, ta, '/me');
      expect(cmp.menus.slashOpen()).toBe(true);

      cmp.submit();

      expect(cmp.text()).toBe('');
      expect(cmp.menus.slashOpen()).toBe(false);
    });
  });
});
