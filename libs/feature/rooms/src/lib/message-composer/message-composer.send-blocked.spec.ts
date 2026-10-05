import {
  enter,
  renderComposer,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { beforeEach, describe, expect, it } from 'vitest';

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
});
