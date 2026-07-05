import { signal, type Provider } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, type ComponentInput } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import type { EmojiEvent } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import { ThemeService } from '@trinity/platform-native';
import {
  GifService,
  GifSettingsService,
  type GifProviderId,
  type GifResult,
} from '@trinity/data-access-gif';
import { TrnToastService } from '@trinity/helm/overlay';
import { MessageComposerComponent } from './message-composer.component';
import { MediaPickerService } from '../media-picker/media-picker.service';

describe('MessageComposerComponent', () => {
  beforeEach(() => {
    // jsdom has no object-URL API; stub it for the staged-image preview.
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  });

  /** Render the composer with the toast service auto-mocked (plus any extra providers). */
  function renderComposer(
    inputs: ComponentInput<MessageComposerComponent> = {},
    providers: Provider[] = [],
  ) {
    return render(MessageComposerComponent, {
      inputs,
      providers: [MockProvider(TrnToastService), ...providers],
    });
  }

  function enter(shift = false): Event {
    return new KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift });
  }

  it('emits the trimmed text on Enter and clears the input', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    let sent: string | undefined;
    cmp.submitText.subscribe((t) => (sent = t));

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
    cmp.submitText.subscribe((t) => (submitted = t));
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

  it('stages a picked file and sends it with the typed caption on submit', async () => {
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;

    let emitted: { file: File; caption: string } | undefined;
    cmp.submitMedia.subscribe((e) => (emitted = e));

    const file = new File([new Uint8Array([1])], 'pic.png', {
      type: 'image/png',
    });
    const input = container.querySelector(
      '[data-testid=composer-file-input]',
    ) as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [file],
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));

    // Staged, not sent immediately; the input resets so the same file re-picks.
    expect(cmp.pendingFile()).toBe(file);
    expect(emitted).toBeUndefined();
    expect(input.value).toBe('');

    // A caption + Enter sends the file and caption together, then clears.
    cmp.text.set('nice shot');
    cmp.submit();
    expect(emitted).toEqual({ file, caption: 'nice shot' });
    expect(cmp.pendingFile()).toBeNull();
    expect(cmp.text()).toBe('');
  });

  it('opens the hidden file input on attach (web fallback)', async () => {
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const input = container.querySelector(
      '[data-testid=composer-file-input]',
    ) as HTMLInputElement;
    const clickSpy = vi
      .spyOn(input, 'click')
      .mockImplementation(() => undefined);

    cmp.onAttach(); // picker.available is false under jsdom → uses the input

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('toasts a clear message when the native attach is denied/fails', async () => {
    // Stand in for the native picker: available, but pickImage errors (e.g. denied
    // photo access) instead of resolving a file.
    const { fixture } = await renderComposer({}, [
      MockProvider(MediaPickerService, {
        available: true,
        pickImage: () =>
          throwError(
            () => new Error('Photo access is denied. Enable it in Settings.'),
          ),
      }),
    ]);

    fixture.componentInstance.onAttach();
    await Promise.resolve(); // let the error handler's toast settle

    const toast = TestBed.inject(TrnToastService);
    expect(toast.show).toHaveBeenCalledWith(
      expect.stringContaining('Photo access is denied'),
      expect.objectContaining({ variant: 'destructive', duration: 4000 }),
    );
  });

  it('shows a determinate upload progress bar while uploading and hides it when idle', async () => {
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const wrapper = () =>
      container.querySelector('[data-testid=upload-progress]');
    const bar = () =>
      container.querySelector('hlm-progress') as HTMLElement | null;

    // Idle: no progress UI.
    expect(wrapper()).toBeNull();

    // Mid-upload with a real fraction → determinate bar bound to the value.
    fixture.componentRef.setInput('uploadProgress', 0.42);
    fixture.detectChanges();
    expect(wrapper()).not.toBeNull();
    expect(bar()).not.toBeNull();
    // Determinate → the fraction is exposed as a 0–100 percentage on aria-valuenow
    // (helm/BrnProgress uses a 0–max scale with max defaulting to 100).
    expect(Number(bar()?.getAttribute('aria-valuenow'))).toBeCloseTo(42, 5);
    expect(wrapper()?.textContent).toContain('42%');
    expect(cmp.uploadPercent()).toBe(42);

    // Just started (0, before the first real tick) → indeterminate, no percent.
    fixture.componentRef.setInput('uploadProgress', 0);
    fixture.detectChanges();
    expect(wrapper()).not.toBeNull();
    // Indeterminate → no aria-valuenow.
    expect(bar()?.getAttribute('aria-valuenow')).toBeNull();
    expect(wrapper()?.textContent).not.toContain('%');

    // Upload finished → null clears the bar (and re-enables the attach button).
    fixture.componentRef.setInput('uploadProgress', null);
    fixture.detectChanges();
    expect(wrapper()).toBeNull();
  });

  it('disables the attach button while an upload is in flight', async () => {
    const { fixture, container } = await renderComposer();
    const attach = () =>
      container.querySelector(
        '[data-testid=composer-attach]',
      ) as HTMLButtonElement;

    expect(attach().disabled).toBe(false);

    fixture.componentRef.setInput('uploadProgress', 0.1);
    fixture.detectChanges();
    expect(attach().disabled).toBe(true);

    fixture.componentRef.setInput('uploadProgress', null);
    fixture.detectChanges();
    expect(attach().disabled).toBe(false);
  });

  it('toggles the emoji picker open and closed from the button', async () => {
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const button = container.querySelector(
      '.composer__emoji',
    ) as HTMLButtonElement;

    expect(cmp.pickerOpen()).toBe(false);
    button.click(); // (don't detectChanges — avoids rendering the full picker)
    expect(cmp.pickerOpen()).toBe(true);
    button.click();
    expect(cmp.pickerOpen()).toBe(false);
  });

  it('inserts the emoji chosen from the picker at the cursor', async () => {
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;

    cmp.text.set('ab');
    fixture.detectChanges();
    ta.selectionStart = ta.selectionEnd = 1; // cursor between a and b
    cmp.pickerOpen.set(true);

    cmp.onPickerSelect({
      emoji: { native: '😎' },
      $event: new Event('click'),
    } as unknown as EmojiEvent);

    expect(cmp.text()).toBe('a😎b');
    expect(cmp.pickerOpen()).toBe(false);
  });

  it('mirrors the active app theme into the picker dark mode', async () => {
    const resolved = signal<'light' | 'dark'>('dark');
    const { fixture } = await renderComposer({}, [
      MockProvider(ThemeService, { resolved: resolved.asReadonly() }),
    ]);
    const cmp = fixture.componentInstance;

    expect(cmp.isDarkMode()).toBe(true);
    resolved.set('light');
    expect(cmp.isDarkMode()).toBe(false);
  });

  function pasteEvent(opts: { files?: File[]; items?: unknown[] }): {
    event: ClipboardEvent;
    preventDefault: ReturnType<typeof vi.fn>;
  } {
    const preventDefault = vi.fn();
    const event = {
      clipboardData: { files: opts.files ?? [], items: opts.items ?? [] },
      preventDefault,
    } as unknown as ClipboardEvent;
    return { event, preventDefault };
  }

  it('stages a pasted image (preventing the default paste) and sends on submit', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    let emitted: { file: File; caption: string } | undefined;
    cmp.submitMedia.subscribe((e) => (emitted = e));
    const file = new File([new Uint8Array([1])], 'paste.png', {
      type: 'image/png',
    });
    const { event, preventDefault } = pasteEvent({ files: [file] });

    cmp.onPaste(event);

    expect(cmp.pendingFile()).toBe(file);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(emitted).toBeUndefined();

    cmp.submit(); // no caption typed
    expect(emitted).toEqual({ file, caption: '' });
  });

  it('stages a pasted image exposed only via clipboard items (WebKit fallback)', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    const file = new File([new Uint8Array([1])], 'paste.png', {
      type: 'image/png',
    });
    const { event } = pasteEvent({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
    });

    cmp.onPaste(event);

    expect(cmp.pendingFile()).toBe(file);
  });

  it('discards a staged attachment when the room changes', async () => {
    const { fixture } = await renderComposer({ roomId: '!a:hs' });
    const cmp = fixture.componentInstance;

    const file = new File([new Uint8Array([1])], 'pic.png', {
      type: 'image/png',
    });
    cmp.onPaste(pasteEvent({ files: [file] }).event);
    expect(cmp.pendingFile()).toBe(file);

    // Switch room — the file was staged for room A and must not leak into B.
    fixture.componentRef.setInput('roomId', '!b:hs');
    fixture.detectChanges();
    expect(cmp.pendingFile()).toBeNull();
  });

  it('Escape discards a staged attachment', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    const file = new File([new Uint8Array([1])], 'pic.png', {
      type: 'image/png',
    });
    cmp.onPaste(pasteEvent({ files: [file] }).event);
    expect(cmp.pendingFile()).toBe(file);

    cmp.onEscape();
    expect(cmp.pendingFile()).toBeNull();
  });

  it('ends an active reply when a staged attachment is sent', async () => {
    const { fixture } = await renderComposer({ replyingTo: 'Alice' });
    const cmp = fixture.componentInstance;

    let cancelledReply = false;
    cmp.cancelReply.subscribe(() => (cancelledReply = true));
    let emitted: { file: File; caption: string } | undefined;
    cmp.submitMedia.subscribe((e) => (emitted = e));

    const file = new File([new Uint8Array([1])], 'pic.png', {
      type: 'image/png',
    });
    cmp.onPaste(pasteEvent({ files: [file] }).event);
    cmp.submit();

    // Media carries no reply relation, so the reply banner must be cleared
    // (otherwise the next plain message would silently reply to Alice).
    expect(emitted).toEqual({ file, caption: '' });
    expect(cancelledReply).toBe(true);
  });

  it('does not stage a pasted image while editing (paste falls through)', async () => {
    const { fixture } = await renderComposer({ editing: true });
    const cmp = fixture.componentInstance;

    const file = new File([new Uint8Array([1])], 'x.png', {
      type: 'image/png',
    });
    const { event, preventDefault } = pasteEvent({ files: [file] });
    cmp.onPaste(event);

    expect(cmp.pendingFile()).toBeNull();
    expect(preventDefault).not.toHaveBeenCalled(); // browser pastes normally
  });

  it('does not edit-last on ArrowUp when a file is staged', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    const file = new File([new Uint8Array([1])], 'x.png', {
      type: 'image/png',
    });
    cmp.onPaste(pasteEvent({ files: [file] }).event);

    let count = 0;
    cmp.editLast.subscribe(() => count++);
    cmp.onArrowUp(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(count).toBe(0); // staged file suppresses the edit-last shortcut
  });

  it('clearPending drops a staged attachment', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    const file = new File([new Uint8Array([1])], 'x.png', {
      type: 'image/png',
    });
    cmp.onPaste(pasteEvent({ files: [file] }).event);
    expect(cmp.pendingFile()).not.toBeNull();

    cmp.clearPending();
    expect(cmp.pendingFile()).toBeNull();
    expect(cmp.pendingPreview()).toBeNull();
  });

  it('enables the send button with a staged file even when the text is empty', async () => {
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const send = () =>
      container.querySelector('.composer__send') as HTMLButtonElement;

    expect(send().disabled).toBe(true); // empty text, no attachment

    const file = new File([new Uint8Array([1])], 'x.png', {
      type: 'image/png',
    });
    cmp.onPaste(pasteEvent({ files: [file] }).event);
    fixture.detectChanges();

    expect(send().disabled).toBe(false); // a staged file is enough to send
  });

  it('lets a non-image (text) paste through untouched', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    let count = 0;
    cmp.submitMedia.subscribe(() => count++);
    const { event, preventDefault } = pasteEvent({
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
    });

    cmp.onPaste(event);

    expect(count).toBe(0);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('ignores a pasted image while an upload is already in flight', async () => {
    const { fixture } = await renderComposer({ uploadProgress: 0.5 });
    const cmp = fixture.componentInstance;

    let count = 0;
    cmp.submitMedia.subscribe(() => count++);
    const file = new File([new Uint8Array([1])], 'paste.png', {
      type: 'image/png',
    });
    const { event, preventDefault } = pasteEvent({ files: [file] });

    cmp.onPaste(event);

    expect(count).toBe(0);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  /** Type `value` into the textarea and place the caret (default: at the end). */
  function type(
    fixture: ComponentFixture<MessageComposerComponent>,
    value: string,
    caret = value.length,
  ): HTMLTextAreaElement {
    const ta = fixture.nativeElement.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    ta.value = value;
    ta.selectionStart = ta.selectionEnd = caret;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    return ta;
  }

  const menu = (fixture: ComponentFixture<MessageComposerComponent>) =>
    fixture.nativeElement.querySelector('[data-testid=emoji-autocomplete]');

  it('opens the emoji menu while typing a :shortcode and ranks an exact match first', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, ':joy');

    expect(cmp.emojiQuery()).toBe('joy');
    expect(menu(fixture)).not.toBeNull();
    expect(cmp.emojiMatches()[0].native).toBe('😂');
  });

  it('accepts the highlighted emoji on Enter without sending the message', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    let sent = 0;
    cmp.submitText.subscribe(() => sent++);

    type(fixture, ':joy');
    cmp.onEnter(enter());

    expect(cmp.text()).toBe('😂');
    expect(sent).toBe(0);
    expect(cmp.emojiOpen()).toBe(false);
  });

  it('replaces only the :shortcode token, preserving surrounding text', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, 'hi :joy');
    cmp.onEnter(enter());

    expect(cmp.text()).toBe('hi 😂');
  });

  it('moves the highlight with the arrow keys before accepting', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, ':joy');
    const second = cmp.emojiMatches()[1].native;
    cmp.onArrowDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(cmp.emojiActiveIndex()).toBe(1);
    cmp.onEnter(enter());

    expect(cmp.text()).toBe(second);
  });

  it('closes the menu on Escape without cancelling an active reply', async () => {
    const { fixture } = await renderComposer({ replyingTo: 'Alice' });
    const cmp = fixture.componentInstance;

    let cancelled = 0;
    cmp.cancelReply.subscribe(() => cancelled++);

    type(fixture, ':joy');
    cmp.onEscape();
    expect(cmp.emojiOpen()).toBe(false);
    expect(cancelled).toBe(0);

    cmp.onEscape(); // menu already closed → now cancels the reply
    expect(cancelled).toBe(1);
  });

  it('converts a fully typed :shortcode: to its emoji inline', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, 'party :tada:');

    expect(cmp.text()).toBe('party 🎉');
    expect(cmp.emojiOpen()).toBe(false);
  });

  it('inserts the emoji when a suggestion is clicked', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, ':fire');
    const option = menu(fixture).querySelector('button') as HTMLButtonElement;
    option.click();

    expect(cmp.text()).toBe('🔥');
    expect(cmp.emojiOpen()).toBe(false);
  });

  it('does not trigger on a colon that is not a shortcode boundary', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, '8:30');
    expect(cmp.emojiOpen()).toBe(false);
    expect(menu(fixture)).toBeNull();

    type(fixture, 'http://');
    expect(cmp.emojiOpen()).toBe(false);
  });

  it('accepts on Tab when open and leaves Tab alone when closed', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, ':joy');
    const open = new KeyboardEvent('keydown', { key: 'Tab' });
    const openPrevent = vi.spyOn(open, 'preventDefault');
    cmp.onTab(open);

    expect(cmp.text()).toBe('😂');
    expect(cmp.emojiOpen()).toBe(false);
    expect(openPrevent).toHaveBeenCalled();

    // Menu closed → Tab must keep its native focus-moving behaviour.
    const closed = new KeyboardEvent('keydown', { key: 'Tab' });
    const closedPrevent = vi.spyOn(closed, 'preventDefault');
    cmp.onTab(closed);
    expect(closedPrevent).not.toHaveBeenCalled();
  });

  it('replaces a :shortcode in the middle of the text (caret not at end)', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, 'hey :joy there', 8); // caret right after ":joy"
    cmp.onEnter(enter());

    expect(cmp.text()).toBe('hey 😂 there');
  });

  it('resets the highlight to the first item when the result set changes', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, ':joy');
    cmp.onArrowDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(cmp.emojiActiveIndex()).toBe(1);

    type(fixture, ':grin'); // different matches → effect resets the index
    expect(cmp.emojiMatches().length).toBeGreaterThan(1);
    expect(cmp.emojiActiveIndex()).toBe(0);
  });

  it('does not open the menu while an IME composition is in progress', async () => {
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;

    ta.value = ':joy';
    ta.selectionStart = ta.selectionEnd = 4;
    const composing = new Event('input', { bubbles: true });
    Object.defineProperty(composing, 'isComposing', { value: true });
    ta.dispatchEvent(composing);
    fixture.detectChanges();

    expect(cmp.emojiOpen()).toBe(false);

    // Once composition ends, the next (non-composing) input opens it.
    type(fixture, ':joy');
    expect(cmp.emojiOpen()).toBe(true);
  });

  it('lets an IME-confirming Enter pass through without accepting or sending', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    let sent = 0;
    cmp.submitText.subscribe(() => sent++);

    type(fixture, ':joy');
    const composingEnter = new KeyboardEvent('keydown', { key: 'Enter' });
    Object.defineProperty(composingEnter, 'isComposing', { value: true });
    cmp.onEnter(composingEnter);

    expect(cmp.text()).toBe(':joy'); // not accepted
    expect(sent).toBe(0); // not sent
    expect(cmp.emojiOpen()).toBe(true); // menu still open

    cmp.onEnter(enter()); // a real Enter then accepts
    expect(cmp.text()).toBe('😂');
  });

  it('resolves the +1/-1 shortcodes through the emoji index', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, ':+1');
    expect(cmp.emojiMatches()[0].native).toBe('👍');
    cmp.onEnter(enter());
    expect(cmp.text()).toBe('👍');
  });

  it('renders each suggestion with its native emoji and :colons: label', async () => {
    const { fixture } = await renderComposer();

    type(fixture, ':joy');
    const first = menu(fixture).querySelector('.composer__emoji-suggestion');
    expect(
      first.querySelector('.composer__emoji-suggestion-char').textContent,
    ).toContain('😂');
    expect(
      first.querySelector('.composer__emoji-suggestion-code').textContent,
    ).toContain(':joy:');
  });

  it('does not inline-convert a token that is not a real shortcode', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    // "happy" is only a search keyword, never a shortcode → stays literal.
    type(fixture, 'x :happy:');
    expect(cmp.text()).toBe('x :happy:');
  });

  // --- GIF picker -----------------------------------------------------------

  const gifResult: GifResult = {
    id: 'g1',
    description: 'Happy Cat',
    previewUrl: 'https://x/tiny',
    previewWidth: 1,
    previewHeight: 1,
    url: 'https://x/gif',
    width: 2,
    height: 2,
  };

  /** Providers that enable the GIF affordance and stub the download to `file`. */
  function gifProviders(
    download: () => ReturnType<GifService['download']> = () =>
      of(
        new File([new Uint8Array([1])], 'happy-cat.gif', { type: 'image/gif' }),
      ),
  ): Provider[] {
    return [
      MockProvider(GifSettingsService, {
        provider: signal<GifProviderId>('tenor').asReadonly(),
        apiKey: signal('KEY').asReadonly(),
        configured: signal(true).asReadonly(),
      }),
      MockProvider(GifService, { download }),
    ];
  }

  it('hides the GIF button when no GIF provider is configured', async () => {
    const { container } = await renderComposer();
    expect(container.querySelector('[data-testid=composer-gif]')).toBeNull();
  });

  it('shows the GIF button when a provider + key are configured', async () => {
    const { container } = await renderComposer({}, gifProviders());
    expect(
      container.querySelector('[data-testid=composer-gif]'),
    ).not.toBeNull();
  });

  it('opening the GIF picker closes the emoji picker and vice versa', async () => {
    const { fixture } = await renderComposer({}, gifProviders());
    const cmp = fixture.componentInstance;

    cmp.pickerOpen.set(true);
    cmp.toggleGifPicker();
    expect(cmp.gifPickerOpen()).toBe(true);
    expect(cmp.pickerOpen()).toBe(false);

    cmp.toggleEmojiPicker();
    expect(cmp.pickerOpen()).toBe(true);
    expect(cmp.gifPickerOpen()).toBe(false);
  });

  it('downloads a chosen GIF and sends it as media, closing the picker', async () => {
    const download = vi.fn(() =>
      of(
        new File([new Uint8Array([1])], 'happy-cat.gif', { type: 'image/gif' }),
      ),
    );
    const { fixture } = await renderComposer({}, gifProviders(download));
    const cmp = fixture.componentInstance;
    cmp.gifPickerOpen.set(true);

    let emitted: { file: File; caption: string } | undefined;
    cmp.submitMedia.subscribe((e) => (emitted = e));

    cmp.onGifSelect(gifResult);

    expect(download).toHaveBeenCalledWith(gifResult);
    expect(emitted?.file.type).toBe('image/gif');
    expect(emitted?.caption).toBe('');
    expect(cmp.gifPickerOpen()).toBe(false);
    expect(cmp.gifDownloading()).toBe(false);
  });

  it('ends an active reply when a GIF is sent (media carries no reply relation)', async () => {
    const { fixture } = await renderComposer(
      { replyingTo: 'Alice' },
      gifProviders(),
    );
    const cmp = fixture.componentInstance;

    let cancelled = false;
    cmp.cancelReply.subscribe(() => (cancelled = true));
    cmp.onGifSelect(gifResult);

    expect(cancelled).toBe(true);
  });

  it('toasts when a GIF download fails', async () => {
    const { fixture } = await renderComposer(
      {},
      gifProviders(() => throwError(() => new Error('nope'))),
    );
    const cmp = fixture.componentInstance;

    cmp.onGifSelect(gifResult);
    await Promise.resolve();

    const toast = TestBed.inject(TrnToastService);
    expect(toast.show).toHaveBeenCalledWith(
      expect.stringContaining('Could not load'),
      expect.objectContaining({ variant: 'destructive' }),
    );
    expect(cmp.gifDownloading()).toBe(false);
  });
});
