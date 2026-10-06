import { TestBed } from '@angular/core/testing';
import { render, screen, within } from '@trinity/testing';
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
  it('shows its title in the shared dialog shell', async () => {
    await build('{}');

    expect(
      within(screen.getByTestId('dialog-surface')).getByRole('heading', {
        level: 2,
        name: 'Message source',
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('dialog-footer')).getByTestId(
        'message-source-copy',
      ),
    ).toBeTruthy();
  });

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

  // The shell host carries the test id and everything renders inside its surface.
  it('keeps the whole dialog inside its shell', async () => {
    const { container } = await build('{"a":1}');
    const shell = container.querySelector('[data-testid=message-source]');

    expect(shell?.tagName).toBe('TRN-DIALOG-SHELL');
    expect(
      shell?.querySelector(
        '[data-testid=dialog-surface] [data-testid=message-source-json]',
      ),
    ).not.toBeNull();
    expect(
      shell?.querySelector(
        '[data-testid=dialog-footer] [data-testid=message-source-copy]',
      ),
    ).not.toBeNull();
  });
});
