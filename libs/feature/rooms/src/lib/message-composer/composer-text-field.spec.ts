import { ElementRef, type Injector, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { ComposerTextField } from './composer-text-field';

function setUp(value: string, scrollHeight: number) {
  const box = document.createElement('div');
  const rect = vi
    .spyOn(box, 'getBoundingClientRect')
    .mockReturnValue({ height: 200 } as DOMRect);
  const input = document.createElement('textarea');
  input.value = value;
  input.style.height = '120px';
  box.append(input);
  const boxAtRead: string[] = [];
  Object.defineProperty(input, 'scrollHeight', {
    get: () => {
      boxAtRead.push(box.style.minHeight);
      return scrollHeight;
    },
  });
  const field = new ComposerTextField(
    signal(new ElementRef(input)),
    signal(value),
    {} as Injector,
  );
  return { box, rect, input, boxAtRead, field };
}

describe('ComposerTextField.autoGrow', () => {
  it('holds the box at its height while the collapsed input is measured', () => {
    const { box, input, boxAtRead, field } = setUp('a draft', 89);

    field.autoGrow();

    expect(boxAtRead.at(-1)).toBe('200px');
    expect(input.style.height).toBe('89px');
    expect(box.style.minHeight).toBe('');
  });

  it('keeps the height of an input that is not rendered', () => {
    const { rect, input, field } = setUp('a draft', 0);

    field.autoGrow();

    expect(input.style.height).toBe('120px');
    expect(rect).not.toHaveBeenCalled();
  });

  it('rests an empty input without measuring anything', () => {
    const { rect, input, boxAtRead, field } = setUp('', 89);

    field.autoGrow();

    expect(input.style.height).toBe('auto');
    expect(boxAtRead).toEqual([]);
    expect(rect).not.toHaveBeenCalled();
  });
});
