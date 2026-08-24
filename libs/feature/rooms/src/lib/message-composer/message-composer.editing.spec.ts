import {
  enter,
  renderComposer,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ComposerSettingsService,
  DraftStoreService,
} from '@trinity/platform-native';

describe('MessageComposerComponent — the field, edit mode and drafts', () => {
  beforeEach(() => stubObjectUrls());

  it('emits the trimmed text on Enter and clears the input', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    let sent: string | undefined;
    cmp.submitText.subscribe((e) => (sent = e.text));

    cmp.text.set('  hello  ');
    cmp.onEnter(enter());

    expect(sent).toBe('hello');
    expect(cmp.text()).toBe('');
  });

  it('does not submit on Shift+Enter or when empty', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    let count = 0;
    cmp.submitText.subscribe(() => count++);

    cmp.text.set('keep typing');
    cmp.onEnter(enter(true)); // Shift+Enter → newline, no submit

    cmp.text.set('   '); // whitespace only
    cmp.onEnter(enter());

    expect(count).toBe(0);
    expect(cmp.text()).toBe('   ');
  });

  it('prefills the draft in edit mode and keeps the text after submit', async () => {
    const { fixture } = await renderComposer({
      editing: true,
      draft: 'old text',
    });
    const cmp = fixture.componentInstance;

    expect(cmp.text()).toBe('old text');

    let submitted: string | undefined;
    cmp.submitText.subscribe((e) => (submitted = e.text));
    cmp.text.set('new text');
    cmp.onEnter(enter());

    expect(submitted).toBe('new text');
    // The parent ends edit mode (clears via editing → false); composer keeps text.
    expect(cmp.text()).toBe('new text');
  });

  it('refreshes the field when the edit target changes while still editing', async () => {
    const { fixture } = await renderComposer({
      editing: true,
      editTargetId: '$a',
      draft: 'body A',
    });
    const cmp = fixture.componentInstance;
    expect(cmp.text()).toBe('body A');

    // Re-target to another message (id changes) — the field must show B's body,
    // not keep A's (else Enter would overwrite B with A).
    fixture.componentRef.setInput('editTargetId', '$b');
    fixture.componentRef.setInput('draft', 'body B');
    fixture.detectChanges();
    expect(cmp.text()).toBe('body B');
  });

  it('does not clobber typed text when the same target body mutates mid-edit', async () => {
    const { fixture } = await renderComposer({
      editing: true,
      editTargetId: '$a',
      draft: 'hello',
    });
    const cmp = fixture.componentInstance;
    cmp.text.set('hello world'); // user has typed an in-progress edit

    // Same target ($a), but its body changes in the timeline (redaction / a
    // concurrent multi-device edit / a late echo). The field must NOT be
    // overwritten — the re-fill keys on the target id, not the body.
    fixture.componentRef.setInput('draft', '(message deleted)');
    fixture.detectChanges();
    expect(cmp.text()).toBe('hello world');
  });

  it('emits editLast on Up arrow only when empty and not editing', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    let count = 0;
    cmp.editLast.subscribe(() => count++);

    cmp.onArrowUp(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(count).toBe(1); // empty → edit last

    cmp.text.set('typing');
    cmp.onArrowUp(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(count).toBe(1); // has text → cursor movement, no emit
  });

  it('does not emit editLast while already editing', async () => {
    const { fixture } = await renderComposer({ editing: true });
    const cmp = fixture.componentInstance;

    let count = 0;
    cmp.editLast.subscribe(() => count++);
    cmp.text.set('');
    cmp.onArrowUp(new KeyboardEvent('keydown', { key: 'ArrowUp' }));

    expect(count).toBe(0);
  });

  it('emits cancel on Escape in edit mode', async () => {
    const { fixture } = await renderComposer({ editing: true });
    const cmp = fixture.componentInstance;

    let cancelled = false;
    cmp.cancelEdit.subscribe(() => (cancelled = true));
    cmp.onEscape();

    expect(cancelled).toBe(true);
  });

  it('inserts an emoji at the cursor and closes the picker', async () => {
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;

    cmp.text.set('ab');
    fixture.detectChanges();
    ta.selectionStart = ta.selectionEnd = 1; // cursor between a and b
    cmp.pickerOpen.set(true);

    cmp.insertEmoji('😀');

    expect(cmp.text()).toBe('a😀b');
    expect(cmp.pickerOpen()).toBe(false);
  });

  it('shows a reply banner and cancels the reply on Escape', async () => {
    const { fixture, container } = await renderComposer({
      replyingTo: 'Alice',
    });
    const cmp = fixture.componentInstance;

    expect(container.textContent).toContain('Replying to');
    expect(container.textContent).toContain('Alice');

    let cancelled = false;
    cmp.cancelReply.subscribe(() => (cancelled = true));
    cmp.onEscape();
    expect(cancelled).toBe(true);
  });

  describe('draft persistence', () => {
    it('restores the saved draft for the conversation on mount', async () => {
      const store = new DraftStoreService();
      store.set('!a:hs', 'half a message');
      const { fixture } = await renderComposer({ roomId: '!a:hs' }, [
        { provide: DraftStoreService, useValue: store },
      ]);

      expect(fixture.componentInstance.text()).toBe('half a message');
    });

    it('keeps a half-typed message per conversation when switching rooms', async () => {
      const { fixture } = await renderComposer({ roomId: '!a:hs' });
      const cmp = fixture.componentInstance;

      cmp.text.set('draft for A');
      fixture.detectChanges(); // flush the save effect

      // Switch to a room with no draft — A's text must not leak into it.
      fixture.componentRef.setInput('roomId', '!b:hs');
      fixture.detectChanges();
      expect(cmp.text()).toBe('');

      // Switch back — A's draft is restored.
      fixture.componentRef.setInput('roomId', '!a:hs');
      fixture.detectChanges();
      expect(cmp.text()).toBe('draft for A');
    });

    it('drops the draft once the message is sent', async () => {
      const { fixture } = await renderComposer({ roomId: '!a:hs' });
      const cmp = fixture.componentInstance;
      const store = TestBed.inject(DraftStoreService);

      cmp.text.set('to send');
      fixture.detectChanges();
      expect(store.get('!a:hs')).toBe('to send');

      cmp.onEnter(enter());
      fixture.detectChanges();

      expect(cmp.text()).toBe('');
      expect(store.get('!a:hs')).toBe('');
    });

    it('does not save the edit body, and restores the compose draft after editing', async () => {
      const { fixture } = await renderComposer({ roomId: '!a:hs' });
      const cmp = fixture.componentInstance;
      const store = TestBed.inject(DraftStoreService);

      cmp.text.set('my draft');
      fixture.detectChanges();
      expect(store.get('!a:hs')).toBe('my draft');

      // Enter edit mode with a different body.
      fixture.componentRef.setInput('editing', true);
      fixture.componentRef.setInput('editTargetId', '$m');
      fixture.componentRef.setInput('draft', 'editing an old message');
      fixture.detectChanges();
      expect(cmp.text()).toBe('editing an old message');
      expect(store.get('!a:hs')).toBe('my draft'); // edit body isn't the draft

      // Leaving edit mode brings the compose draft back.
      fixture.componentRef.setInput('editing', false);
      fixture.componentRef.setInput('editTargetId', null);
      fixture.detectChanges();
      expect(cmp.text()).toBe('my draft');
    });
  });

  describe('typing notifications', () => {
    it('emits typing=true while the field has text, false when it is emptied', async () => {
      const { fixture, container } = await renderComposer();
      const cmp = fixture.componentInstance;
      const states: boolean[] = [];
      cmp.typing.subscribe((t) => states.push(t));

      const ta = container.querySelector('textarea') as HTMLTextAreaElement;
      ta.value = 'hi';
      cmp.onInput({ target: ta } as unknown as Event);
      ta.value = '   '; // cleared to whitespace → not typing
      cmp.onInput({ target: ta } as unknown as Event);

      expect(states).toEqual([true, false]);
    });

    it('emits typing=false when a message is sent', async () => {
      const { fixture } = await renderComposer();
      const cmp = fixture.componentInstance;
      const states: boolean[] = [];
      cmp.typing.subscribe((t) => states.push(t));

      cmp.text.set('hello');
      cmp.onEnter(enter());

      expect(states.at(-1)).toBe(false);
    });
  });

  describe('pressing the field', () => {
    // jsdom has no PointerEvent, and the handler only reads target/currentTarget and calls
    // preventDefault — so a cancelable Event dispatched at the right node exercises exactly
    // the branch that matters. The geometry half (that there IS a dead zone above the
    // buttons) needs a real browser and lives in `composer-formatting.spec.mts`.
    const press = () =>
      new Event('pointerdown', { bubbles: true, cancelable: true });

    function parts(container: HTMLElement) {
      const field = container.querySelector<HTMLElement>(
        '[data-testid="composer-field"]',
      );
      const input = container.querySelector<HTMLTextAreaElement>(
        '[data-testid="composer-input"]',
      );
      if (!field || !input) {
        throw new Error('composer field or input not rendered');
      }
      return { field, input };
    }

    it('forwards a press on the field itself to the input', async () => {
      const { fixture, container } = await renderComposer();
      const { field, input } = parts(container);

      const event = press();
      field.dispatchEvent(event);
      fixture.detectChanges();

      expect(document.activeElement).toBe(input);
      // Before the focus, not after: a press's DEFAULT action sets focus and runs after this
      // handler, so letting it through moves focus straight back off the textarea.
      expect(event.defaultPrevented).toBe(true);
    });

    it('leaves a press that started on the input alone', async () => {
      // The guard is what keeps the browser's own caret placement and drag-selection working:
      // cancel the press that lands IN the textarea and clicking mid-draft stops moving the
      // caret. The event bubbles to the field, so only `target === currentTarget` separates
      // the two cases.
      const { fixture, container } = await renderComposer();
      const { input } = parts(container);

      const event = press();
      input.dispatchEvent(event);
      fixture.detectChanges();

      expect(event.defaultPrevented).toBe(false);
    });

    it('leaves a press that started on a button inside the field alone', async () => {
      const { fixture, container } = await renderComposer();
      const { field } = parts(container);
      const send = container.querySelector<HTMLElement>(
        '[data-testid="composer-send"]',
      );
      expect(send).not.toBeNull();
      expect(field.contains(send)).toBe(true);

      const event = press();
      send?.dispatchEvent(event);
      fixture.detectChanges();

      expect(event.defaultPrevented).toBe(false);
    });
  });

  describe('the bar a selection raises', () => {
    // Unpinned, so the bar is on screen only while there is something to format. Driven
    // through real events rather than the handlers, because what is being tested is that
    // something tells the bar the selection has gone — and the bug was that nothing did.
    function unpinned() {
      return renderComposer({}, [
        MockProvider(ComposerSettingsService, {
          showFormattingToolbar: signal(false).asReadonly(),
          formatOnSelection: signal(true).asReadonly(),
        }),
      ]);
    }

    function selectSomething(container: HTMLElement): HTMLTextAreaElement {
      const ta = container.querySelector<HTMLTextAreaElement>(
        '[data-testid=composer-input]',
      );
      if (!ta) {
        throw new Error('composer input not rendered');
      }
      ta.value = 'say hello there';
      ta.setSelectionRange(4, 9);
      ta.dispatchEvent(new Event('select', { bubbles: true }));
      return ta;
    }

    it('raises the bar while text is selected', async () => {
      const { fixture, container } = await unpinned();
      expect(fixture.componentInstance.showToolbar()).toBe(false);

      selectSomething(container);
      fixture.detectChanges();

      expect(fixture.componentInstance.showToolbar()).toBe(true);
    });

    it('drops the bar when focus leaves the composer', async () => {
      // A textarea keeps its selection after it blurs, and none of select/keyup/pointerup
      // fire when the press lands elsewhere — so without the focusout the bar stayed up for
      // good once you clicked away into the timeline.
      const { fixture, container } = await unpinned();
      const ta = selectSomething(container);
      fixture.detectChanges();
      expect(fixture.componentInstance.showToolbar()).toBe(true);

      const elsewhere = document.createElement('button');
      document.body.appendChild(elsewhere);
      ta.dispatchEvent(
        new FocusEvent('focusout', {
          bubbles: true,
          relatedTarget: elsewhere,
        }),
      );
      fixture.detectChanges();

      expect(fixture.componentInstance.showToolbar()).toBe(false);
      elsewhere.remove();
    });

    it('keeps the bar when focus moves to a control inside the composer', async () => {
      // The press that opens a formatting button blurs the textarea BEFORE the click lands.
      // Clearing unconditionally would unmount the bar in between, and the button you aimed
      // at would never fire.
      const { fixture, container } = await unpinned();
      const ta = selectSomething(container);
      fixture.detectChanges();

      const send = container.querySelector('[data-testid=composer-send]');
      expect(send).not.toBeNull();
      ta.dispatchEvent(
        new FocusEvent('focusout', { bubbles: true, relatedTarget: send }),
      );
      fixture.detectChanges();

      expect(fixture.componentInstance.showToolbar()).toBe(true);
    });

    it('drops the bar when the message is sent', async () => {
      // Sending empties the box through the signal, which fires no `select`. Enter happens to
      // self-correct on the following keyup; pressing Send with the mouse does not.
      const { fixture, container } = await unpinned();
      selectSomething(container);
      fixture.componentInstance.text.set('say hello there');
      fixture.detectChanges();
      expect(fixture.componentInstance.showToolbar()).toBe(true);

      fixture.componentInstance.submit();
      fixture.detectChanges();

      expect(fixture.componentInstance.showToolbar()).toBe(false);
    });
  });

  // Formatting: a toolbar action, the rebindable chords behind it, and the preview. The
  // wrapping arithmetic itself lives in `markdown-edit.ts` and is tested there — these cover the
  // wiring: that the right selection reaches it, and that the result reaches the textarea.
});
