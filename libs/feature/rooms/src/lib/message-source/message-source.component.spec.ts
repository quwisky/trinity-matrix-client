import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { TrnDialogRef, TrnToastService } from '@trinity/components/overlay';
import { MessageSourceComponent } from './message-source.component';

async function build(source: string) {
  const close = vi.fn();
  const toastShow = vi.fn();
  const { fixture, container } = await render(MessageSourceComponent, {
    inputs: { source },
    providers: [
      MockProvider(TrnDialogRef, { close }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return { cmp: fixture.componentInstance, container, close, toastShow };
}

describe('MessageSourceComponent', () => {
  it('renders the raw JSON source', async () => {
    const { container } = await build('{\n  "type": "m.room.message"\n}');
    const pre = container.querySelector('[data-testid=message-source-json]');
    expect(pre?.textContent).toContain('m.room.message');
  });

  it('copies the source and toasts', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { cmp, toastShow } = await build('{"a":1}');

    cmp.copy();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('{"a":1}');
    expect(toastShow).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('closes the dialog', async () => {
    const { cmp } = await build('{}');
    cmp.close();
    expect(TestBed.inject(TrnDialogRef).close).toHaveBeenCalled();
  });

  // The CDK overlay is a bare positioned box: a dialog that doesn't paint its own card
  // renders transparent over the timeline. jsdom can't see that, so assert the classes
  // that produce it — the closest a unit test gets to "it looks like a dialog".
  it('paints itself as a card rather than floating transparent', async () => {
    const { container } = await build('{}');
    const card = container.querySelector('[data-testid=message-source]');

    expect(card?.className).toContain('bg-card');
    expect(card?.className).toContain('text-card-foreground');
    expect(card?.className).toContain('border');
  });

  // Painting an inner box would leave the dialog's own padding transparent — the card has
  // to be the outermost element, with everything else inside it.
  it('wraps the whole dialog in that card, not an inner box', async () => {
    const { container } = await build('{"a":1}');
    const card = container.querySelector('[data-testid=message-source]');

    expect(card?.parentElement).toBe(
      container.firstElementChild?.parentElement,
    );
    expect(
      card?.querySelector('[data-testid=message-source-json]'),
    ).not.toBeNull();
    expect(
      card?.querySelector('[data-testid=message-source-copy]'),
    ).not.toBeNull();
    // Nothing renders outside the card.
    expect(
      [...container.children].filter(
        (el) => el !== card && el.textContent?.trim(),
      ),
    ).toHaveLength(0);
  });
});
