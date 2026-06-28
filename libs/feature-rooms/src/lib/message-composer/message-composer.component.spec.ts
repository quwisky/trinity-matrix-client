import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageComposerComponent } from './message-composer.component';

describe('MessageComposerComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [MessageComposerComponent] }),
  );

  function enter(shift = false): Event {
    return new KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift });
  }

  it('emits the trimmed text on Enter and clears the input', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    let sent: string | undefined;
    cmp.submitText.subscribe((t) => (sent = t));

    cmp.text.set('  hello  ');
    cmp.onEnter(enter());

    expect(sent).toBe('hello');
    expect(cmp.text()).toBe('');
  });

  it('does not submit on Shift+Enter or when empty', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.detectChanges();
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

  it('prefills the draft in edit mode and keeps the text after submit', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.componentRef.setInput('editing', true);
    fixture.componentRef.setInput('draft', 'old text');
    fixture.detectChanges();
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

  it('emits editLast on Up arrow only when empty and not editing', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    let count = 0;
    cmp.editLast.subscribe(() => count++);

    cmp.onArrowUp(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(count).toBe(1); // empty → edit last

    cmp.text.set('typing');
    cmp.onArrowUp(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(count).toBe(1); // has text → cursor movement, no emit
  });

  it('does not emit editLast while already editing', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.componentRef.setInput('editing', true);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    let count = 0;
    cmp.editLast.subscribe(() => count++);
    cmp.text.set('');
    cmp.onArrowUp(new KeyboardEvent('keydown', { key: 'ArrowUp' }));

    expect(count).toBe(0);
  });

  it('emits cancel on Escape in edit mode', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.componentRef.setInput('editing', true);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    let cancelled = false;
    cmp.cancelEdit.subscribe(() => (cancelled = true));
    cmp.onEscape();

    expect(cancelled).toBe(true);
  });

  it('inserts an emoji at the cursor and closes the picker', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    const ta = fixture.nativeElement.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;

    cmp.text.set('ab');
    fixture.detectChanges();
    ta.selectionStart = ta.selectionEnd = 1; // cursor between a and b
    cmp.pickerOpen.set(true);

    cmp.insertEmoji('😀');

    expect(cmp.text()).toBe('a😀b');
    expect(cmp.pickerOpen()).toBe(false);
  });

  it('shows a reply banner and cancels the reply on Escape', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.componentRef.setInput('replyingTo', 'Alice');
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    expect(fixture.nativeElement.textContent).toContain('Replying to');
    expect(fixture.nativeElement.textContent).toContain('Alice');

    let cancelled = false;
    cmp.cancelReply.subscribe(() => (cancelled = true));
    cmp.onEscape();
    expect(cancelled).toBe(true);
  });

  it('emits submitMedia with the picked file and resets the input for re-picking', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    let emitted: File | undefined;
    cmp.submitMedia.subscribe((f) => (emitted = f));

    const file = new File([new Uint8Array([1])], 'pic.png', {
      type: 'image/png',
    });
    const input = fixture.nativeElement.querySelector(
      '[data-testid=composer-file-input]',
    ) as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [file],
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));

    expect(emitted).toBe(file);
    expect(input.value).toBe('');
  });

  it('opens the hidden file input on attach (web fallback)', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    const input = fixture.nativeElement.querySelector(
      '[data-testid=composer-file-input]',
    ) as HTMLInputElement;
    const clickSpy = vi
      .spyOn(input, 'click')
      .mockImplementation(() => undefined);

    cmp.onAttach(); // picker.available is false under jsdom → uses the input

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('shows a determinate upload progress bar while uploading and hides it when idle', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    const wrapper = () => el.querySelector('[data-testid=upload-progress]');
    const bar = () =>
      el.querySelector('ion-progress-bar') as
        | (HTMLElement & { value: number; type: string })
        | null;

    // Idle: no progress UI.
    expect(wrapper()).toBeNull();

    // Mid-upload with a real fraction → determinate bar bound to the value.
    fixture.componentRef.setInput('uploadProgress', 0.42);
    fixture.detectChanges();
    expect(wrapper()).not.toBeNull();
    expect(bar()).not.toBeNull();
    expect(bar()?.value).toBeCloseTo(0.42, 5);
    expect(bar()?.type).toBe('determinate');
    expect(wrapper()?.textContent).toContain('42%');
    expect(cmp.uploadPercent()).toBe(42);

    // Just started (0, before the first real tick) → indeterminate, no percent.
    fixture.componentRef.setInput('uploadProgress', 0);
    fixture.detectChanges();
    expect(wrapper()).not.toBeNull();
    expect(bar()?.type).toBe('indeterminate');
    expect(wrapper()?.textContent).not.toContain('%');

    // Upload finished → null clears the bar (and re-enables the attach button).
    fixture.componentRef.setInput('uploadProgress', null);
    fixture.detectChanges();
    expect(wrapper()).toBeNull();
  });

  it('disables the attach button while an upload is in flight', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.detectChanges();
    const attach = () =>
      fixture.nativeElement.querySelector(
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

  it('toggles the emoji picker from the button', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    expect(fixture.nativeElement.querySelector('trn-emoji-picker')).toBeNull();

    cmp.pickerOpen.set(true);
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('trn-emoji-picker'),
    ).not.toBeNull();
  });
});
