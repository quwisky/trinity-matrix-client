import { ComponentFixture } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import { describe, expect, it } from 'vitest';
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

    const emojis =
      container.querySelectorAll<HTMLButtonElement>('.toolbar__emoji');
    expect(emojis.length).toBe(cmp.quickEmojis.length);
    emojis[0].click();

    expect(action).toEqual({ type: 'react', key: cmp.quickEmojis[0] });
    expect(cmp.pickerOpen()).toBe(false); // closes after picking
  });
});
