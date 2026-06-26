import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { MessageToolbarComponent } from './message-toolbar.component';

describe('MessageToolbarComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [MessageToolbarComponent] }),
  );

  it('shows only the copy action by default', () => {
    const fixture = TestBed.createComponent(MessageToolbarComponent);
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('.toolbar__btn');
    expect(buttons.length).toBe(1);
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
    expect(buttons.length).toBe(3);
    buttons.forEach((b: HTMLButtonElement) => b.click());

    expect(copied).toBe(true);
    expect(edited).toBe(true);
    expect(deleted).toBe(true);
  });
});
