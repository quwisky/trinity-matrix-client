import { ApplicationRef, signal, type Provider } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { render, type ComponentInput } from '@trinity/testing';
import { type BatchItem } from '../shared/send-media-batch';
import { MockProvider } from 'ng-mocks';
import {
  ComposerSettingsService,
  DraftStoreService,
  VoiceRecorderService,
} from '@trinity/platform-native';
import {
  GifService,
  GifSettingsService,
  type GifProviderId,
  type GifResult,
} from '@trinity/data-access/gif';
import { TrnToastService } from '@trinity/components/overlay';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import {
  MessageComposerComponent,
  type ComposerSubmit,
} from './message-composer.component';
import { MediaPickerService } from '../media-picker/media-picker.service';
import { LocationShareService } from '../location-share/location-share.service';
import { type BatchOutcome } from '../shared/send-media-batch';

// The draft store persists to Capacitor Preferences (debounced); stub it so the
// composer's real DraftStoreService is a no-op on the storage side.
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn().mockResolvedValue({ value: null }),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

/** The staged files, in order — the list equivalent of the old scalar `pendingFile()`. */
const stagedFiles = (cmp: MessageComposerComponent): readonly File[] =>
  cmp.staged().map((attachment) => attachment.file);

/**
 * Subscribe to `submitMedia`, record the filenames dispatched, and report every item as
 * delivered — which is what drains the strip, exactly as the owner's batch outcome does.
 */
function collectSends(cmp: MessageComposerComponent): string[] {
  const names: string[] = [];
  cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
    names.push(...items.map((item) => item.file.name));
    onOutcomes(items.map((item) => ({ id: item.id, failed: false })));
  });
  return names;
}

/** As above, but reports every item as FAILED, so they stay staged for a retry. */
/**
 * Like `collectSends`, but never reports outcomes — which is what an upload still running looks
 * like to the composer. Reporting them synchronously drains the staging and would make the
 * concurrency tests below pass for the wrong reason.
 */
function collectHeldSends(cmp: MessageComposerComponent): string[] {
  const names: string[] = [];
  cmp.submitMedia.subscribe(({ items }) => {
    names.push(...items.map((item) => item.file.name));
  });
  return names;
}

