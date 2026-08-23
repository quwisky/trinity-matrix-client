import {
  createObjectURL,
  pasteEvent,
  pickFiles,
  png,
  renderComposer,
  revokeObjectURL,
  stagedFiles,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type BatchItem } from '../shared/send-media-batch';
import { MockProvider } from 'ng-mocks';
import { TrnToastService } from '@trinity/components/overlay';
import { MediaPickerService } from '../media-picker/media-picker.service';

describe('MessageComposerComponent — staging files for the next send', () => {
  beforeEach(() => stubObjectUrls());

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

  it('stages every photo the native gallery returns', async () => {
    // Only the ERROR branch of this subscription was ever exercised. Under jsdom
    // `isNativePlatform()` is false, so every other attach test takes the file-dialog
    // fallback — the success path that mobile multi-select actually runs had no coverage at
    // all, on the platform the feature was built for.
    const picked = [png('holiday-1.jpg'), png('holiday-2.jpg')];
    const { fixture } = await renderComposer({}, [
      MockProvider(MediaPickerService, {
        available: true,
        pickImages: () => of(picked),
      }),
    ]);
    const cmp = fixture.componentInstance;

    cmp.onAttach();

    expect(stagedFiles(cmp).map((f) => f.name)).toEqual([
      'holiday-1.jpg',
      'holiday-2.jpg',
    ]);
  });

  it('puts the caret back in the box after staging, ready for a caption', async () => {
    // The affordance that makes "pick, then type the caption" one gesture. Without it the
    // focus is left on the attach button — or on nothing at all, after a drop.
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const textarea = container.querySelector('textarea');
    (
      container.querySelector('[data-testid=composer-insert]') as HTMLElement
    )?.focus();

    cmp.stageFiles([png('dropped.png')]);
    await fixture.whenStable();

    expect(document.activeElement).toBe(textarea);
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
});
