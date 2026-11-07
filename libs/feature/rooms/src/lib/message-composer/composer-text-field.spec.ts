import { ElementRef, type Injector, signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  const text = signal(value);
  const field = new ComposerTextField(
    signal(new ElementRef(input)),
    text,
    {} as Injector,
  );
  return { box, rect, input, boxAtRead, field, text };
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

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

/** An attached field in a browser with `userAgent`, whose execCommand is recorded. */
function setUpBrowser(value: string, userAgent: string) {
  const setup = setUp(value, 0);
  document.body.append(setup.box);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  const calls: [string, string, number, number][] = [];
  const execCommand = vi.fn((command: string, _ui: boolean, insert: string) => {
    const { input } = setup;
    calls.push([command, insert, input.selectionStart, input.selectionEnd]);
    input.setRangeText(insert);
    return true;
  });
  Object.assign(document, { execCommand });
  return { ...setup, calls, execCommand };
}

describe('ComposerTextField edits', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'execCommand');
    document.body.replaceChildren();
  });

  it('writes only the changed span through execCommand, so undo keeps the edit', () => {
    const { input, field, text, calls } = setUpBrowser('say hello', CHROME_UA);

    field.write({ text: 'say **hello**', selectionStart: 6, selectionEnd: 11 });

    expect(calls).toEqual([['insertText', '**hello**', 4, 9]]);
    expect(input.value).toBe('say **hello**');
    expect(text()).toBe('say **hello**');
    expect([input.selectionStart, input.selectionEnd]).toEqual([6, 11]);
  });

  it('assigns the value on WebKit, which would merge the edit into the typing before it', () => {
    const { input, field, execCommand } = setUpBrowser('say hello', SAFARI_UA);

    field.write({ text: 'say **hello**', selectionStart: 6, selectionEnd: 11 });

    expect(execCommand).not.toHaveBeenCalled();
    expect(input.value).toBe('say **hello**');
  });

  it('assigns the value when the browser has no execCommand', () => {
    const { input, field } = setUpBrowser('- one\n- ', CHROME_UA);
    Reflect.deleteProperty(document, 'execCommand');

    field.write({ text: '- one\n', selectionStart: 6, selectionEnd: 6 });

    expect(input.ownerDocument.activeElement).toBe(input);
    expect(input.value).toBe('- one\n');
  });

  it('replaces a range through execCommand', () => {
    const { input, field, text, calls } = setUpBrowser('hi :smile:', CHROME_UA);

    field.replaceRange(3, 10, '😄');

    expect(calls).toEqual([['insertText', '😄', 3, 10]]);
    expect(input.value).toBe('hi 😄');
    expect(text()).toBe('hi 😄');
  });
});
