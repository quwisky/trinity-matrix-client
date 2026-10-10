import { ElementRef, Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { type EditResult } from '@trinity/util/matrix';
import { ComposerFormatting } from './composer-formatting';

function setup(value = '', chord: string | null = null) {
  const el = document.createElement('textarea');
  el.value = value;
  const text = signal(value);
  const previewing = signal(false);
  const composing = signal(false);
  const context = signal<object>({});
  const writes: EditResult[] = [];
  const typing: boolean[] = [];
  const syncMenus = vi.fn();
  const formatting = TestBed.runInInjectionContext(
    () =>
      new ComposerFormatting(
        {
          text,
          previewing,
          composing,
          editing: signal(false),
          context,
          textarea: signal(new ElementRef(el)),
          previewPanel: signal(undefined),
          shortcuts: { resolve: () => (chord ? { id: chord } : null) },
          write: (result) => {
            writes.push(result);
            text.set(result.text);
            el.value = result.text;
            el.setSelectionRange(result.selectionStart, result.selectionEnd);
          },
          autoGrow: vi.fn(),
          syncMenus,
          typing: (hasText) => typing.push(hasText),
        },
        TestBed.inject(Injector),
      ),
  );
  TestBed.tick();
  return {
    el,
    text,
    previewing,
    composing,
    context,
    writes,
    typing,
    syncMenus,
    formatting,
  };
}

const key = (init: KeyboardEventInit) =>
  new KeyboardEvent('keydown', { cancelable: true, ...init });

describe('ComposerFormatting', () => {
  it('wraps the selection and does the keystroke bookkeeping', () => {
    const s = setup('say hello there');
    s.el.setSelectionRange(4, 9);

    s.formatting.onFormat('bold');

    expect(s.text()).toBe('say **hello** there');
    expect(s.syncMenus).toHaveBeenCalledOnce();
    expect(s.typing).toEqual([true]);
  });

  it('applies nothing during an IME composition', () => {
    const s = setup('abc');
    s.composing.set(true);

    s.formatting.onFormat('bold');

    expect(s.writes).toEqual([]);
  });

  it('claims a formatting chord and leaves other chords for the page', () => {
    const claimed = setup('abc', 'format.bold');
    claimed.el.setSelectionRange(0, 3);
    const event = key({ key: 'b', ctrlKey: true });
    claimed.formatting.onKeydown(event);
    expect(event.defaultPrevented).toBe(true);
    expect(claimed.text()).toBe('**abc**');

    const other = setup('abc', 'nav.quickSwitcher');
    const passed = key({ key: 'k', ctrlKey: true });
    other.formatting.onKeydown(passed);
    expect(passed.defaultPrevented).toBe(false);
    expect(other.writes).toEqual([]);
  });

  it('continues a list on Shift+Enter and leaves a plain line to the browser', () => {
    const list = setup('- one');
    list.el.setSelectionRange(5, 5);
    const event = key({ key: 'Enter', shiftKey: true });
    list.formatting.onKeydown(event);
    expect(event.defaultPrevented).toBe(true);
    expect(list.text()).toBe('- one\n- ');

    const plain = setup('one');
    plain.el.setSelectionRange(3, 3);
    const passed = key({ key: 'Enter', shiftKey: true });
    plain.formatting.onKeydown(passed);
    expect(passed.defaultPrevented).toBe(false);
    expect(plain.writes).toEqual([]);
  });

  it('puts a quote above what is typed, caret at the end, and leaves the preview', () => {
    const s = setup('reply');
    s.previewing.set(true);

    s.formatting.insertQuote('> quoted\n\n');

    expect(s.text()).toBe('> quoted\n\nreply');
    expect(s.previewing()).toBe(false);
    expect(s.writes[0]?.selectionEnd).toBe(s.text().length);
  });

  it('applies the menu action to the saved selection, and only while it is current', () => {
    const s = setup('say hello there');
    s.el.setSelectionRange(4, 9);
    s.formatting.captureSelection();
    s.el.setSelectionRange(0, 0); // focus moved into the menu

    s.formatting.onMenuFormat('bold');
    expect(s.text()).toBe('say **hello** there');

    s.text.set('changed under it');
    s.formatting.onMenuFormat('italic');
    expect(s.text()).toBe('changed under it');
  });

  it('keeps a selection made before the next render after a menu action', () => {
    const s = setup('say hello there');
    document.body.append(s.el);
    s.el.setSelectionRange(4, 9);
    s.formatting.captureSelection();

    s.formatting.onMenuFormat('bold');
    expect(document.activeElement).toBe(s.el);
    // Select-all lands before change detection has run the deferred restore.
    s.el.setSelectionRange(0, s.el.value.length);
    TestBed.tick();

    expect([s.el.selectionStart, s.el.selectionEnd]).toEqual([0, 19]);
    s.el.remove();
  });

  it('takes focus back after a menu action when the menu teardown moved it', () => {
    const s = setup('say hello there');
    const trigger = document.createElement('button');
    document.body.append(s.el, trigger);
    s.el.setSelectionRange(4, 9);
    s.formatting.captureSelection();

    s.formatting.onMenuFormat('bold');
    trigger.focus();
    TestBed.tick();

    expect(document.activeElement).toBe(s.el);
    expect([s.el.selectionStart, s.el.selectionEnd]).toEqual([6, 11]);
    s.el.remove();
    trigger.remove();
  });

  it('drops the saved selection and the preview when the context changes', () => {
    const s = setup('say hello there');
    s.el.setSelectionRange(4, 9);
    s.formatting.captureSelection();
    s.previewing.set(true);

    s.context.set({});
    TestBed.tick();

    expect(s.previewing()).toBe(false);
    s.formatting.onMenuFormat('bold');
    expect(s.writes).toEqual([]);
  });

  it('toggles the preview and keeps the selection it left', () => {
    const s = setup('abc');
    s.el.setSelectionRange(1, 2);

    s.formatting.onTogglePreview();
    expect(s.previewing()).toBe(true);
    s.el.setSelectionRange(0, 0);

    s.formatting.onTogglePreview();
    expect(s.previewing()).toBe(false);
    expect([s.el.selectionStart, s.el.selectionEnd]).toEqual([1, 2]);
  });
});
