import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { MessageReactionsComponent } from './message-reactions.component';

describe('MessageReactionsComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [MessageReactionsComponent] }),
  );

  it('renders a pill per reaction, flags the user’s own, and emits toggle', () => {
    const fixture = TestBed.createComponent(MessageReactionsComponent);
    fixture.componentRef.setInput('reactions', [
      { key: '👍', count: 2, reacted: true },
      { key: '❤️', count: 1, reacted: false },
    ]);
    fixture.detectChanges();

    const el = fixture.nativeElement;
    const pills = el.querySelectorAll<HTMLButtonElement>('.reaction');
    expect(pills.length).toBe(2);
    expect(el.querySelectorAll('.reaction--mine').length).toBe(1);
    expect(pills[0].textContent).toContain('👍');
    expect(pills[0].textContent).toContain('2');

    let toggled = '';
    fixture.componentInstance.toggleReaction.subscribe((k) => (toggled = k));
    pills[0].click();
    expect(toggled).toBe('👍');
  });
});
