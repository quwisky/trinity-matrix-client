import { TestBed } from '@angular/core/testing';
import { ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { MessageToolbarComponent } from './message-toolbar.component';

/**
 * Open the overflow "⋯" menu; its items render into the CDK overlay (document), so
 * queries after this look there rather than in the fixture element.
 */
function openMenu(fixture: ComponentFixture<MessageToolbarComponent>): void {
  fixture.nativeElement
    .querySelector<HTMLButtonElement>('[data-testid="msg-more"]')
    .click();
  fixture.detectChanges();
}

describe('MessageToolbarComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [MessageToolbarComponent] }),
  );

  it('shows react + reply + thread + overflow inline and emits reply', () => {
    const fixture = TestBed.createComponent(MessageToolbarComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    // Inline: react + reply + thread + the "⋯" overflow trigger (copy/edit/delete
    // now live inside the overflow menu, not inline).
    const buttons = fixture.nativeElement.querySelectorAll('.toolbar__btn');
    expect(buttons.length).toBe(4);

    let replied = false;
    cmp.replyMessage.subscribe(() => (replied = true));
    fixture.nativeElement
      .querySelector<HTMLButtonElement>('[aria-label="Reply"]')
      .click();
    expect(replied).toBe(true);
  });

  it('offers Copy in the overflow menu by default and emits it', () => {
    const fixture = TestBed.createComponent(MessageToolbarComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    let copied = false;
    cmp.copyMessage.subscribe(() => (copied = true));

    openMenu(fixture);
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

  it('reveals Edit and Delete in the menu when permitted and emits on click', () => {
    const fixture = TestBed.createComponent(MessageToolbarComponent);
    fixture.componentRef.setInput('canEdit', true);
    fixture.componentRef.setInput('canDelete', true);
    fixture.detectChanges();

    const cmp = fixture.componentInstance;
    let edited = false;
    let deleted = false;
    cmp.editMessage.subscribe(() => (edited = true));
    cmp.deleteMessage.subscribe(() => (deleted = true));

    // Choosing a menu item closes the menu, so re-open it before the next click.
    openMenu(fixture);
    document.querySelector<HTMLElement>('[data-testid="msg-edit"]')?.click();
    fixture.detectChanges();

    openMenu(fixture);
    document.querySelector<HTMLElement>('[data-testid="msg-delete"]')?.click();

    expect(edited).toBe(true);
    expect(deleted).toBe(true);
    fixture.destroy();
  });

  it('offers Pin only when canPin and toggles its label with pinned', () => {
    const fixture = TestBed.createComponent(MessageToolbarComponent);
    fixture.detectChanges();

    // Off by default.
    openMenu(fixture);
    expect(document.querySelector('[data-testid="msg-pin"]')).toBeNull();
    fixture.destroy();

    const fixture2 = TestBed.createComponent(MessageToolbarComponent);
    fixture2.componentRef.setInput('canPin', true);
    fixture2.detectChanges();
    const cmp = fixture2.componentInstance;

    let toggled = false;
    cmp.togglePin.subscribe(() => (toggled = true));

    openMenu(fixture2);
    const pin = document.querySelector<HTMLElement>('[data-testid="msg-pin"]');
    expect(pin).toBeTruthy();
    expect(pin?.textContent).toContain('Pin message');
    pin?.click();
    expect(toggled).toBe(true);
    fixture2.destroy();

    const fixture3 = TestBed.createComponent(MessageToolbarComponent);
    fixture3.componentRef.setInput('canPin', true);
    fixture3.componentRef.setInput('pinned', true);
    fixture3.detectChanges();
    openMenu(fixture3);
    expect(
      document.querySelector('[data-testid="msg-pin"]')?.textContent,
    ).toContain('Unpin message');
    fixture3.destroy();
  });

  it('offers "Reply in thread" by default and hides it when canThread is false', () => {
    const fixture = TestBed.createComponent(MessageToolbarComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    let threaded = false;
    cmp.openThread.subscribe(() => (threaded = true));
    fixture.nativeElement
      .querySelector<HTMLButtonElement>('[aria-label="Reply in thread"]')
      .click();
    expect(threaded).toBe(true);

    fixture.componentRef.setInput('canThread', false);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[aria-label="Reply in thread"]'),
    ).toBeNull();
  });

  it('opens the quick-reaction picker and emits the chosen emoji', () => {
    const fixture = TestBed.createComponent(MessageToolbarComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    expect(fixture.nativeElement.querySelector('.toolbar__picker')).toBeNull();

    let reacted = '';
    cmp.react.subscribe((k) => (reacted = k));
    cmp.pickerOpen.set(true);
    fixture.detectChanges();

    const emojis =
      fixture.nativeElement.querySelectorAll<HTMLButtonElement>(
        '.toolbar__emoji',
      );
    expect(emojis.length).toBe(cmp.quickEmojis.length);
    emojis[0].click();

    expect(reacted).toBe(cmp.quickEmojis[0]);
    expect(cmp.pickerOpen()).toBe(false); // closes after picking
  });
});
