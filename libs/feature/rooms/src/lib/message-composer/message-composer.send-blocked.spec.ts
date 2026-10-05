import {
  enter,
  renderComposer,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('MessageComposerComponent — sendBlocked', () => {
  beforeEach(() => stubObjectUrls());

  it('keeps the text field usable but blocks every send path', async () => {
    const { fixture } = await renderComposer({ sendBlocked: true });
    const cmp = fixture.componentInstance;
    let sends = 0;
    cmp.submitText.subscribe(() => sends++);

    const input = fixture.nativeElement.querySelector(
      '[data-testid="composer-input"]',
    ) as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    input.value = 'hello';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    fixture.detectChanges();
    expect(
      (
        fixture.nativeElement.querySelector(
          '[data-testid="composer-send"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    cmp.onEnter(enter());
    cmp.submit();
    expect(sends).toBe(0);
    expect(input.value).toBe('hello');
    expect(cmp['canSendMedia']()).toBe(false);

    fixture.componentRef.setInput('sendBlocked', false);
    fixture.detectChanges();
    expect(
      (
        fixture.nativeElement.querySelector(
          '[data-testid="composer-send"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(cmp['canSendMedia']()).toBe(true);
  });

  it('blocks poll, location, sticker and voice sends but not recording', async () => {
    const { fixture } = await renderComposer({
      sendBlocked: true,
      richActions: true,
    });
    const cmp = fixture.componentInstance;
    const attachments = cmp['attachments'];
    const poll = vi.spyOn(attachments, 'openPollDialog').mockReturnValue();
    const location = vi.spyOn(attachments, 'shareLocation').mockReturnValue();
    const stop = vi.spyOn(attachments, 'stopVoiceRecording').mockReturnValue();
    let stickers = 0;
    cmp.stickerSelect.subscribe(() => stickers++);

    cmp.openPollDialog();
    cmp.shareLocation();
    cmp.onStickerSelect({} as never);
    // Recording stays active: stop is refused rather than discarding the clip.
    vi.spyOn(attachments, 'recordingVoice').mockReturnValue(true);
    cmp.stopVoiceRecording();

    expect(poll).not.toHaveBeenCalled();
    expect(location).not.toHaveBeenCalled();
    expect(stickers).toBe(0);
    expect(stop).not.toHaveBeenCalled();

    fixture.componentRef.setInput('sendBlocked', false);
    cmp.openPollDialog();
    cmp.shareLocation();
    cmp.stopVoiceRecording();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(location).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('disables the insert-menu entries that send to the Room', async () => {
    const { fixture } = await renderComposer({
      sendBlocked: true,
      richActions: true,
    });
    const appRef = TestBed.inject(ApplicationRef);
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
      ?.click();
    appRef.tick();
    for (const id of ['insert-poll', 'insert-location']) {
      const item = document.querySelector<HTMLButtonElement>(
        `[data-testid=${id}]`,
      );
      expect(item, id).not.toBeNull();
      expect(item?.disabled, id).toBe(true);
    }
  });
});
