import { ElementRef, type Injector, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { ComposerTextField } from './composer-text-field';

describe('ComposerTextField.autoGrow', () => {
  it('holds the box at its height while the collapsed input is measured', () => {
    const box = document.createElement('div');
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue({
      height: 200,
    } as DOMRect);
    const input = document.createElement('textarea');
    input.value = 'a draft';
    box.append(input);
    let boxDuringMeasure = '';
    Object.defineProperty(input, 'scrollHeight', {
      get: () => {
        boxDuringMeasure = box.style.minHeight;
        return 89;
      },
    });

    new ComposerTextField(
      signal(new ElementRef(input)),
      signal('a draft'),
      {} as Injector,
    ).autoGrow();

    expect(boxDuringMeasure).toBe('200px');
    expect(input.style.height).toBe('89px');
    expect(box.style.minHeight).toBe('');
  });
});
