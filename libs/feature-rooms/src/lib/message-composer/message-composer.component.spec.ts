import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { MessageComposerComponent } from './message-composer.component';

describe('MessageComposerComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [MessageComposerComponent] }),
  );

  function enter(shift = false): Event {
    return new KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift });
  }

  it('emits the trimmed text on Enter and clears the input', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    let sent: string | undefined;
    cmp.send.subscribe((t) => (sent = t));

    cmp.text.set('  hello  ');
    cmp.onEnter(enter());

    expect(sent).toBe('hello');
    expect(cmp.text()).toBe('');
  });

  it('does not send on Shift+Enter or when empty', () => {
    const fixture = TestBed.createComponent(MessageComposerComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    let count = 0;
    cmp.send.subscribe(() => count++);

    cmp.text.set('keep typing');
    cmp.onEnter(enter(true)); // Shift+Enter → newline, no send

    cmp.text.set('   '); // whitespace only
    cmp.onEnter(enter());

    expect(count).toBe(0);
    expect(cmp.text()).toBe('   ');
  });
});
