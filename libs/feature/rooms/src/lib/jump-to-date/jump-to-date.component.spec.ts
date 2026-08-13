import { DialogRef } from '@trinity/helm/overlay';
import { render } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { isoDateOf } from '@trinity/util/matrix';
import { JumpToDateComponent } from './jump-to-date.component';

async function open() {
  const close = vi.fn();
  const rendered = await render(JumpToDateComponent, {
    providers: [{ provide: DialogRef, useValue: { close } }],
  });
  const input = rendered.fixture.nativeElement.querySelector(
    '[data-testid=jump-to-date-input]',
  ) as HTMLInputElement;
  return { ...rendered, close, input };
}

function type(
  input: HTMLInputElement,
  value: string,
  fixture: { detectChanges: () => void },
): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

describe('JumpToDateComponent', () => {
  it('opens on today and offers no future dates', async () => {
    const { input } = await open();

    expect(input.value).toBe(isoDateOf(Date.now()));
    // `timestampToEvent` searches forward, so a future date could only ever report "no
    // messages" — the control says so rather than letting the user find out.
    expect(input.getAttribute('max')).toBe(isoDateOf(Date.now()));
  });

  it('closes with the chosen day’s LOCAL midnight', async () => {
    const { fixture, input, close, container } = await open();

    type(input, '2026-02-28', fixture);
    container
      .querySelector<HTMLElement>('[data-testid=jump-to-date-confirm]')!
      .click();

    const [at] = close.mock.calls[0] as [number];
    const local = new Date(at);
    expect(local.getFullYear()).toBe(2026);
    expect(local.getMonth()).toBe(1);
    expect(local.getDate()).toBe(28);
    expect(local.getHours()).toBe(0);
  });

  it('will not jump on a date that is not real', async () => {
    const { fixture, input, close, container } = await open();

    // A browser date control normally prevents this, but the value is a plain string and
    // 30 February parses to 2 March if you let `Date` roll it over.
    type(input, '2026-02-30', fixture);

    const confirm = container.querySelector<HTMLButtonElement>(
      '[data-testid=jump-to-date-confirm]',
    )!;
    expect(confirm.disabled).toBe(true);
    confirm.click();
    expect(close).not.toHaveBeenCalled();
  });

  it('closes with nothing when cancelled', async () => {
    const { close, container } = await open();

    container.querySelector<HTMLElement>('button')!.click();

    expect(close).toHaveBeenCalledWith(undefined);
  });
});
