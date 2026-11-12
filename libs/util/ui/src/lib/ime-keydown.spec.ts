import { describe, expect, it } from 'vitest';
import { isImeKeydown } from './ime-keydown';

function keydown(over: { isComposing?: boolean; keyCode?: number }): Event {
  const event = new KeyboardEvent('keydown', { key: 'Enter' });
  for (const [name, value] of Object.entries(over)) {
    Object.defineProperty(event, name, { value });
  }
  return event;
}

describe('isImeKeydown', () => {
  it('is true while a composition is in progress (Chromium, Firefox)', () => {
    expect(isImeKeydown(keydown({ isComposing: true }))).toBe(true);
  });

  it('is true for the keydown WebKit fires after compositionend, which only keyCode 229 marks', () => {
    expect(isImeKeydown(keydown({ isComposing: false, keyCode: 229 }))).toBe(
      true,
    );
  });

  it('is false for an ordinary Enter', () => {
    expect(isImeKeydown(keydown({ isComposing: false, keyCode: 13 }))).toBe(
      false,
    );
  });
});
