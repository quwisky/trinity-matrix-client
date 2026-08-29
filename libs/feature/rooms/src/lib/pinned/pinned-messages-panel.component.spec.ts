import { signal } from '@angular/core';
import { render, fireEvent } from '@trinity/testing';
import {
  ConversationRuntime,
  type PinnedMessageView,
} from '@trinity/data-access/timeline';
import { of } from 'rxjs';
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
 * Render the panel with a stubbed exact-Conversation pins child, capturing what it
 * announces. The panel reads the live projection directly, so the signals ARE the
 * inputs — there is nothing to thread in.
 * It is presentational: `selected` / `dismissed` are the whole contract with the host.
 */
async function renderPanel(
  options: { pinned?: PinnedMessageView[]; canPin?: boolean } = {},
) {
  const selected: string[] = [];
  let dismissals = 0;
  const unpin = vi.fn(() =>
    of({ kind: 'applied' as const, operation: 'unpin' as const }),
  );
  const { container } = await render(PinnedMessagesPanelComponent, {
    on: {
      selected: (eventId: string) => selected.push(eventId),
      dismissed: () => {
        dismissals += 1;
      },
    },
    providers: [
      {
        provide: ConversationRuntime,
        useValue: {
          pins: {
            messages: signal(options.pinned ?? []).asReadonly(),
            canMutate: signal(options.canPin ?? true).asReadonly(),
            unpin,
          },
        },
      },
    ],
  });
  return { container, selected, unpin, dismissals: () => dismissals };
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

  it('emits the chosen event id so the host can jump the timeline', async () => {
    const { container, selected, dismissals } = await renderPanel({
      pinned: [pin({ id: '$target', senderName: 'Alice' })],
    });

    fireEvent.click(jumpButton(container, 'Alice')!);

    // The id — not just "something happened" — is the whole contract with the host.
    expect(selected).toEqual(['$target']);
    // A pick is a pick, not a bare close: the host distinguishes the two.
    expect(dismissals()).toBe(0);
  });

  it('emits dismissed, with no id, when closed', async () => {
    const { container, selected, dismissals } = await renderPanel({
      pinned: [pin()],
    });

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Close pinned messages"]',
      )!,
    );

    expect(dismissals()).toBe(1);
    expect(selected).toEqual([]); // nothing picked → no jump
  });

  it('unpins in place without announcing anything', async () => {
    const { container, selected, dismissals, unpin } = await renderPanel({
      pinned: [pin({ id: '$a', senderName: 'Alice' })],
      canPin: true,
    });
    fireEvent.click(unpinButton(container, 'Alice')!);

    expect(unpin).toHaveBeenCalledWith('$a');
    // The live projection drops the row; the panel must not ask the host to close it.
    expect(dismissals()).toBe(0);
    expect(selected).toEqual([]);
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
