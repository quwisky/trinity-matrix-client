import { describe, expect, it, vi } from 'vitest';
import { render } from '@trinity/testing';
import { ComposerFormatMenuComponent } from './composer-format-menu.component';

const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isMobileOs: () => platform.mobile,
}));

describe('ComposerFormatMenuComponent', () => {
  it('offers all Markdown actions and Preview from the desktop menu', async () => {
    platform.mobile = false;
    const { container } = await render(ComposerFormatMenuComponent);
    container
      .querySelector<HTMLButtonElement>('[data-testid=composer-format]')
      ?.click();
    const items = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[data-testid^="format-"]',
      ),
    ];
    expect(items.map((item) => item.dataset['testid'])).toEqual([
      'format-bold',
      'format-italic',
      'format-strike',
      'format-code',
      'format-codeblock',
      'format-quote',
      'format-link',
      'format-list',
      'format-tasklist',
      'format-preview',
      'format-cancel',
    ]);
    expect(
      document.querySelector('[data-testid=composer-preview-toggle]'),
    ).toBeNull();
  });

  it('emits each Markdown action from the desktop menu', async () => {
    platform.mobile = false;
    const rendered = await render(ComposerFormatMenuComponent);
    const emitted: string[] = [];
    rendered.fixture.componentInstance.format.subscribe((action) =>
      emitted.push(action),
    );
    const actions = [
      'bold',
      'italic',
      'strike',
      'code',
      'codeblock',
      'quote',
      'link',
      'list',
      'tasklist',
    ];
    for (const action of actions) {
      rendered.container
        .querySelector<HTMLButtonElement>('[data-testid=composer-format]')
        ?.click();
      const item = document.querySelector<HTMLButtonElement>(
        `[data-testid=format-${action}]`,
      );
      expect(item, action).not.toBeNull();
      item?.click();
    }
    expect(emitted).toEqual(actions);
  });

  it('emits Preview and closes the desktop menu before handing control back', async () => {
    platform.mobile = false;
    const rendered = await render(ComposerFormatMenuComponent);
    const events: string[] = [];
    rendered.fixture.componentInstance.preview.subscribe(() =>
      events.push('preview'),
    );
    rendered.container
      .querySelector<HTMLButtonElement>('[data-testid=composer-format]')
      ?.click();
    document
      .querySelector<HTMLButtonElement>('[data-testid=format-preview]')
      ?.click();
    expect(events).toEqual(['preview']);
    expect(
      document.querySelector('[data-testid=composer-format-menu]'),
    ).toBeNull();
  });

  it('uses the real mobile action sheet and Cancel never emits a format action', async () => {
    platform.mobile = true;
    const rendered = await render(ComposerFormatMenuComponent);
    const trigger = rendered.container.querySelector<HTMLButtonElement>(
      '[data-testid=composer-format]',
    )!;
    const emitted: string[] = [];
    rendered.fixture.componentInstance.format.subscribe((action) =>
      emitted.push(action),
    );
    trigger.click();
    const sheet = document.querySelector('[data-testid=action-sheet-surface]');
    expect(sheet).not.toBeNull();
    document
      .querySelector<HTMLButtonElement>('[data-testid=format-cancel]')
      ?.click();
    expect(emitted).toEqual([]);
  });

  it('emits a mobile format action only after the sheet has closed', async () => {
    platform.mobile = true;
    const rendered = await render(ComposerFormatMenuComponent);
    const trigger = rendered.container.querySelector<HTMLButtonElement>(
      '[data-testid=composer-format]',
    )!;
    let sheetPresentWhenEmitted = true;
    rendered.fixture.componentInstance.format.subscribe(() => {
      sheetPresentWhenEmitted =
        document.querySelector('[data-testid=action-sheet-surface]') !== null;
    });
    trigger.click();
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-testid=format-bold]'),
      ).not.toBeNull(),
    );
    document
      .querySelector<HTMLButtonElement>('[data-testid=format-bold]')
      ?.click();
    expect(sheetPresentWhenEmitted).toBe(false);
  });

  it('invalidates a mobile handler when its context is replaced', async () => {
    platform.mobile = true;
    const rendered = await render(ComposerFormatMenuComponent, {
      inputs: { contextKey: {} },
    });
    const emitted: string[] = [];
    rendered.fixture.componentInstance.format.subscribe((action) =>
      emitted.push(action),
    );
    rendered.container
      .querySelector<HTMLButtonElement>('[data-testid=composer-format]')
      ?.click();
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-testid=format-bold]'),
      ).not.toBeNull(),
    );
    const stale = document.querySelector<HTMLButtonElement>(
      '[data-testid=format-bold]',
    );
    expect(stale).not.toBeNull();

    rendered.fixture.componentRef.setInput('contextKey', {});
    rendered.fixture.detectChanges();
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-testid=action-sheet-surface]'),
      ).toBeNull(),
    );
    stale?.click();
    expect(emitted).toEqual([]);
  });

  it('closes an open desktop menu when disabled becomes true', async () => {
    platform.mobile = false;
    const rendered = await render(ComposerFormatMenuComponent, {
      inputs: { contextKey: {} },
    });
    rendered.container
      .querySelector<HTMLButtonElement>('[data-testid=composer-format]')
      ?.click();
    expect(
      document.querySelector('[data-testid=composer-format-menu]'),
    ).not.toBeNull();
    rendered.fixture.componentRef.setInput('disabled', true);
    rendered.fixture.detectChanges();
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-testid=composer-format-menu]'),
      ).toBeNull(),
    );
  });
});
