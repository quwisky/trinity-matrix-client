import { ComponentFixture } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import { describe, expect, it } from 'vitest';
import { MessageToolbarComponent } from './message-toolbar.component';

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

    let replied = false;
    cmp.replyMessage.subscribe(() => (replied = true));
    container.querySelector<HTMLButtonElement>('[aria-label="Reply"]')!.click();
    expect(replied).toBe(true);
  });

  it('offers Copy in the overflow menu by default and emits it', async () => {
    const { fixture, container } = await render(MessageToolbarComponent);
    const cmp = fixture.componentInstance;

    let copied = false;
    cmp.copyMessage.subscribe(() => (copied = true));

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
    expect(copied).toBe(true);
    fixture.destroy();
  });

  it('reveals Edit and Delete in the menu when permitted and emits on click', async () => {
    const { fixture, container } = await render(MessageToolbarComponent, {
      inputs: { canEdit: true, canDelete: true },
    });

    const cmp = fixture.componentInstance;
    let edited = false;
    let deleted = false;
    cmp.editMessage.subscribe(() => (edited = true));
    cmp.deleteMessage.subscribe(() => (deleted = true));

    // Choosing a menu item closes the menu, so re-open it before the next click.
    openMenu(container, fixture);
    document.querySelector<HTMLElement>('[data-testid="msg-edit"]')?.click();
    fixture.detectChanges();

    openMenu(container, fixture);
    document.querySelector<HTMLElement>('[data-testid="msg-delete"]')?.click();

    expect(edited).toBe(true);
    expect(deleted).toBe(true);
    fixture.destroy();
  });

  it('offers Pin only when canPin and toggles its label with pinned', async () => {
    // ATL resets TestBed only between tests, so a single test uses one fixture
    // and drives the input transitions with setInput (matching the sibling specs).
    const { container, fixture } = await render(MessageToolbarComponent);
    const cmp = fixture.componentInstance;

    // Off by default.
    openMenu(container, fixture);
    expect(document.querySelector('[data-testid="msg-pin"]')).toBeNull();

    // canPin → the Pin item appears in the open menu and clicking it emits.
    fixture.componentRef.setInput('canPin', true);
    fixture.detectChanges();

    let toggled = false;
    cmp.togglePin.subscribe(() => (toggled = true));

    const pin = document.querySelector<HTMLElement>('[data-testid="msg-pin"]');
    expect(pin).toBeTruthy();
    expect(pin?.textContent).toContain('Pin message');
    pin?.click(); // activating a menu item closes the dropdown
    expect(toggled).toBe(true);

    // pinned → the label flips to Unpin (reopen, the click above closed it).
    fixture.componentRef.setInput('pinned', true);
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

    let threaded = false;
    cmp.openThread.subscribe(() => (threaded = true));
    container
      .querySelector<HTMLButtonElement>('[aria-label="Reply in thread"]')!
      .click();
    expect(threaded).toBe(true);

    fixture.componentRef.setInput('canThread', false);
    fixture.detectChanges();
    expect(
      container.querySelector('[aria-label="Reply in thread"]'),
    ).toBeNull();
  });

  it('opens the quick-reaction picker and emits the chosen emoji', async () => {
    const { fixture, container } = await render(MessageToolbarComponent);
    const cmp = fixture.componentInstance;

    expect(container.querySelector('.toolbar__picker')).toBeNull();

    let reacted = '';
    cmp.react.subscribe((k) => (reacted = k));
    cmp.pickerOpen.set(true);
    fixture.detectChanges();

    const emojis =
      container.querySelectorAll<HTMLButtonElement>('.toolbar__emoji');
    expect(emojis.length).toBe(cmp.quickEmojis.length);
    emojis[0].click();

    expect(reacted).toBe(cmp.quickEmojis[0]);
    expect(cmp.pickerOpen()).toBe(false); // closes after picking
  });
});
