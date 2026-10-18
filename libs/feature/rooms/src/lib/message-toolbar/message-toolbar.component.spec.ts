import { ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { render } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  MessageToolbarComponent,
  type MessageAction,
  type MessageToolbarCaps,
} from './message-toolbar.component';

/** Build a caps object, overriding only the flags a test cares about. */
const caps = (over: Partial<MessageToolbarCaps> = {}): MessageToolbarCaps => ({
  canEdit: false,
  canDelete: false,
  canPin: false,
  pinned: false,
  canThread: true,
  canQuote: false,
  saveMedia: null,
  canForward: true,
  ...over,
});

/**
 * Open the overflow "⋯" menu; its items render into the CDK overlay (document), so
 * queries after this look there rather than in the container element.
 */
function openMenu(
  container: HTMLElement,
  fixture: ComponentFixture<MessageToolbarComponent>,
): void {
  container
    .querySelector<HTMLButtonElement>('[data-testid="msg-more"]')!
    .click();
  fixture.detectChanges();
}

describe('MessageToolbarComponent', () => {
  it('shows react + reply + thread + overflow inline and emits reply', async () => {
    const { fixture, container } = await render(MessageToolbarComponent);
    const cmp = fixture.componentInstance;

    // Inline: react + reply + thread + the "⋯" overflow trigger (copy/edit/delete
    // now live inside the overflow menu, not inline).
    const buttons = container.querySelectorAll('.toolbar__btn');
    expect(buttons.length).toBe(4);

    let action: MessageAction | undefined;
    cmp.action.subscribe((a) => (action = a));
    container.querySelector<HTMLButtonElement>('[aria-label="Reply"]')!.click();
    expect(action).toEqual({ type: 'reply' });
  });

  it('offers Copy in the overflow menu by default and emits it', async () => {
    const { fixture, container } = await render(MessageToolbarComponent);
    const cmp = fixture.componentInstance;

    let action: MessageAction | undefined;
    cmp.action.subscribe((a) => (action = a));

    openMenu(container, fixture);
    const copy = document.querySelector<HTMLElement>(
      '[data-testid="msg-copy"]',
    );
    expect(copy).toBeTruthy();
    // Edit/Delete/Pin are gated off by default.
    expect(document.querySelector('[data-testid="msg-edit"]')).toBeNull();
    expect(document.querySelector('[data-testid="msg-delete"]')).toBeNull();
    expect(document.querySelector('[data-testid="msg-pin"]')).toBeNull();

    copy?.click();
    expect(action).toEqual({ type: 'copy' });
    fixture.destroy();
  });

  it('offers Forward in the overflow menu and emits it', async () => {
    const { fixture, container } = await render(MessageToolbarComponent);
    const cmp = fixture.componentInstance;
    let action: MessageAction | undefined;
    cmp.action.subscribe((a) => (action = a));

    openMenu(container, fixture);
    document.querySelector<HTMLElement>('[data-testid="msg-forward"]')?.click();

    expect(action).toEqual({ type: 'forward' });
    fixture.destroy();
  });

  it('hides Forward for a message a forward cannot carry', async () => {
    const { fixture, container } = await render(MessageToolbarComponent, {
      inputs: { caps: caps({ canForward: false }) },
    });

    openMenu(container, fixture);

    expect(document.querySelector('[data-testid="msg-copy"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="msg-forward"]')).toBeNull();
    fixture.destroy();
  });

  it('reveals Edit and Delete in the menu when permitted and emits on click', async () => {
    const { fixture, container } = await render(MessageToolbarComponent, {
      inputs: { caps: caps({ canEdit: true, canDelete: true }) },
    });

    const cmp = fixture.componentInstance;
    const actions: MessageAction[] = [];
    cmp.action.subscribe((a) => actions.push(a));

    // Choosing a menu item closes the menu, so re-open it before the next click.
    openMenu(container, fixture);
    document.querySelector<HTMLElement>('[data-testid="msg-edit"]')?.click();
    fixture.detectChanges();

    openMenu(container, fixture);
    document.querySelector<HTMLElement>('[data-testid="msg-delete"]')?.click();

    expect(actions).toEqual([{ type: 'edit' }, { type: 'delete' }]);
    fixture.destroy();
  });

  it('offers Pin only when canPin and toggles its label with pinned', async () => {
    // ATL resets TestBed only between tests, so a single test uses one fixture
    // and drives the caps transitions with setInput (matching the sibling specs).
    const { container, fixture } = await render(MessageToolbarComponent);
    const cmp = fixture.componentInstance;

    // Off by default.
    openMenu(container, fixture);
    expect(document.querySelector('[data-testid="msg-pin"]')).toBeNull();

    // canPin → the Pin item appears in the open menu and clicking it emits.
    fixture.componentRef.setInput('caps', caps({ canPin: true }));
    fixture.detectChanges();

    let action: MessageAction | undefined;
    cmp.action.subscribe((a) => (action = a));

    const pin = document.querySelector<HTMLElement>('[data-testid="msg-pin"]');
    expect(pin).toBeTruthy();
    expect(pin?.textContent).toContain('Pin message');
    pin?.click(); // activating a menu item closes the dropdown
    expect(action).toEqual({ type: 'pin' });

    // pinned → the label flips to Unpin (reopen, the click above closed it).
    fixture.componentRef.setInput('caps', caps({ canPin: true, pinned: true }));
    fixture.detectChanges();
    openMenu(container, fixture);
    expect(
      document.querySelector('[data-testid="msg-pin"]')?.textContent,
    ).toContain('Unpin message');
    fixture.destroy();
  });

  it('offers "Reply in thread" by default and hides it when canThread is false', async () => {
    const { fixture, container } = await render(MessageToolbarComponent);
    const cmp = fixture.componentInstance;

    let action: MessageAction | undefined;
    cmp.action.subscribe((a) => (action = a));
    container
      .querySelector<HTMLButtonElement>('[aria-label="Reply in thread"]')!
      .click();
    expect(action).toEqual({ type: 'thread' });

    fixture.componentRef.setInput('caps', caps({ canThread: false }));
    fixture.detectChanges();
    expect(
      container.querySelector('[aria-label="Reply in thread"]'),
    ).toBeNull();
  });

  it('opens the quick-reaction picker and emits the chosen emoji', async () => {
    const { fixture, container } = await render(MessageToolbarComponent);
    const cmp = fixture.componentInstance;

    expect(container.querySelector('.toolbar__picker')).toBeNull();

    let action: MessageAction | undefined;
    cmp.action.subscribe((a) => (action = a));
    cmp.pickerOpen.set(true);
    fixture.detectChanges();

    // The "+" (more emoji) button also carries .toolbar__emoji; scope to the quick set.
    const emojis = container.querySelectorAll<HTMLButtonElement>(
      '.toolbar__emoji:not(.toolbar__emoji--more)',
    );
    expect(emojis.length).toBe(cmp.quickEmojis.length);
    // Named from content (WCAG 2.5.3 label in name): no aria-label replaces the visible
    // emoji, and a hidden prefix says what the button does.
    emojis.forEach((button, index) => {
      expect(button.hasAttribute('aria-label')).toBe(false);
      expect(button.textContent?.replace(/\s+/gu, ' ').trim()).toBe(
        `React with ${cmp.quickEmojis[index]}`,
      );
    });
    emojis[0].click();

    expect(action).toEqual({ type: 'react', key: cmp.quickEmojis[0] });
    expect(cmp.pickerOpen()).toBe(false); // closes after picking
  });

  it('reports quick reactions as an open menu until Escape or an outside click', async () => {
    const { fixture, container } = await render(MessageToolbarComponent);
    const cmp = fixture.componentInstance;
    const reported: boolean[] = [];
    cmp.menuOpenChange.subscribe((open) => reported.push(open));
    const addReaction = () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Add reaction"]')!
        .click();

    addReaction();
    fixture.detectChanges();
    container
      .querySelector('.toolbar__picker')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    expect(cmp.pickerOpen()).toBe(false);

    addReaction();
    fixture.detectChanges();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(cmp.pickerOpen()).toBe(false);

    expect(reported).toEqual([true, false, true, false]);
  });

  it('keeps quick reactions open on a press inside the toolbar', async () => {
    const { fixture, container } = await render(MessageToolbarComponent);
    const cmp = fixture.componentInstance;
    cmp.setPickerOpen(true);
    fixture.detectChanges();

    container
      .querySelector('.toolbar__picker')!
      .dispatchEvent(new Event('pointerdown', { bubbles: true }));

    expect(cmp.pickerOpen()).toBe(true);
  });

  it('closes quick reactions when the overflow menu opens, still reporting open', async () => {
    const { fixture } = await render(MessageToolbarComponent);
    const cmp = fixture.componentInstance;
    const reported: boolean[] = [];
    cmp.menuOpenChange.subscribe((open) => reported.push(open));

    cmp.setPickerOpen(true);
    cmp.setOverflowOpen(true);
    expect(cmp.pickerOpen()).toBe(false);
    cmp.setOverflowOpen(false);

    expect(reported).toEqual([true, false]);
  });

  it('escalates to the full picker via the "+" button', async () => {
    const { fixture, container } = await render(MessageToolbarComponent);
    const cmp = fixture.componentInstance;

    let action: MessageAction | undefined;
    cmp.action.subscribe((a) => (action = a));
    cmp.pickerOpen.set(true);
    fixture.detectChanges();

    container
      .querySelector<HTMLButtonElement>('[data-testid="react-more"]')!
      .click();

    expect(action).toEqual({ type: 'react-more' });
    expect(cmp.pickerOpen()).toBe(false); // closes the quick popover
  });
});

