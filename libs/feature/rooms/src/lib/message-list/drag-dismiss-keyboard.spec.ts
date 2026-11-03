import { dismissKeyboardOnDrag } from './drag-dismiss-keyboard';

function touch(
  el: HTMLElement,
  type: string,
  points: readonly { x: number; y: number }[],
): void {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'touches', {
    value: points.map((p) => ({ clientX: p.x, clientY: p.y })),
  });
  el.dispatchEvent(event);
}

describe('dismissKeyboardOnDrag', () => {
  let list: HTMLElement;
  let field: HTMLTextAreaElement;
  let stop: () => void;

  beforeEach(() => {
    list = document.createElement('div');
    field = document.createElement('textarea');
    document.body.append(list, field);
    field.focus();
    stop = dismissKeyboardOnDrag(list);
  });

  afterEach(() => {
    stop();
    list.remove();
    field.remove();
  });

  const drag = (dx: number, dy: number): void => {
    touch(list, 'touchstart', [{ x: 100, y: 100 }]);
    touch(list, 'touchmove', [{ x: 100 + dx, y: 100 + dy }]);
  };

  it('blurs the field once the finger is past 40px down', () => {
    drag(0, 41);
    expect(field).not.toBe(document.activeElement);
  });

  it('keeps it at exactly 40px, upward and sideways', () => {
    drag(0, 40);
    expect(field).toBe(document.activeElement);
    drag(0, -120);
    expect(field).toBe(document.activeElement);
    drag(120, 60);
    expect(field).toBe(document.activeElement);
  });

  it('ignores a gesture that began with two fingers', () => {
    touch(list, 'touchstart', [
      { x: 100, y: 100 },
      { x: 150, y: 100 },
    ]);
    touch(list, 'touchmove', [{ x: 100, y: 200 }]);
    expect(field).toBe(document.activeElement);
  });

  it('does not blur an element that is not a field', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    drag(0, 100);
    expect(button).toBe(document.activeElement);
    button.remove();
  });

  it('does not blur contenteditable="false"', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'false');
    div.tabIndex = 0;
    document.body.append(div);
    div.focus();
    drag(0, 100);
    expect(div).toBe(document.activeElement);
    div.remove();
  });

  it('stops listening after cleanup', () => {
    stop();
    drag(0, 100);
    expect(field).toBe(document.activeElement);
  });
});
