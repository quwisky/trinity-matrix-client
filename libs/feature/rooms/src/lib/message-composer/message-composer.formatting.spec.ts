import {
  pasteEvent,
  renderComposer,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { signal } from '@angular/core';
import { type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockProvider } from 'ng-mocks';
import {
  ComposerSettingsService,
  VoiceRecorderService,
} from '@trinity/platform-native';
import { MessageComposerComponent } from './message-composer.component';

describe('MessageComposerComponent — quoting, the formatting actions and the preview', () => {
  beforeEach(() => stubObjectUrls());

  describe('quoting', () => {
    it('puts the block in an empty composer and leaves the caret below it', async () => {
      const { fixture } = await renderComposer();
      const cmp = fixture.componentInstance;

      cmp.insertQuote('> theirs\n\n');
      await Promise.resolve();

      expect(cmp.text()).toBe('> theirs\n\n');
      const ta = fixture.nativeElement.querySelector(
        'textarea',
      ) as HTMLTextAreaElement;
      expect(ta.selectionStart).toBe('> theirs\n\n'.length);
    });

    it('puts the quote ABOVE what is already typed, caret still at the end', async () => {
      const { fixture } = await renderComposer();
      const cmp = fixture.componentInstance;
      cmp.text.set('my answer');
      fixture.detectChanges();

      cmp.insertQuote('> theirs\n\n');
      await Promise.resolve();

      // Whatever is in the box IS the response, so the quote belongs before it and the
      // caret after it. Replacing the draft would silently discard work.
      expect(cmp.text()).toBe('> theirs\n\nmy answer');
      const ta = fixture.nativeElement.querySelector(
        'textarea',
      ) as HTMLTextAreaElement;
      expect(ta.selectionStart).toBe('> theirs\n\nmy answer'.length);
    });

    it('stacks a second quote rather than replacing the first', async () => {
      const { fixture } = await renderComposer();
      const cmp = fixture.componentInstance;

      cmp.insertQuote('> first\n\n');
      cmp.insertQuote('> second\n\n');

      expect(cmp.text()).toBe('> second\n\n> first\n\n');
    });

    it('announces typing, so quoting alone shows the other side something is happening', async () => {
      const { fixture } = await renderComposer();
      const cmp = fixture.componentInstance;
      const seen: boolean[] = [];
      cmp.typing.subscribe((t) => seen.push(t));

      cmp.insertQuote('> theirs\n\n');

      expect(seen).toEqual([true]);
    });

    it('drops out of preview, so the caret lands somewhere real', async () => {
      const { fixture } = await renderComposer();
      const cmp = fixture.componentInstance;
      cmp.onTogglePreview();
      fixture.detectChanges();
      expect(cmp.previewing()).toBe(true);

      cmp.insertQuote('> theirs\n\n');
      fixture.detectChanges();
      await Promise.resolve();

      // A preview hides the textarea, and focus() on a display:none element is a no-op —
      // the user would type their answer into nothing.
      expect(cmp.previewing()).toBe(false);
      const ta = fixture.nativeElement.querySelector(
        'textarea',
      ) as HTMLTextAreaElement;
      expect(document.activeElement).toBe(ta);
    });

    it('does nothing at all for an empty block', async () => {
      const { fixture } = await renderComposer();
      const cmp = fixture.componentInstance;
      cmp.text.set('untouched');
      const seen: boolean[] = [];
      cmp.typing.subscribe((t) => seen.push(t));

      cmp.insertQuote('');

      // A body with nothing quotable must not clear the box or claim the user is typing.
      expect(cmp.text()).toBe('untouched');
      expect(seen).toEqual([]);
    });
  });

  describe('formatting', () => {
    /** Put `value` in the composer with `[start, end)` selected, the way a user would. */
    async function withSelection(
      fixture: ComponentFixture<MessageComposerComponent>,
      value: string,
      start: number,
      end: number,
    ) {
      const cmp = fixture.componentInstance;
      cmp.text.set(value);
      fixture.detectChanges();
      const ta = fixture.nativeElement.querySelector(
        'textarea',
      ) as HTMLTextAreaElement;
      // AFTER detectChanges: the textarea's value is bound to the signal, and writing `value`
      // resets the selection to the end.
      ta.setSelectionRange(start, end);
      return ta;
    }

    it('wraps the selection when a toolbar action fires', async () => {
      const { fixture } = await renderComposer();
      await withSelection(fixture, 'say hello there', 4, 9);

      fixture.componentInstance.onFormat('bold');

      expect(fixture.componentInstance.text()).toBe('say **hello** there');
    });

    it('restores the selection over the wrapped text', async () => {
      const { fixture } = await renderComposer();
      const ta = await withSelection(fixture, 'say hello there', 4, 9);

      fixture.componentInstance.onFormat('bold');
      // The caret restore runs in a microtask, after the signal write reaches the DOM.
      await Promise.resolve();

      expect(ta.selectionStart).toBe(6);
      expect(ta.selectionEnd).toBe(11);
    });

    it('applies a menu action using the selection saved before focus leaves the textarea', async () => {
      const { fixture, container } = await renderComposer({
        accountId: 'account-a',
        roomId: '!room:example.org',
      });
      const ta = await withSelection(fixture, 'say hello there', 4, 9);
      container
        .querySelector<HTMLButtonElement>('[data-testid=composer-format]')
        ?.click();
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid=composer-format-menu] [data-testid=format-bold]',
        )
        ?.click();
      await Promise.resolve();

      expect(fixture.componentInstance.text()).toBe('say **hello** there');
      expect(document.activeElement).toBe(ta);
      expect(ta.selectionStart).toBe(6);
      expect(ta.selectionEnd).toBe(11);
    });

    it('formats a collapsed caret through the menu and leaves the caret between markers', async () => {
      const { fixture, container } = await renderComposer({
        accountId: 'account-a',
        roomId: '!room:example.org',
      });
      const ta = await withSelection(fixture, 'say ', 4, 4);
      container
        .querySelector<HTMLButtonElement>('[data-testid=composer-format]')
        ?.click();
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid=composer-format-menu] [data-testid=format-bold]',
        )
        ?.click();
      await Promise.resolve();

      expect(fixture.componentInstance.text()).toBe('say ****');
      expect(ta.selectionStart).toBe(6);
      expect(ta.selectionEnd).toBe(6);
    });

    it('dismisses the menu and discards its saved selection when the account changes', async () => {
      const { fixture, container } = await renderComposer({
        accountId: 'account-a',
        roomId: '!same-room:example.org',
      });
      await withSelection(fixture, 'say hello', 4, 9);
      container
        .querySelector<HTMLButtonElement>('[data-testid=composer-format]')
        ?.click();
      await vi.waitFor(() =>
        expect(
          document.querySelector('[data-testid=composer-format-menu]'),
        ).not.toBeNull(),
      );

      fixture.componentRef.setInput('accountId', 'account-b');
      fixture.detectChanges();
      await vi.waitFor(() =>
        expect(
          document.querySelector('[data-testid=composer-format-menu]'),
        ).toBeNull(),
      );
      expect(fixture.componentInstance.text()).toBe('say hello');
    });

    it('preserves the selected range through a Preview round trip', async () => {
      const { fixture } = await renderComposer({
        accountId: 'account-a',
        roomId: '!room:example.org',
      });
      const ta = await withSelection(fixture, '**bold** and `code`', 2, 6);

      fixture.componentInstance.onTogglePreview();
      fixture.detectChanges();
      expect(fixture.componentInstance.previewing()).toBe(true);
      fixture.componentInstance.onTogglePreview();
      fixture.detectChanges();

      expect(fixture.componentInstance.previewing()).toBe(false);
      expect(ta.selectionStart).toBe(2);
      expect(ta.selectionEnd).toBe(6);
    });

    it('does not format while an IME composition is active', async () => {
      const { fixture } = await renderComposer();
      const ta = await withSelection(fixture, 'say hello', 4, 9);
      ta.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      );

      fixture.componentInstance.onFormat('bold');

      expect(fixture.componentInstance.text()).toBe('say hello');
    });

    it('applies a formatting chord the user could rebind', async () => {
      const { fixture } = await renderComposer();
      await withSelection(fixture, 'say hello there', 4, 9);

      fixture.componentInstance.onKeydown(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }),
      );

      expect(fixture.componentInstance.text()).toBe('say **hello** there');
    });

    it('reaches the handler from a real keystroke on the textarea', async () => {
      // The rest of this file drives handlers directly, which would let a mis-wired template
      // binding pass silently — this is the one test that proves the binding exists.
      const { fixture } = await renderComposer();
      const ta = await withSelection(fixture, 'say hello there', 4, 9);

      ta.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'b',
          ctrlKey: true,
          bubbles: true,
        }),
      );
      fixture.detectChanges();

      expect(fixture.componentInstance.text()).toBe('say **hello** there');
    });

    it('leaves a chord it does not own alone, so the switcher still opens', async () => {
      const { fixture } = await renderComposer();
      await withSelection(fixture, 'hello', 0, 0);
      const event = new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        cancelable: true,
      });

      fixture.componentInstance.onKeydown(event);

      expect(event.defaultPrevented).toBe(false);
      expect(fixture.componentInstance.text()).toBe('hello');
    });

    it('ignores a chord mid-IME-composition', async () => {
      const { fixture } = await renderComposer();
      await withSelection(fixture, 'say hello', 4, 9);
      const event = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true });
      Object.defineProperty(event, 'isComposing', { value: true });

      fixture.componentInstance.onKeydown(event);

      expect(fixture.componentInstance.text()).toBe('say hello');
    });

    describe('Shift+Enter in a list', () => {
      const shiftEnter = () =>
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          cancelable: true,
        });

      it('carries the marker onto the next line', async () => {
        const { fixture } = await renderComposer();
        await withSelection(fixture, '- one', 5, 5);
        const event = shiftEnter();

        fixture.componentInstance.onKeydown(event);

        expect(fixture.componentInstance.text()).toBe('- one\n- ');
        expect(event.defaultPrevented).toBe(true);
      });

      it('ends the list on an empty item', async () => {
        const { fixture } = await renderComposer();
        await withSelection(fixture, '- one\n- ', 8, 8);

        fixture.componentInstance.onKeydown(shiftEnter());

        expect(fixture.componentInstance.text()).toBe('- one\n');
      });

      it('leaves an ordinary line to the browser', async () => {
        const { fixture } = await renderComposer();
        await withSelection(fixture, 'just text', 9, 9);
        const event = shiftEnter();

        fixture.componentInstance.onKeydown(event);

        // Not prevented: the browser inserts its own newline, as it always has.
        expect(event.defaultPrevented).toBe(false);
        expect(fixture.componentInstance.text()).toBe('just text');
      });
    });

    describe('preview', () => {
      it('renders markdown the way the timeline will', async () => {
        const { fixture } = await renderComposer();
        fixture.componentInstance.text.set('**bold** and `code`');

        const { html, rich } = fixture.componentInstance.preview();

        expect(html).toContain('<strong>bold</strong>');
        expect(html).toContain('<code>code</code>');
        expect(rich).toBe(true);
      });

      it('previews what a slash command will actually send', async () => {
        // /spoiler sends a concealed span, not the literal text — previewing the text would
        // be a lie in exactly the case a preview is most useful.
        const { fixture } = await renderComposer();
        fixture.componentInstance.text.set('/spoiler the butler');

        const html = fixture.componentInstance.preview().html;

        expect(html).toContain('mx-spoiler');
        expect(html).toContain('the butler');
      });

      it('keeps a plain message plain, so pre-wrap keeps its line breaks', async () => {
        // `rich: false` drops `msg__text--html`, which is what leaves the container pre-wrap.
        // Converting the newline to `<br>` here instead would break every line twice.
        const { fixture, container } = await renderComposer();
        fixture.componentInstance.text.set('line one\nline two');

        const { html, rich } = fixture.componentInstance.preview();
        expect(rich).toBe(false);
        expect(html).toBe('line one\nline two');

        fixture.componentInstance.onTogglePreview();
        fixture.detectChanges();
        expect(
          container
            .querySelector('[data-testid=composer-preview]')
            ?.classList.contains('msg__text--html'),
        ).toBe(false);
      });

      it('is empty for an empty composer', async () => {
        const { fixture } = await renderComposer();

        expect(fixture.componentInstance.preview().html).toBe('');
      });

      it('swaps the input for the preview and back', async () => {
        const { fixture, container } = await renderComposer();
        fixture.componentInstance.text.set('hi');

        fixture.componentInstance.onTogglePreview();
        fixture.detectChanges();
        expect(
          container.querySelector('[data-testid=composer-preview]'),
        ).not.toBeNull();

        fixture.componentInstance.onTogglePreview();
        fixture.detectChanges();
        expect(
          container.querySelector('[data-testid=composer-preview]'),
        ).toBeNull();
        // The draft survives the round trip — the textarea was hidden, never unmounted.
        expect(fixture.componentInstance.text()).toBe('hi');
      });

      it('leaves the preview on submit, so the input is never left hidden', async () => {
        // Sending while previewing used to strand the composer showing a stale preview of a
        // message that had already gone, with the textarea still display:none underneath.
        const { fixture, container } = await renderComposer();
        fixture.componentInstance.text.set('hi');
        fixture.componentInstance.onTogglePreview();
        fixture.detectChanges();

        fixture.componentInstance.submit();
        fixture.detectChanges();

        expect(fixture.componentInstance.previewing()).toBe(false);
        expect(
          container.querySelector('[data-testid=composer-preview]'),
        ).toBeNull();
      });

      it('leaves the preview when an edit takes over the composer', async () => {
        const { fixture } = await renderComposer();
        fixture.componentInstance.onTogglePreview();
        fixture.detectChanges();

        fixture.componentRef.setInput('draft', 'the original');
        fixture.componentRef.setInput('editTargetId', '$evt:example.org');
        fixture.componentRef.setInput('editing', true);
        fixture.detectChanges();

        expect(fixture.componentInstance.previewing()).toBe(false);
        expect(fixture.componentInstance.text()).toBe('the original');
      });

      it('leaves the preview when the room changes', async () => {
        const { fixture } = await renderComposer({ roomId: '!a:example.org' });
        fixture.componentInstance.onTogglePreview();
        fixture.detectChanges();

        fixture.componentRef.setInput('roomId', '!b:example.org');
        fixture.detectChanges();

        expect(fixture.componentInstance.previewing()).toBe(false);
      });

      it.each([
        ['replying', { replyingTo: 'Alice' }],
        ['editing', { editing: true, editTargetId: '$e:example.org' }],
      ])(
        'previews a slash command literally while %s, because that is what sends',
        async (_label, inputs) => {
          // Only TimelineActionsService.send and ThreadsService.sendThreadMessage
          // parse slash commands. A reply/edit goes through replyMessageContent /
          // editMessageContent, which send the text as typed — so concealing it here
          // would be a lie.
          const { fixture } = await renderComposer(inputs);
          fixture.componentInstance.text.set('/spoiler the butler did it');
          fixture.detectChanges();

          const { html } = fixture.componentInstance.preview();

          expect(html).not.toContain('mx-spoiler');
          expect(html).toContain('/spoiler the butler did it');
        },
      );

      it('previews a staged attachment caption literally', async () => {
        // The caption goes through mediaCaptionFields, which does not parse commands either.
        const { fixture } = await renderComposer();
        fixture.componentInstance.onPaste(
          pasteEvent({
            files: [new File(['x'], 'a.png', { type: 'image/png' })],
          }).event,
        );
        fixture.componentInstance.text.set('/shrug');
        fixture.detectChanges();

        expect(fixture.componentInstance.preview().html).toContain('/shrug');
      });

      it('still previews a slash command in a plain compose', async () => {
        const { fixture } = await renderComposer();
        fixture.componentInstance.text.set('/spoiler hidden');
        fixture.detectChanges();

        expect(fixture.componentInstance.preview().html).toContain(
          'mx-spoiler',
        );
      });

      it('styles a link in a plain message the way the timeline does', async () => {
        // linkifyText replaces newlines with <br>, so the rendered-markdown container is
        // the right one — without it the link falls back to browser blue-and-underlined.
        const { fixture } = await renderComposer();
        fixture.componentInstance.text.set('see https://example.test/x');
        fixture.detectChanges();

        const preview = fixture.componentInstance.preview();

        expect(preview.html).toContain('<a href="https://example.test/x">');
        expect(preview.rich).toBe(true);
      });

      it('keeps a plain message without a link on pre-wrap', async () => {
        // No linkify pass means raw newlines survive, which only pre-wrap renders.
        const { fixture } = await renderComposer();
        fixture.componentInstance.text.set('line one\nline two');
        fixture.detectChanges();

        expect(fixture.componentInstance.preview().rich).toBe(false);
      });

      it('shows the toolbar unless the setting says otherwise', async () => {
        // The default matters as much as the switch: an install that never opens Settings
        // must still get the toolbar.
        const { container } = await renderComposer();

        expect(container.querySelector('trn-composer-toolbar')).not.toBeNull();
      });

      it('keeps markdown-aware Enter working with the toolbar hidden', async () => {
        // The other half of "the row goes, the capability stays" — list continuation is not
        // on the toolbar at all, so it must be untouched by the setting.
        const { fixture } = await renderComposer({}, [
          MockProvider(ComposerSettingsService, {
            showFormattingToolbar: signal(false).asReadonly(),
          }),
        ]);
        const cmp = fixture.componentInstance;
        cmp.text.set('- one');
        const textarea = fixture.nativeElement.querySelector('textarea');
        textarea.value = '- one';
        textarea.setSelectionRange(5, 5);

        // onKeydown, not onEnter: Angular only fires (keydown.enter) with no modifier held,
        // which is why list continuation lives in the general handler.
        cmp.onKeydown(
          new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }),
        );

        expect(cmp.text()).toBe('- one\n- ');
      });

      it('hides the toolbar when the setting is off, keeping the shortcuts', async () => {
        // Hiding it is about screen space, not about giving up formatting — Ctrl+B has to
        // keep working, or the setting quietly removes a capability instead of a row.
        const { fixture, container } = await renderComposer({}, [
          MockProvider(ComposerSettingsService, {
            showFormattingToolbar: signal(false).asReadonly(),
          }),
        ]);
        fixture.detectChanges();

        expect(container.querySelector('trn-composer-toolbar')).toBeNull();

        fixture.componentInstance.text.set('hello');
        fixture.componentInstance.onFormat('bold');

        expect(fixture.componentInstance.text()).toContain('**');
      });

      it('keeps the preview when the legacy toolbar is taken away', async () => {
        // Preview is now owned by the always available Aa menu, so removing the legacy toolbar
        // must not strand or cancel an active preview.
        const showToolbar = signal(true);
        const { fixture, container } = await renderComposer({}, [
          MockProvider(ComposerSettingsService, {
            showFormattingToolbar: showToolbar.asReadonly(),
          }),
        ]);
        fixture.componentInstance.onTogglePreview();
        fixture.detectChanges();
        expect(fixture.componentInstance.previewing()).toBe(true);

        showToolbar.set(false);
        fixture.detectChanges();

        expect(fixture.componentInstance.previewing()).toBe(true);
        expect(
          container.querySelector('[data-testid=composer-preview]'),
        ).not.toBeNull();
      });

      it('leaves the preview when a reply starts', async () => {
        // The reply effect focuses the textarea, which is display:none while previewing —
        // so the composer would sit on the preview and swallow every keystroke.
        const { fixture } = await renderComposer();
        fixture.componentInstance.onTogglePreview();
        fixture.detectChanges();

        fixture.componentRef.setInput('replyingTo', 'Alice');
        fixture.detectChanges();

        expect(fixture.componentInstance.previewing()).toBe(false);
      });

      it('leaves the preview when a voice recording starts', async () => {
        // Recording removes the toolbar, and with it the only way back out of the preview.
        const { fixture } = await renderComposer({}, [
          MockProvider(VoiceRecorderService, {
            supported: true,
            start: () => Promise.resolve(),
            cancel: vi.fn(),
          }),
        ]);
        fixture.componentInstance.onTogglePreview();
        fixture.detectChanges();

        await fixture.componentInstance.startVoiceRecording();
        fixture.detectChanges();

        expect(fixture.componentInstance.previewing()).toBe(false);
      });
    });
  });

  describe('what the bar reports as pressed', () => {
    // End to end through the DOM, because the value is derived in the composer and rendered
    // by the toolbar — asserting the signal would test neither half of the wiring.
    async function withSelection(text: string, start: number, end: number) {
      const { fixture, container } = await renderComposer({}, [
        MockProvider(ComposerSettingsService, {
          // Pinned, so the bar is up regardless of the selection and this tests the pressed
          // state rather than the raising.
          showFormattingToolbar: signal(true).asReadonly(),
          formatOnSelection: signal(true).asReadonly(),
        }),
      ]);
      fixture.componentInstance.text.set(text);
      fixture.detectChanges();

      const ta = container.querySelector<HTMLTextAreaElement>(
        '[data-testid=composer-input]',
      );
      if (!ta) {
        throw new Error('composer input not rendered');
      }
      ta.value = text;
      ta.setSelectionRange(start, end);
      ta.dispatchEvent(new Event('select', { bubbles: true }));
      fixture.detectChanges();

      return (testid: string) =>
        container
          .querySelector<HTMLElement>(`[data-testid=${testid}]`)
          ?.getAttribute('aria-pressed');
    }

    it('presses Bold over bold text', async () => {
      const pressed = await withSelection('say **hello** there', 6, 11);

      expect(pressed('format-bold')).toBe('true');
      expect(pressed('format-italic')).toBe('false');
    });

    it('presses nothing over plain text', async () => {
      const pressed = await withSelection('say hello there', 4, 9);

      expect(pressed('format-bold')).toBe('false');
      expect(pressed('format-quote')).toBe('false');
    });

    it('presses Quote from anywhere on a quoted line', async () => {
      // A block action is about the line, so the middle of it counts.
      const pressed = await withSelection('> one', 3, 4);

      expect(pressed('format-quote')).toBe('true');
    });

    it('presses nothing when there is no selection', async () => {
      // The nine act on a selection, so a bare caret has nothing to be in a state about.
      const pressed = await withSelection('say **hello** there', 6, 6);

      expect(pressed('format-bold')).toBe('false');
    });
  });
});