describe('MessageComposerComponent', () => {
  let createObjectURL: Mock;
  let revokeObjectURL: Mock;

  beforeEach(() => {
    // Node supplies a real object-URL API here, so this stub is for determinism and spying
    // rather than absence — which matters, because a dropped stub would now silently work
    // instead of throwing. A COUNTER, not a constant: with several files staged the URLs must
    // be distinguishable, and a constant made every revoke assertion vacuous.
    let issued = 0;
    createObjectURL = vi.fn(() => `blob:preview-${++issued}`);
    revokeObjectURL = vi.fn();
    URL.createObjectURL =
      createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL =
      revokeObjectURL as unknown as typeof URL.revokeObjectURL;
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

  it('stages a picked file and sends it with the typed caption on submit', async () => {
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;

    let emitted: { items: readonly BatchItem[]; caption: string } | undefined;
    cmp.submitMedia.subscribe((e) => {
      emitted = e;
      e.onOutcomes(e.items.map((i) => ({ id: i.id, failed: false })));
    });

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
    expect(stagedFiles(cmp)).toEqual([file]);
    expect(emitted).toBeUndefined();
    expect(input.value).toBe('');

    // A caption + Enter sends the file and caption together, then clears.
    cmp.text.set('nice shot');
    cmp.submit();
    expect(emitted?.items.map((i) => i.file)).toEqual([file]);
    expect(emitted?.caption).toBe('nice shot');
    expect(stagedFiles(cmp)).toEqual([]);
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
    // Stand in for the native picker: available, but pickImages errors (e.g. denied
    // photo access) instead of resolving files.
    const { fixture } = await renderComposer({}, [
      MockProvider(MediaPickerService, {
        available: true,
        pickImages: () =>
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
    const wrapper = () =>
      container.querySelector('[data-testid=upload-progress]');
    const bar = () =>
      container.querySelector(
        'trn-progress [role="progressbar"]',
      ) as HTMLElement | null;

    // Idle: no progress UI.
    expect(wrapper()).toBeNull();

    // Mid-upload with a real fraction → determinate bar bound to the value.
    fixture.componentRef.setInput('uploadProgress', {
      index: 1,
      total: 1,
      fraction: 0.42,
    });
    fixture.detectChanges();
    expect(wrapper()).not.toBeNull();
    expect(bar()).not.toBeNull();
    // Determinate → the fraction is exposed as a 0–100 percentage on aria-valuenow
    // (helm/BrnProgress uses a 0–max scale with max defaulting to 100).
    expect(Number(bar()?.getAttribute('aria-valuenow'))).toBeCloseTo(42, 5);
    expect(wrapper()?.textContent).toContain('42%');

    // Just started (0, before the first real tick) → indeterminate, no percent.
    fixture.componentRef.setInput('uploadProgress', {
      index: 1,
      total: 1,
      fraction: 0,
    });
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

  it('keeps the attach action usable while an upload is in flight', async () => {
    // It used to be blocked, and that was right when a send took one file: staging during an
    // upload would have had nowhere to go. A send now takes the whole staged batch, so a file
    // added mid-upload simply waits for the next press — and refusing it means a user who
    // remembers a fifth screenshot has to wait out the other four.
    const { fixture } = await renderComposer();
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
      ?.click();
    await fixture.whenStable();
    // hlmDropdownMenuItem reflects [disabled] as the data-disabled attribute.
    const disabled = (): string | null | undefined =>
      document
        .querySelector('[data-testid=insert-attach]')
        ?.getAttribute('data-disabled');

    expect(disabled()).toBeNull();

    fixture.componentRef.setInput('uploadProgress', {
      index: 1,
      total: 3,
      fraction: 0.1,
    });
    fixture.detectChanges();
    expect(disabled()).toBeNull();
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
      native: '😎',
      id: 'sunglasses',
      colons: ':sunglasses:',
    });

    expect(cmp.text()).toBe('a😎b');
    expect(cmp.pickerOpen()).toBe(false);
  });

  it('points the emoji trigger at the panel that actually exists', async () => {
    // Two independent string literals — `pickerId` on the panel and `aria-controls` on the
    // trigger — with nothing tying them together. A typo in either leaves a button
    // referencing an id that is not in the document, which is silent: the attribute is
    // present, it just resolves to nothing. Same shape as the aria-describedby defect in
    // #153, which is why it is asserted rather than assumed.
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const trigger = container.querySelector<HTMLElement>('.composer__emoji');

    // Closed: nothing to control, so no dangling reference.
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.getAttribute('aria-controls')).toBeNull();

    cmp.pickerOpen.set(true);
    fixture.detectChanges();

    const controls = trigger?.getAttribute('aria-controls');
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(controls).toBeTruthy();
    expect(container.querySelector(`#${controls}`)).not.toBeNull();
  });

  function pasteEvent(opts: { files?: File[]; items?: unknown[] }): {
    event: ClipboardEvent;
    preventDefault: Mock;
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

    let emitted: { items: readonly BatchItem[]; caption: string } | undefined;
    cmp.submitMedia.subscribe((e) => {
      emitted = e;
      e.onOutcomes(e.items.map((i) => ({ id: i.id, failed: false })));
    });
    const file = new File([new Uint8Array([1])], 'paste.png', {
      type: 'image/png',
    });
    const { event, preventDefault } = pasteEvent({ files: [file] });

    cmp.onPaste(event);

    expect(stagedFiles(cmp)).toEqual([file]);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(emitted).toBeUndefined();

    cmp.submit(); // no caption typed
    expect(emitted?.items.map((i) => i.file)).toEqual([file]);
    expect(emitted?.caption).toBe('');
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

    expect(stagedFiles(cmp)).toEqual([file]);
  });

  it('discards a staged attachment when the room changes', async () => {
    const { fixture } = await renderComposer({ roomId: '!a:hs' });
    const cmp = fixture.componentInstance;

    const file = new File([new Uint8Array([1])], 'pic.png', {
      type: 'image/png',
    });
    cmp.onPaste(pasteEvent({ files: [file] }).event);
    expect(stagedFiles(cmp)).toEqual([file]);

    // Switch room — the file was staged for room A and must not leak into B.
    fixture.componentRef.setInput('roomId', '!b:hs');
    fixture.detectChanges();
    expect(stagedFiles(cmp)).toEqual([]);
  });

  it('Escape discards a staged attachment', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    const file = new File([new Uint8Array([1])], 'pic.png', {
      type: 'image/png',
    });
    cmp.onPaste(pasteEvent({ files: [file] }).event);
    expect(stagedFiles(cmp)).toEqual([file]);

    cmp.onEscape();
    expect(stagedFiles(cmp)).toEqual([]);
  });

  it('ends an active reply when a staged attachment is sent', async () => {
    const { fixture } = await renderComposer({ replyingTo: 'Alice' });
    const cmp = fixture.componentInstance;

    let cancelledReply = false;
    cmp.cancelReply.subscribe(() => (cancelledReply = true));
    let emitted: { items: readonly BatchItem[]; caption: string } | undefined;
    cmp.submitMedia.subscribe((e) => {
      emitted = e;
      e.onOutcomes(e.items.map((i) => ({ id: i.id, failed: false })));
    });

    const file = new File([new Uint8Array([1])], 'pic.png', {
      type: 'image/png',
    });
    cmp.onPaste(pasteEvent({ files: [file] }).event);
    cmp.submit();

    // Media carries no reply relation, so the reply banner must be cleared
    // (otherwise the next plain message would silently reply to Alice).
    expect(emitted?.items.map((i) => i.file)).toEqual([file]);
    expect(emitted?.caption).toBe('');
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

    expect(stagedFiles(cmp)).toEqual([]);
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

  /** Fire the hidden file input's change event with `files` attached. */
  function pickFiles(
    cmp: MessageComposerComponent,
    files: File[],
  ): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'file';
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    cmp.onFilePicked({ target: input } as unknown as Event);
    return input;
  }

  const png = (name: string) =>
    new File([new Uint8Array([1])], name, { type: 'image/png' });

  it('lets the OS dialog offer more than one file', async () => {
    // Without `multiple` the dialog will not let you select two, so every other part of this
    // is unreachable from the picker — and nothing else in the suite looks at the attribute.
    const { container } = await renderComposer();

    expect(
      container
        .querySelector('[data-testid=composer-file-input]')
        ?.hasAttribute('multiple'),
    ).toBe(true);
  });

  it('stages every file the picker returns, in order', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    pickFiles(cmp, [png('one.png'), png('two.png'), png('three.png')]);

    expect(stagedFiles(cmp).map((f) => f.name)).toEqual([
      'one.png',
      'two.png',
      'three.png',
    ]);
  });

  it('appends a second pick rather than replacing the first', async () => {
    // "An obvious way to add more before sending" is the picker itself; replacing would
    // silently discard what the user already chose.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    pickFiles(cmp, [png('one.png')]);
    pickFiles(cmp, [png('two.png')]);

    expect(stagedFiles(cmp).map((f) => f.name)).toEqual(['one.png', 'two.png']);
  });

  it('stages every pasted image, not just the first', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    const { event, preventDefault } = pasteEvent({
      files: [png('a.png'), png('b.png')],
    });
    cmp.onPaste(event);

    expect(stagedFiles(cmp).map((f) => f.name)).toEqual(['a.png', 'b.png']);
    expect(preventDefault).toHaveBeenCalled();
  });

  it('stages every image from a WebKit-style clipboard item list', async () => {
    // The `items` fallback path, which older WebKit uses instead of `files`.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const [first, second] = [png('a.png'), png('b.png')];

    cmp.onPaste(
      pasteEvent({
        items: [
          { kind: 'file', type: 'image/png', getAsFile: () => first },
          // Each decoy fails exactly ONE half of the predicate AND returns a real file, so
          // dropping either half leaks a name into the result. Decoys returning null cannot
          // do that — the null filter downstream absorbs them and the mutation survives.
          {
            kind: 'string',
            type: 'image/png',
            getAsFile: () => png('decoy-kind.png'),
          },
          {
            kind: 'file',
            type: 'text/plain',
            getAsFile: () => png('decoy-type.png'),
          },
          // A `kind: 'file'` entry the page cannot read — real on Safari, and the reason the
          // null filter exists.
          { kind: 'file', type: 'image/png', getAsFile: () => null },
          { kind: 'file', type: 'image/png', getAsFile: () => second },
        ],
      }).event,
    );

    expect(stagedFiles(cmp).map((f) => f.name)).toEqual(['a.png', 'b.png']);
  });

  it('ignores the non-image half of a mixed clipboard', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    cmp.onPaste(
      pasteEvent({
        files: [
          png('shot.png'),
          new File(['x'], 'notes.txt', { type: 'text/plain' }),
        ],
      }).event,
    );

    expect(stagedFiles(cmp).map((f) => f.name)).toEqual(['shot.png']);
  });

  it('previews images and leaves other files without an object URL', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    pickFiles(cmp, [
      png('shot.png'),
      new File(['x'], 'notes.pdf', { type: 'application/pdf' }),
    ]);

    const previews = cmp.staged().map((a) => a.previewUrl);
    expect(previews[0]).toMatch(/^blob:preview-/);
    expect(previews[1]).toBeNull();
    expect(createObjectURL).toHaveBeenCalledTimes(1); // not for the PDF
  });

  it('ignores a remove for an id that is not staged', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    pickFiles(cmp, [png('one.png')]);
    const before = cmp.staged();

    cmp.removeStaged('attachment-does-not-exist');

    expect(cmp.staged()).toBe(before); // same array, so the strip does not re-render
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('does nothing when the picker is dismissed without choosing', async () => {
    // A cancelled OS dialog still fires `change`, with zero files. Without the guard this
    // steals focus into the textarea and churns the strip for a non-event.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    pickFiles(cmp, [png('one.png')]);
    const before = cmp.staged();

    pickFiles(cmp, []);

    expect(cmp.staged()).toBe(before);
  });

  it('removes one staged attachment and revokes only its preview', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    pickFiles(cmp, [png('one.png'), png('two.png'), png('three.png')]);
    const doomed = cmp.staged()[1];

    cmp.removeStaged(doomed.id);

    expect(stagedFiles(cmp).map((f) => f.name)).toEqual([
      'one.png',
      'three.png',
    ]);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(doomed.previewUrl);
  });

  it('revokes every preview when the batch is cleared', async () => {
    // The scalar model revoked exactly one, which was only ever correct because one was all
    // that could be live. Three staged means three to release.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    pickFiles(cmp, [png('one.png'), png('two.png'), png('three.png')]);
    const urls = cmp.staged().map((a) => a.previewUrl);

    cmp.clearStaged();

    expect(revokeObjectURL).toHaveBeenCalledTimes(3);
    expect(revokeObjectURL.mock.calls.flat()).toEqual(urls);
  });

  it('revokes every preview when the composer is destroyed', async () => {
    const { fixture } = await renderComposer();
    pickFiles(fixture.componentInstance, [png('one.png'), png('two.png')]);

    fixture.destroy();

    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('sends every staged file in one press, in the order staged', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent = collectSends(cmp);
    pickFiles(cmp, [png('one.png'), png('two.png'), png('three.png')]);

    cmp.submit();

    expect(sent).toEqual(['one.png', 'two.png', 'three.png']);
    // Delivered items leave the strip — and every preview with them.
    expect(stagedFiles(cmp)).toEqual([]);
    expect(revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it('keeps the files that failed, and only those', async () => {
    // The reason the batch reports per item rather than throwing: a bad third file must not
    // cost the other four, and what stays in the strip is exactly what to retry.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      onOutcomes(
        items.map((item) => ({
          id: item.id,
          failed: item.file.name === 'bad.png',
        })),
      );
    });
    pickFiles(cmp, [png('one.png'), png('bad.png'), png('three.png')]);

    cmp.submit();

    expect(stagedFiles(cmp).map((f) => f.name)).toEqual(['bad.png']);
  });

  it('marks the files that failed, and unmarks them when a retry succeeds', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    let failNames: string[] = ['bad.png'];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      onOutcomes(
        items.map((item) => ({
          id: item.id,
          failed: failNames.includes(item.file.name),
        })),
      );
    });
    pickFiles(cmp, [png('one.png'), png('bad.png')]);

    cmp.submit();
    expect(stagedFiles(cmp).map((f) => f.name)).toEqual(['bad.png']);
    expect(cmp.staged().map((a) => a.failed)).toEqual([true]);

    // The row is not stuck failed: a successful retry clears the flag by leaving. No
    // `uploadProgress` round-trip — outcomes landing is what releases the latch.
    failNames = [];
    cmp.submit();

    expect(stagedFiles(cmp)).toEqual([]);
  });

  it('retries one failed file without re-sending the rest', async () => {
    // Pressing send again retries everything staged, which is wrong once the user has added
    // more files since — the per-row retry is what sends exactly the one that failed.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const batches: string[][] = [];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      batches.push(items.map((item) => item.file.name));
      onOutcomes(
        items.map((item) => ({
          id: item.id,
          failed: item.file.name === 'bad.png',
        })),
      );
    });
    pickFiles(cmp, [png('one.png'), png('bad.png')]);
    cmp.submit();
    pickFiles(cmp, [png('later.png')]); // added after the failure

    const failedId = cmp.staged().find((a) => a.failed)?.id ?? '';
    cmp['retryStaged'](failedId);

    expect(batches).toEqual([
      ['one.png', 'bad.png'],
      ['bad.png'], // just the one, not `later.png` too
    ]);
    expect(stagedFiles(cmp).map((f) => f.name)).toEqual([
      'bad.png',
      'later.png',
    ]);
  });

  it('posts a batch caption as a plain message, never as the edit in progress', async () => {
    // The window between dispatch and outcomes is the whole upload, and starting an edit in it
    // is an ordinary ungated action. Routed through the composer's CURRENT state, the caption
    // would be applied as the edit — silently rewriting a message already in the room.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const finish: (() => void)[] = [];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      finish.push(() =>
        onOutcomes(items.map((item, i) => ({ id: item.id, failed: i > 0 }))),
      );
    });
    const captions: string[] = [];
    const submits: string[] = [];
    cmp.submitBatchCaption.subscribe((e) => captions.push(e.text));
    cmp.submitText.subscribe((e) => submits.push(e.text));
    pickFiles(cmp, [png('one.png'), png('two.png')]);
    cmp.text.set('check these out');
    cmp.submit();

    // The user starts editing an earlier message while the files upload.
    fixture.componentRef.setInput('editing', true);
    fixture.detectChanges();
    finish[0]?.();

    // It goes out on the channel the host sends plainly — not the one it routes.
    expect(captions).toEqual(['check these out']);
    expect(submits).toEqual([]);
  });

  it('drops a batch caption whose room is no longer open, keeping it as that room’s draft', async () => {
    // `send` resolves the open room on subscribe, so emitting after a switch posts into the
    // NEW conversation. The files are already pinned to their room; the caption was not.
    const { fixture } = await renderComposer({ roomId: '!a:hs' });
    const cmp = fixture.componentInstance;
    const finish: (() => void)[] = [];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      finish.push(() =>
        onOutcomes(items.map((item, i) => ({ id: item.id, failed: i > 0 }))),
      );
    });
    const captions: string[] = [];
    cmp.submitBatchCaption.subscribe((e) => captions.push(e.text));
    pickFiles(cmp, [png('one.png'), png('two.png')]);
    cmp.text.set('here are the photos');
    cmp.submit();

    fixture.componentRef.setInput('roomId', '!b:hs');
    fixture.detectChanges();
    finish[0]?.();

    expect(captions).toEqual([]); // not posted into !b:hs
    expect(cmp.text()).toBe(''); // nor dropped into its composer
    // Not destroyed either: it is waiting where it was written.
    fixture.componentRef.setInput('roomId', '!a:hs');
    fixture.detectChanges();
    expect(cmp.text()).toBe('here are the photos');
  });

  it('does not let Escape clear rows the batch is still reporting on', async () => {
    // The rows stay staged until outcomes land, by design. Clearing them mid-flight leaves a
    // failure with nowhere to go, and the host then promises files are "still in the
    // composer" that the user has just discarded.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(() => undefined); // in flight
    pickFiles(cmp, [png('one.png'), png('two.png')]);
    cmp.submit();

    cmp.onEscape();

    expect(stagedFiles(cmp).map((f) => f.name)).toEqual(['one.png', 'two.png']);
  });

  it('still lets Escape clear staging when nothing is going out', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    pickFiles(cmp, [png('one.png')]);

    cmp.onEscape();

    expect(stagedFiles(cmp)).toEqual([]);
  });

  it('gives the caption back when nothing carried it', async () => {
    // `submit()` clears the box as soon as the batch is dispatched. If every file then fails,
    // the caption rode nothing — and destroying what the user typed is a worse outcome than
    // the failed upload that caused it.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      onOutcomes(items.map((item) => ({ id: item.id, failed: true })));
    });
    pickFiles(cmp, [png('one.png'), png('two.png')]);
    cmp.text.set('here are the photos');

    cmp.submit();

    expect(cmp.text()).toBe('here are the photos');
  });

  it('gives back a single file’s caption too, which rode the send that failed', async () => {
    // One file's caption travels ON the media event (MSC2530), so a failed send takes it with
    // it — there is no separate message left holding it.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      onOutcomes(items.map((item) => ({ id: item.id, failed: true })));
    });
    pickFiles(cmp, [png('one.png')]);
    cmp.text.set('the only one');

    cmp.submit();

    expect(cmp.text()).toBe('the only one');
  });

  it('does not clobber something typed while the batch was going out', async () => {
    // Restoring is for the caption the user lost, not for overwriting the one they are in the
    // middle of writing — outcomes land long after the box was cleared.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const finish: ((outcomes: readonly BatchOutcome[]) => void)[] = [];
    cmp.submitMedia.subscribe(({ onOutcomes }) => finish.push(onOutcomes));
    pickFiles(cmp, [png('one.png')]);
    cmp.text.set('first caption');
    cmp.submit();

    cmp.text.set('second thoughts');
    finish[0]?.([{ id: cmp.staged()[0]?.id ?? '', failed: true }]);

    expect(cmp.text()).toBe('second thoughts');
  });

  it('carries the caption on a per-row retry', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const captions: string[] = [];
    cmp.submitMedia.subscribe(({ caption, items, onOutcomes }) => {
      captions.push(caption);
      onOutcomes(items.map((item) => ({ id: item.id, failed: true })));
    });
    pickFiles(cmp, [png('one.png')]);
    cmp.submit();

    cmp.text.set('trying again');
    cmp['retryStaged'](cmp.staged()[0]?.id ?? '');

    expect(captions).toEqual(['', 'trying again']);
  });

  it('leaves the other failed rows marked when one of them is retried', async () => {
    // The flow the retry button exists for. Reporting one item's outcome must not restate the
    // failure state of files that outcome says nothing about.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    let failNames = ['one.png', 'two.png', 'three.png'];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      onOutcomes(
        items.map((item) => ({
          id: item.id,
          failed: failNames.includes(item.file.name),
        })),
      );
    });
    pickFiles(cmp, [png('one.png'), png('two.png'), png('three.png')]);
    cmp.submit();
    expect(cmp.staged().map((a) => a.failed)).toEqual([true, true, true]);

    failNames = []; // the retry succeeds
    cmp['retryStaged'](cmp.staged()[0]?.id ?? '');

    expect(cmp.staged().map((a) => a.file.name)).toEqual([
      'two.png',
      'three.png',
    ]);
    expect(cmp.staged().map((a) => a.failed)).toEqual([true, true]);
  });

  it('leaves the failed rows marked when a GIF is sent past them', async () => {
    // A GIF dispatches with a synthetic id that matches nothing staged, so an outcome handler
    // that restates the whole list would wipe every marker in the strip.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      onOutcomes(
        items.map((item) => ({
          id: item.id,
          failed: !item.id.startsWith('direct-'),
        })),
      );
    });
    pickFiles(cmp, [png('one.png')]);
    cmp.submit();
    expect(cmp.staged().map((a) => a.failed)).toEqual([true]);

    // Exactly the call the attachments service's `sendMedia` hook makes for a chosen GIF.
    cmp['dispatchMedia'](
      [{ id: 'direct-cat.gif', file: png('cat.gif') }],
      '',
      [],
    );

    expect(cmp.staged().map((a) => a.failed)).toEqual([true]);
  });

  it('stops showing a retried file as failed while its retry is in flight', async () => {
    // Otherwise the row you just pressed retry on still reads "Not sent" for the whole
    // upload, which is indistinguishable from the press having done nothing.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    let hold = false;
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      if (hold) {
        return; // in flight: outcomes have not landed yet
      }
      onOutcomes(items.map((item) => ({ id: item.id, failed: true })));
    });
    pickFiles(cmp, [png('one.png'), png('two.png')]);
    cmp.submit();
    expect(cmp.staged().map((a) => a.failed)).toEqual([true, true]);

    hold = true;
    cmp['retryStaged'](cmp.staged()[0]?.id ?? '');

    // The retried one is uploading; its sibling has not been touched.
    expect(cmp.staged().map((a) => a.failed)).toEqual([false, true]);
  });

  it('sends a batch caption as its own message, after the files', async () => {
    // Matrix has no multi-attachment event, so there is no first image for a batch caption to
    // belong to, and repeating it on each would put the same sentence in the room N times.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent = collectSends(cmp);
    const texts: string[] = [];
    cmp.submitBatchCaption.subscribe((e) => texts.push(e.text));
    pickFiles(cmp, [png('one.png'), png('two.png')]);
    cmp.text.set('both of these');

    cmp.submit();

    expect(sent).toEqual(['one.png', 'two.png']);
    expect(texts).toEqual(['both of these']);
  });

  it('leaves a single file’s caption on the media event', async () => {
    // One file keeps its MSC2530 caption, which is what the existing e2e round-trip asserts.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    let seen: string | undefined;
    cmp.submitMedia.subscribe(({ items, caption, onOutcomes }) => {
      seen = caption;
      onOutcomes(items.map((item) => ({ id: item.id, failed: false })));
    });
    const texts: string[] = [];
    cmp.submitText.subscribe((e) => texts.push(e.text));
    pickFiles(cmp, [png('one.png')]);
    cmp.text.set('just this one');

    cmp.submit();

    expect(seen).toBe('just this one');
    expect(texts).toEqual([]); // no separate message
  });

  it('refuses a second batch while the first is still uploading', async () => {
    // Two batches in flight share one `uploadProgress` — the first to finish nulls it, hiding
    // the bar for the other — and interleave their events, so neither arrives in the order
    // staged. Staging more mid-flight is allowed; starting a second batch is not.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent = collectHeldSends(cmp);
    pickFiles(cmp, [png('one.png')]);

    cmp.submit();
    fixture.componentRef.setInput('uploadProgress', {
      index: 1,
      total: 1,
      fraction: 0.3,
    }); // the host reports it in flight
    fixture.detectChanges();
    pickFiles(cmp, [png('two.png')]);
    cmp.submit();

    expect(sent).toEqual(['one.png']);
  });

  it('guards the keyboard path too, and shows the button as disabled', async () => {
    // `onEnter` calls `submit()` directly and never consults `[disabled]`, so the code guard
    // is what stops it — and the button has to SAY so, or the block reads as a dead control.
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent = collectHeldSends(cmp);
    pickFiles(cmp, [png('one.png')]);
    cmp.submit();
    fixture.componentRef.setInput('uploadProgress', {
      index: 1,
      total: 1,
      fraction: 0.3,
    });
    fixture.detectChanges();
    pickFiles(cmp, [png('two.png')]);

    cmp.onEnter(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(sent).toEqual(['one.png']);
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid=composer-send]')
        ?.disabled,
    ).toBe(true);
  });

  it('shows which file the upload bar belongs to', async () => {
    // The bar renders above the rows still staged; unlabelled it reads as though it describes
    // them, when it describes the one that just left the list.
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    pickFiles(cmp, [png('one.png'), png('two.png')]);

    cmp.submit();
    fixture.componentRef.setInput('uploadProgress', {
      index: 1,
      total: 1,
      fraction: 0.3,
    });
    fixture.detectChanges();

    expect(
      container.querySelector('[data-testid=upload-progress]')?.textContent,
    ).toContain('one.png');
  });

  it('renders every staged file and removes the one whose × is pressed', async () => {
    // The composer→strip wiring, which nothing covered: `[staged]` bound to an empty array,
    // or the × routed to `clearStaged`, both shipped with the whole suite green — and the
    // second is exactly the batch-wipe this change exists to avoid.
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    pickFiles(cmp, [png('one.png'), png('two.png'), png('three.png')]);
    fixture.detectChanges();

    const rows = container.querySelectorAll('[data-testid=composer-pending]');
    expect(rows).toHaveLength(3);

    container
      .querySelectorAll<HTMLElement>('[data-testid=composer-pending-remove]')[1]
      ?.click();
    fixture.detectChanges();

    expect(stagedFiles(cmp).map((f) => f.name)).toEqual([
      'one.png',
      'three.png',
    ]);
  });

  it('does not dispatch twice from two presses in the same task', async () => {
    // The case a held Enter key produces, and the one a guard on `uploadProgress` ALONE
    // cannot catch: that is a signal input fed two component layers up, and a signal input is
    // only written during the parent's change detection. Both presses would read `null`.
    // Deliberately no `detectChanges()` between them — inserting one is what made the earlier
    // version of this test pass against the defect. Outcomes are withheld for the same
    // reason: in production they land when the batch ENDS, so until then the files that the
    // second press would re-send are all still staged.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent = collectHeldSends(cmp);
    pickFiles(cmp, [png('one.png'), png('two.png')]);

    cmp.submit();
    cmp.submit();

    expect(sent).toEqual(['one.png', 'two.png']); // each file once, from the first press
  });

  it('allows the next batch once the first one finishes', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent: string[] = [];
    const finish: ((outcomes: readonly BatchOutcome[]) => void)[] = [];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      sent.push(...items.map((item) => item.file.name));
      finish.push(onOutcomes); // held, the way a real upload holds it
    });
    pickFiles(cmp, [png('one.png')]);

    cmp.submit();
    // The bar comes and goes, but it is the host's own report that releases the latch — the
    // bar's value is not always observable, and inferring from it is what stranded it before.
    fixture.componentRef.setInput('uploadProgress', {
      index: 1,
      total: 1,
      fraction: 0.3,
    });
    fixture.detectChanges();
    cmp.submit();
    expect(sent).toEqual(['one.png']); // still latched

    fixture.componentRef.setInput('uploadProgress', null);
    fixture.detectChanges();
    cmp.submit();
    expect(sent).toEqual(['one.png']); // the bar clearing is NOT what releases it

    finish[0]?.([{ id: cmp.staged()[0]?.id ?? '', failed: true }]);
    cmp.submit();

    expect(sent).toEqual(['one.png', 'one.png']); // failed, so still staged and resendable
  });

  it('keeps what you typed when a send is refused', async () => {
    // A refusal must leave the composer exactly as it found it. Falling through would clear
    // the caption for a send that never happened — the user's words, gone, with the files
    // still sitting in the strip and nothing to say why.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(() => undefined); // in flight: outcomes never arrive
    pickFiles(cmp, [png('one.png')]);
    cmp.submit();

    cmp.text.set('a caption I typed');
    cmp.submit(); // refused — a batch is already going out

    expect(cmp.text()).toBe('a caption I typed');
  });

  it('shows the send button as blocked before the progress bar has caught up', async () => {
    // The window the button clause exists for: between the dispatch and the parent's change
    // detection, `uploadProgress` is still null. Reading only that leaves the button live
    // while `submit()` refuses — a control that looks pressable and does nothing.
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(() => undefined); // in flight: `done` is never called
    pickFiles(cmp, [png('one.png'), png('two.png')]);

    cmp.submit();
    fixture.detectChanges(); // CD runs, but the host has reported nothing yet

    expect(
      container.querySelector<HTMLButtonElement>('[data-testid=composer-send]')
        ?.disabled,
    ).toBe(true);
  });

  it('closes the GIF grid on a send, so it cannot outlive one', async () => {
    // Grid items call `sendMedia` directly and are not disabled while an upload runs, so a
    // grid still open after a send is the last route to two uploads at once.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(() => undefined);
    cmp.gifPickerOpen.set(true);
    pickFiles(cmp, [png('one.png')]);

    cmp.submit();

    expect(cmp.gifPickerOpen()).toBe(false);
  });

  it('releases the latch when a send finishes without the bar ever appearing', async () => {
    // The host brackets an upload with `set(0)` … `finalize(set(null))`, and `sendMedia`
    // completes SYNCHRONOUSLY for a 0-byte file — so the host's signal goes null → 0 → null
    // inside the emit. A signal input only ever takes the value present at change detection,
    // and Angular skips the write entirely when it is `Object.is`-equal, so `uploadProgress`
    // never changes and an effect watching it never re-runs. Releasing on the host's own
    // report is what makes the latch independent of whether that value was ever observable.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent: string[] = [];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      sent.push(...items.map((item) => item.file.name));
      // Settled before the emit returned; both files failed, so both stay staged.
      onOutcomes(items.map((item) => ({ id: item.id, failed: true })));
    });
    pickFiles(cmp, [png('one.png'), png('two.png')]);

    cmp.submit();
    cmp.submit();

    expect(sent).toEqual(['one.png', 'two.png', 'one.png', 'two.png']);
  });

  it('does not strand the latch when the room changes mid-upload', async () => {
    // The upload belongs to the page and survives the switch, but nothing staged here does —
    // holding the latch would mute the next room's composer for an upload it cannot see.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent = collectSends(cmp);
    pickFiles(cmp, [png('one.png')]);
    cmp.submit();

    fixture.componentRef.setInput('roomId', '!other:hs');
    fixture.detectChanges();
    pickFiles(cmp, [png('elsewhere.png')]);
    cmp.submit();

    expect(sent).toEqual(['one.png', 'elsewhere.png']);
  });

  it('clearStaged drops every staged attachment', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    const file = new File([new Uint8Array([1])], 'x.png', {
      type: 'image/png',
    });
    cmp.onPaste(pasteEvent({ files: [file] }).event);
    expect(stagedFiles(cmp)).toHaveLength(1);

    cmp.clearStaged();
    expect(stagedFiles(cmp)).toEqual([]);
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

  it('stages a pasted image even while an upload is in flight', async () => {
    // Staging is not sending. The batch goes out on the next press, so a screenshot pasted
    // mid-upload joins the queue instead of being silently swallowed.
    const { fixture } = await renderComposer({
      uploadProgress: { index: 1, total: 3, fraction: 0.5 },
    });
    const cmp = fixture.componentInstance;

    const file = new File([new Uint8Array([1])], 'paste.png', {
      type: 'image/png',
    });
    const { event, preventDefault } = pasteEvent({ files: [file] });

    cmp.onPaste(event);

    expect(stagedFiles(cmp).map((f) => f.name)).toEqual(['paste.png']);
    expect(preventDefault).toHaveBeenCalled(); // and not also dropped into the textarea
  });

  it('stages dropped files, but not while editing', async () => {
    // The overlay is hidden during an edit, so the user is not invited to drop — but the
    // drop still fires, and an edit cannot become media. The refusal has to be here, where
    // every route in shares it, rather than in the affordance that merely hides.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    cmp.stageFiles([png('dropped.png')]);
    expect(stagedFiles(cmp).map((f) => f.name)).toEqual(['dropped.png']);

    cmp.clearStaged();
    fixture.componentRef.setInput('editing', true);
    fixture.detectChanges();
    cmp.stageFiles([png('while-editing.png')]);

    expect(stagedFiles(cmp)).toEqual([]);
  });

  it('still ignores a pasted image while editing', async () => {
    // An edit cannot become media, so the paste belongs to the textarea.
    const { fixture } = await renderComposer({ editing: true });
    const cmp = fixture.componentInstance;
    const file = new File([new Uint8Array([1])], 'paste.png', {
      type: 'image/png',
    });
    const { event, preventDefault } = pasteEvent({ files: [file] });

    cmp.onPaste(event);

    expect(stagedFiles(cmp)).toEqual([]);
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
        provider: signal<GifProviderId>('klipy').asReadonly(),
        apiKey: signal('KEY').asReadonly(),
        configured: signal(true).asReadonly(),
      }),
      MockProvider(GifService, { download }),
    ];
  }

  it('omits GIF from the tray when no provider is configured', async () => {
    const { fixture } = await renderComposer();
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
      ?.click();
    await fixture.whenStable();
    expect(document.querySelector('[data-testid=insert-gif]')).toBeNull();
  });

  it('offers GIF in the tray when a provider + key are configured', async () => {
    const { fixture } = await renderComposer({}, gifProviders());
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
      ?.click();
    await fixture.whenStable();
    expect(document.querySelector('[data-testid=insert-gif]')).not.toBeNull();
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

    let emitted: { items: readonly BatchItem[]; caption: string } | undefined;
    cmp.submitMedia.subscribe((e) => {
      emitted = e;
      e.onOutcomes(e.items.map((i) => ({ id: i.id, failed: false })));
    });

    cmp.onGifSelect(gifResult);

    expect(download).toHaveBeenCalledWith(gifResult);
    expect(emitted?.items[0]?.file.type).toBe('image/gif');
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

  describe('insert tray', () => {
    // Every compose action lives behind the `+` at all widths: a dropdown when there is
    // more than one to offer (hasInsertMenu), a plain attach button when there is not.
    it('offers the tray whenever more than one insert action exists', async () => {
      const { container } = await renderComposer({}, [
        MockProvider(VoiceRecorderService, { supported: true }),
      ]);

      expect(
        container.querySelector('[data-testid=composer-insert]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid=composer-insert-attach]'),
      ).toBeNull();
    });

    it('falls back to a plain attach button when the tray would hold one item', async () => {
      // Thread composer with no GIF provider: attach is the only insert action left,
      // so a one-item menu would be pure friction.
      const { container } = await renderComposer({ richActions: false }, [
        MockProvider(GifSettingsService, { configured: signal(false) }),
      ]);

      expect(
        container.querySelector('[data-testid=composer-insert]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid=composer-insert-attach]'),
      ).not.toBeNull();
    });

    it('omits the room-only actions from the opened tray when richActions is off', async () => {
      // The thread composer routes poll/location/voice to the room, not the thread, so
      // they must not appear in its tray. Asserting it needs the menu opened — CDK only
      // instantiates the ng-template on open, at the document root.
      const { fixture } = await renderComposer({ richActions: false }, [
        MockProvider(GifSettingsService, { configured: signal(true) }),
        MockProvider(VoiceRecorderService, { supported: true }),
      ]);

      (fixture.nativeElement as HTMLElement)

        .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
        ?.click();
      await fixture.whenStable();

      for (const id of ['insert-poll', 'insert-location', 'insert-voice']) {
        expect(document.querySelector(`[data-testid=${id}]`)).toBeNull();
      }
      // ...while the actions that *are* thread-safe still appear.
      expect(
        document.querySelector('[data-testid=insert-attach]'),
      ).not.toBeNull();
      expect(document.querySelector('[data-testid=insert-gif]')).not.toBeNull();
    });

    it('offers every insert action in the tray with full config', async () => {
      const { fixture } = await renderComposer({}, [
        MockProvider(GifSettingsService, {
          configured: signal(true).asReadonly(),
        }),
        MockProvider(VoiceRecorderService, { supported: true }),
      ]);
      (fixture.nativeElement as HTMLElement)
        .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
        ?.click();
      await fixture.whenStable();

      for (const id of [
        'insert-attach',
        'insert-gif',
        'insert-poll',
        'insert-location',
        'insert-voice',
      ]) {
        expect(document.querySelector(`[data-testid=${id}]`)).not.toBeNull();
      }
    });

    it('wires each tray item to its handler', async () => {
      // The wiring the change moved from inline buttons to tray items: each item's
      // (triggered) must call the right method. A CDK menu item fires on click only
      // after a full ApplicationRef.tick() (the overlay is a root view, not the fixture
      // view), and it closes the menu after firing — so re-open the tray per item.
      // Handlers are spied so their side effects (dialogs, services) don't run.
      const { fixture } = await renderComposer({}, [
        MockProvider(GifSettingsService, {
          configured: signal(true).asReadonly(),
        }),
        MockProvider(VoiceRecorderService, { supported: true }),
      ]);
      const cmp = fixture.componentInstance;
      const appRef = TestBed.inject(ApplicationRef);
      const wiring: [string, ReturnType<typeof vi.spyOn>][] = [
        ['insert-attach', vi.spyOn(cmp, 'onAttach').mockReturnValue()],
        ['insert-gif', vi.spyOn(cmp, 'toggleGifPicker').mockReturnValue()],
        ['insert-poll', vi.spyOn(cmp, 'openPollDialog').mockReturnValue()],
        ['insert-location', vi.spyOn(cmp, 'shareLocation').mockReturnValue()],
        [
          'insert-voice',
          vi.spyOn(cmp, 'startVoiceRecording').mockResolvedValue(),
        ],
      ];

      for (const [testid, spy] of wiring) {
        (fixture.nativeElement as HTMLElement)
          .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
          ?.click();
        appRef.tick();
        (
          document.querySelector(
            `[data-testid=${testid}]`,
          ) as HTMLElement | null
        )?.click();
        appRef.tick();
        expect(spy, testid).toHaveBeenCalledTimes(1);
      }
    });

    it('wires the plain attach fallback button to onAttach', async () => {
      // The thread composer's only attach affordance (hasInsertMenu false). A plain
      // button, so a direct click drives it — no overlay/tick plumbing.
      const { fixture, container } = await renderComposer(
        { richActions: false },
        [
          MockProvider(GifSettingsService, {
            configured: signal(false).asReadonly(),
          }),
        ],
      );
      const spy = vi
        .spyOn(fixture.componentInstance, 'onAttach')
        .mockReturnValue();

      container
        .querySelector<HTMLButtonElement>(
          '[data-testid=composer-insert-attach]',
        )
        ?.click();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('disables the Location item in the tray while a share is in flight', async () => {
      // The inline location button's disabled state moved to the tray item; the
      // trigger only shows a spinner, so the item is where the guard now lives.
      const { fixture } = await renderComposer({}, [
        MockProvider(LocationShareService, {
          sharing: signal(true).asReadonly(),
          share: vi.fn(),
        }),
      ]);
      (fixture.nativeElement as HTMLElement)
        .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
        ?.click();
      TestBed.inject(ApplicationRef).tick();

      expect(
        document
          .querySelector('[data-testid=insert-location]')
          ?.getAttribute('data-disabled'),
      ).toBe('');
    });

    it('disables the + trigger while editing a message', async () => {
      // A single [disabled]="editing()" on the trigger locks out every insert while an
      // edit is in progress — the change replaced five per-button guards with this one.
      const { container } = await renderComposer({ editing: true }, [
        MockProvider(VoiceRecorderService, { supported: true }),
      ]);

      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid=composer-insert]',
        )?.disabled,
      ).toBe(true);
    });
  });

  it('dismisses a picker on Escape from anywhere in the composer, not just the textarea', async () => {
    // The binding lives on the host: the GIF picker can be opened from the insert tray,
    // after which focus sits on the `+` trigger and never enters the textarea. Dispatch
    // from a non-textarea element to prove the handler is not textarea-scoped.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.gifPickerOpen.set(true);

    fixture.nativeElement
      .querySelector('[data-testid=composer-insert]')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );

    expect(cmp.gifPickerOpen()).toBe(false);
  });

  it('always renders the send button, at every width and pointer type', async () => {
    // Previously touch-only via `@media (hover: none)`. Enter-to-send is not always
    // unambiguous (newlines in a draft, IME composition), so the target is permanent.
    const { container } = await renderComposer();

    const send = container.querySelector<HTMLButtonElement>(
      '[data-testid=composer-send]',
    );
    expect(send).not.toBeNull();
    // Disabled with nothing to send, so it cannot fire an empty message.
    expect(send?.disabled).toBe(true);
  });

  it('shows a spinner on the + trigger while a location share is in flight', async () => {
    const { container } = await renderComposer({}, [
      MockProvider(LocationShareService, {
        sharing: signal(true).asReadonly(),
        share: vi.fn(),
      }),
    ]);

    // The `+` trigger swaps its icon for a spinner while a share (or GIF fetch) runs;
    // the tray's own Location item carries the disabled state.
    const trigger = container.querySelector('[data-testid=composer-insert]');
    expect(trigger?.querySelector('trn-spinner')).not.toBeNull();
  });

  describe('voice messages', () => {
    const recording = {
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
      durationMs: 3000,
      waveform: [0, 512, 1024],
      mimeType: 'audio/webm',
    };

    /** Providers wiring a fake recorder + a spyable voice-send. */
    function voiceProviders(
      over: {
        start?: () => Promise<void>;
        stop?: () => Promise<typeof recording | null>;
        sendVoiceMessage?: Mock;
      } = {},
    ) {
      const cancel = vi.fn();
      const sendVoiceMessage = over.sendVoiceMessage ?? vi.fn(() => of(void 0));
      return {
        cancel,
        sendVoiceMessage,
        providers: [
          MockProvider(VoiceRecorderService, {
            supported: true,
            start: over.start ?? (() => Promise.resolve()),
            stop: over.stop ?? (() => Promise.resolve(recording)),
            cancel,
          }),
          MockProvider(TimelineActionsService, { sendVoiceMessage }),
        ] as Provider[],
      };
    }

    it('shows the mic button and starts recording on click', async () => {
      const { providers } = voiceProviders();
      const { fixture } = await renderComposer({}, providers);
      const cmp = fixture.componentInstance;

      await cmp.startVoiceRecording();

      expect(cmp.recordingVoice()).toBe(true);
    });

    it('stops recording and sends the clip as a voice message', async () => {
      const { providers, sendVoiceMessage } = voiceProviders();
      const { fixture } = await renderComposer({}, providers);
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();

      cmp.stopVoiceRecording();
      await Promise.resolve();
      await Promise.resolve();

      expect(sendVoiceMessage).toHaveBeenCalledWith(recording);
      expect(cmp.recordingVoice()).toBe(false);
    });

    it('ignores a second start while the mic is still being acquired', async () => {
      let resolveStart!: () => void;
      const start = vi.fn(
        () => new Promise<void>((resolve) => (resolveStart = resolve)),
      );
      const cancel = vi.fn();
      const { fixture } = await renderComposer({}, [
        MockProvider(VoiceRecorderService, {
          supported: true,
          start,
          stop: () => Promise.resolve(recording),
          cancel,
        }),
        MockProvider(TimelineActionsService, {}),
      ]);
      const cmp = fixture.componentInstance;

      const first = cmp.startVoiceRecording();
      const second = cmp.startVoiceRecording(); // clicked again during acquisition
      resolveStart();
      await Promise.all([first, second]);

      expect(start).toHaveBeenCalledTimes(1); // only one mic stream opened
      expect(cmp.recordingVoice()).toBe(true);
    });

    it('cancels an in-progress recording when the room switches', async () => {
      const { providers, cancel } = voiceProviders();
      const { fixture } = await renderComposer({ roomId: '!a:hs' }, providers);
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();
      expect(cmp.recordingVoice()).toBe(true);

      fixture.componentRef.setInput('roomId', '!b:hs');
      fixture.detectChanges();

      expect(cancel).toHaveBeenCalled();
      expect(cmp.recordingVoice()).toBe(false);
    });

    it('cancels a recording without sending', async () => {
      const { providers, cancel, sendVoiceMessage } = voiceProviders();
      const { fixture } = await renderComposer({}, providers);
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();

      cmp.cancelVoiceRecording();

      expect(cancel).toHaveBeenCalled();
      expect(cmp.recordingVoice()).toBe(false);
      expect(sendVoiceMessage).not.toHaveBeenCalled();
    });

    it('toasts and stays idle when the mic can’t be accessed', async () => {
      const { providers } = voiceProviders({
        start: () => Promise.reject(new Error('denied')),
      });
      const { fixture } = await renderComposer({}, providers);
      const cmp = fixture.componentInstance;

      await cmp.startVoiceRecording();

      expect(cmp.recordingVoice()).toBe(false);
      expect(TestBed.inject(TrnToastService).show).toHaveBeenCalledWith(
        expect.stringContaining('microphone'),
        expect.objectContaining({ variant: 'destructive' }),
      );
    });

    it('does not send an empty clip', async () => {
      const { providers, sendVoiceMessage } = voiceProviders({
        stop: () => Promise.resolve({ ...recording, blob: new Blob([]) }),
      });
      const { fixture } = await renderComposer({}, providers);
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();

      cmp.stopVoiceRecording();
      await Promise.resolve();
      await Promise.resolve();

      expect(sendVoiceMessage).not.toHaveBeenCalled();
    });
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

  describe('mention autocomplete', () => {
    const MEMBERS = [
      { userId: '@alice:hs', name: 'Alice' },
      { userId: '@bob:hs', name: 'Bob' },
    ];

    it('opens the member menu for an @query and inserts the pick', async () => {
      const { fixture, container } = await renderComposer({ members: MEMBERS });
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;

      ta.value = 'hey @al';
      ta.selectionStart = ta.selectionEnd = 7;
      cmp.onInput({ target: ta } as unknown as Event);

      // Only Alice matches "al"; the menu is open.
      expect(cmp.mentionOpen()).toBe(true);
      expect(cmp.mentionMatches().map((m) => m.userId)).toEqual(['@alice:hs']);

      ta.selectionStart = 7;
      cmp.acceptMention();

      expect(cmp.text()).toBe('hey @Alice ');
      expect(cmp.mentionOpen()).toBe(false);
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
      cmp.acceptMention();

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
      cmp.acceptMention(); // text = "@Alice "

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

      expect(cmp.mentionOpen()).toBe(false); // '@' not at a word boundary
    });

    it('navigates the menu with the arrow keys and accepts with Tab', async () => {
      const { fixture, container } = await renderComposer({ members: MEMBERS });
      const cmp = fixture.componentInstance;
      const ta = container.querySelector('textarea') as HTMLTextAreaElement;

      ta.value = '@';
      ta.selectionStart = ta.selectionEnd = 1;
      cmp.onInput({ target: ta } as unknown as Event);
      expect(cmp.mentionMatches().map((m) => m.name)).toEqual(['Alice', 'Bob']);

      cmp.onArrowDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(cmp.mentionActiveIndex()).toBe(1); // Bob highlighted

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
      cmp.acceptMention(); // tracks @Alice for room A

      // Switch rooms, then type similar text by hand (not via the menu).
      fixture.componentRef.setInput('roomId', '!b:hs');
      fixture.detectChanges();
      cmp.text.set('@Alice again');
      cmp.onEnter(enter());

      expect(submit?.mentions).toEqual([]); // the old room's tracking was dropped
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
  // Formatting: a toolbar action, the rebindable chords behind it, and the preview. The
  // wrapping arithmetic itself lives in `markdown-edit.ts` and is tested there — these cover the
  // wiring: that the right selection reaches it, and that the result reaches the textarea.
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

      it('leaves the preview when the toolbar is taken away', async () => {
        // The preview toggle lives on the toolbar, so hiding it mid-preview would strand the
        // composer showing a preview with nothing left to switch back.
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

        expect(fixture.componentInstance.previewing()).toBe(false);
        expect(
          container.querySelector('[data-testid=composer-preview]'),
        ).toBeNull();
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
});
