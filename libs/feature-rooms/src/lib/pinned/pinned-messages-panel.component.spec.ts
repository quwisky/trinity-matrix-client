import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render, fireEvent } from '@trinity/testing';
import { DialogRef } from '@angular/cdk/dialog';
import {
  PinnedMessagesService,
  type PinnedMessageView,
} from '@trinity/data-access-pinned';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { PinnedMessagesPanelComponent } from './pinned-messages-panel.component';

function pin(over: Partial<PinnedMessageView> = {}): PinnedMessageView {
  return {
    id: '$a',
    sender: '@a:hs',
    senderName: 'Alice',
    body: 'hello world',
    ts: 0,
    ...over,
  };
}

/**
 * Render the panel with a stubbed PinnedMessagesService. The panel reads the live
 * projection directly (the shell has already opened it for the active room), so the
 * signals ARE the inputs — there is nothing to thread in.
 */
async function renderPanel(
  options: { pinned?: PinnedMessageView[]; canPin?: boolean } = {},
) {
  const close = vi.fn();
  const { container } = await render(PinnedMessagesPanelComponent, {
    providers: [
      MockProvider(PinnedMessagesService, {
        pinnedMessages: signal(options.pinned ?? []).asReadonly(),
        canPin: signal(options.canPin ?? true).asReadonly(),
      }),
      { provide: DialogRef, useValue: { close } },
    ],
  });
  return { container, close };
}

/** The row buttons, identified by the aria-label the template builds. */
function jumpButton(container: HTMLElement, senderName: string) {
  return container.querySelector<HTMLButtonElement>(
    `[aria-label="Jump to pinned message from ${senderName}"]`,
  );
}
function unpinButton(container: HTMLElement, senderName: string) {
  return container.querySelector<HTMLButtonElement>(
    `[aria-label="Unpin message from ${senderName}"]`,
  );
}

describe('PinnedMessagesPanelComponent', () => {
  it('renders a row per pinned message, in pin order', async () => {
    const { container } = await renderPanel({
      pinned: [
        pin({ id: '$a', senderName: 'Alice', body: 'first' }),
        pin({ id: '$b', senderName: 'Bob', body: 'second' }),
      ],
    });

    const rows = container.querySelectorAll('.pin-item');
    expect(rows).toHaveLength(2);
    // Pin order is the array order — not sorted by timestamp or sender.
    expect(container.textContent).toContain('first');
    expect(container.textContent).toContain('second');
    expect(rows[0].textContent).toContain('Alice');
    expect(rows[1].textContent).toContain('Bob');
  });

  it('shows an empty state when nothing is pinned', async () => {
    const { container } = await renderPanel({ pinned: [] });

    expect(container.textContent).toContain('No pinned messages');
    expect(container.querySelectorAll('.pin-item')).toHaveLength(0);
  });

  it('closes with the chosen event id so the shell can jump the timeline', async () => {
    const { container, close } = await renderPanel({
      pinned: [pin({ id: '$target', senderName: 'Alice' })],
    });

    fireEvent.click(jumpButton(container, 'Alice')!);

    // The id — not just `close()` — is the whole contract with PinnedPanelService.
    expect(close).toHaveBeenCalledWith('$target');
  });

  it('closes with no id when dismissed', async () => {
    const { container, close } = await renderPanel({ pinned: [pin()] });

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Close pinned messages"]',
      )!,
    );

    expect(close).toHaveBeenCalledWith(); // undefined → no jump
  });

  it('unpins in place without closing the panel', async () => {
    const { container, close } = await renderPanel({
      pinned: [pin({ id: '$a', senderName: 'Alice' })],
      canPin: true,
    });
    const svc = TestBed.inject(PinnedMessagesService);

    fireEvent.click(unpinButton(container, 'Alice')!);

    expect(svc.unpin).toHaveBeenCalledWith('$a');
    expect(close).not.toHaveBeenCalled(); // the live projection drops the row instead
  });

  it('hides Unpin from a user without permission', async () => {
    const { container } = await renderPanel({
      pinned: [pin({ senderName: 'Alice' })],
      canPin: false,
    });

    expect(jumpButton(container, 'Alice')).not.toBeNull(); // can still jump
    expect(unpinButton(container, 'Alice')).toBeNull(); // but not unpin
  });
});
