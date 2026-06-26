import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { MessageToolbarComponent } from './message-toolbar.component';

describe('MessageToolbarComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [MessageToolbarComponent] }),
  );

  it('shows react + reply + copy by default and emits reply', () => {
    const fixture = TestBed.createComponent(MessageToolbarComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    const buttons = fixture.nativeElement.querySelectorAll('.toolbar__btn');
    expect(buttons.length).toBe(3); // react + reply + copy, no edit/delete

    let replied = false;
    cmp.replyMessage.subscribe(() => (replied = true));
    fixture.nativeElement
      .querySelector<HTMLButtonElement>('[aria-label="Reply"]')
      .click();
    expect(replied).toBe(true);
  });

  it('reveals edit and delete when permitted and emits on click', () => {
    const fixture = TestBed.createComponent(MessageToolbarComponent);
    fixture.componentRef.setInput('canEdit', true);
    fixture.componentRef.setInput('canDelete', true);
    fixture.detectChanges();

    const cmp = fixture.componentInstance;
    let copied = false;
    let edited = false;
    let deleted = false;
    cmp.copyMessage.subscribe(() => (copied = true));
    cmp.editMessage.subscribe(() => (edited = true));
    cmp.deleteMessage.subscribe(() => (deleted = true));

    const buttons = fixture.nativeElement.querySelectorAll('.toolbar__btn');
    expect(buttons.length).toBe(5); // react + reply + copy + edit + delete
    buttons.forEach((b: HTMLButtonElement) => b.click());

    expect(copied).toBe(true);
    expect(edited).toBe(true);
    expect(deleted).toBe(true);
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