describe('MessageToolbarComponent quote', () => {
  it('offers Quote only for a message with quotable text', async () => {
    const { fixture, container } = await render(MessageToolbarComponent, {
      inputs: { caps: caps() },
    });

    openMenu(container, fixture);
    expect(document.querySelector('[data-testid="msg-quote"]')).toBeNull();

    fixture.componentRef.setInput('caps', caps({ canQuote: true }));
    fixture.detectChanges();

    expect(document.querySelector('[data-testid="msg-quote"]')).not.toBeNull();
  });

  it('emits a quote action distinct from reply', async () => {
    const { fixture, container } = await render(MessageToolbarComponent, {
      inputs: { caps: caps({ canQuote: true }) },
    });
    const seen: MessageAction[] = [];
    fixture.componentInstance.action.subscribe((a) => seen.push(a));

    openMenu(container, fixture);
    document
      .querySelector<HTMLButtonElement>('[data-testid="msg-quote"]')!
      .click();

    // A reply points at the event; a quote brings its words. Same toolbar, different act.
    expect(seen).toEqual([{ type: 'quote' }]);
  });
});

describe('MessageToolbarComponent save media', () => {
  it.each([
    ['image', 'Save image'],
    ['video', 'Save video'],
  ] as const)('offers "%s" save only for media', async (kind, label) => {
    const { fixture, container } = await render(MessageToolbarComponent, {
      inputs: { caps: caps() },
    });
    const seen: MessageAction[] = [];
    fixture.componentInstance.action.subscribe((a) => seen.push(a));

    openMenu(container, fixture);
    expect(document.querySelector('[data-testid="msg-save-media"]')).toBeNull();

    fixture.componentRef.setInput('caps', caps({ saveMedia: kind }));
    fixture.detectChanges();
    const item = document.querySelector<HTMLButtonElement>(
      '[data-testid="msg-save-media"]',
    )!;

    expect(item.textContent).toContain(label);
    item.click();
    expect(seen).toEqual([{ type: 'save-media' }]);
  });

  it('saves a quick reaction as a recently used emoji with no picker open', async () => {
    vi.useFakeTimers();
    try {
      const setAccountDataRaw = vi.fn(async () => ({}));
      const client = {
        getUserId: () => '@alice:hs',
        getAccountData: () => undefined,
        setAccountDataRaw,
        http: {
          authedRequest: vi.fn(async () => ({ recent_emoji: [] })),
        },
        on: vi.fn(),
        off: vi.fn(),
      };
      const { fixture } = await render(MessageToolbarComponent, {
        providers: [
          {
            provide: MatrixClientService,
            useValue: {
              isInitialized: true,
              instance: client,
              activeUserId: signal('@alice:hs').asReadonly(),
            },
          },
        ],
      });

      fixture.componentInstance.pick('🎉');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(setAccountDataRaw).toHaveBeenCalledWith('m.recent_emoji', {
        recent_emoji: [{ emoji: '🎉', total: 1 }],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
