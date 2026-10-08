import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ComposerDrafts } from './composer-drafts';

function setup(
  initial: {
    roomId?: string | null;
    text?: string;
    stored?: [string, string];
  } = {},
) {
  const inputs = {
    roomId: signal<string | null>(initial.roomId ?? null),
    editing: signal(false),
    editTargetId: signal<string | null>(null),
    draft: signal(''),
    composeDraft: signal<string | null>(null),
  };
  const text = signal(initial.text ?? '');
  const saved = new Map<string, string>(initial.stored ? [initial.stored] : []);
  const calls: string[] = [];
  const emitted: string[] = [];
  TestBed.runInInjectionContext(
    () =>
      new ComposerDrafts({
        ...inputs,
        text,
        store: {
          get: (id) => saved.get(id) ?? '',
          set: (id, value) => saved.set(id, value),
        },
        emitDraft: (draft) => emitted.push(draft),
        leaveRoom: (prev) => calls.push(`leave:${String(prev)}`),
        leavePreview: () => calls.push('preview'),
        autoGrow: vi.fn(),
        focusAtEnd: vi.fn(),
      }),
  );
  TestBed.tick();
  return { ...inputs, text, saved, calls, emitted };
}

describe('ComposerDrafts', () => {
  it('loads the stored draft on mount and tells the owner nothing was left', () => {
    const { text, calls } = setup({ roomId: '!a', stored: ['!a', 'stored'] });
    expect(calls).toEqual(['leave:undefined']);
    expect(text()).toBe('stored');
  });

  it('saves the leaving room draft and loads the next one', () => {
    const s = setup({ roomId: '!a' });
    s.saved.set('!b', 'draft B');
    s.text.set('typed in A');
    TestBed.tick();

    s.roomId.set('!b');
    TestBed.tick();

    expect(s.saved.get('!a')).toBe('typed in A');
    expect(s.text()).toBe('draft B');
    expect(s.calls).toContain('leave:!a');
  });

  it('leaves the text alone on a room switch while editing', () => {
    const s = setup({ roomId: '!a' });
    s.editing.set(true);
    s.editTargetId.set('$m');
    s.draft.set('edit body');
    TestBed.tick();

    s.roomId.set('!b');
    TestBed.tick();

    expect(s.text()).toBe('edit body');
    expect(s.saved.get('!a')).toBe(''); // only the mount write; the edit body never lands
  });

  it('prefills on edit start and re-targets, but ignores a body change of the same target', () => {
    const s = setup({ roomId: '!a' });
    s.editing.set(true);
    s.editTargetId.set('$a');
    s.draft.set('body A');
    TestBed.tick();
    expect(s.text()).toBe('body A');

    s.text.set('typed');
    s.draft.set('redacted');
    TestBed.tick();
    expect(s.text()).toBe('typed');

    s.editTargetId.set('$b');
    s.draft.set('body B');
    TestBed.tick();
    expect(s.text()).toBe('body B');
  });

  it('restores the compose draft when the edit ends, without saving the edit body', () => {
    const s = setup({ roomId: '!a' });
    s.text.set('compose');
    TestBed.tick();
    s.editing.set(true);
    s.editTargetId.set('$m');
    s.draft.set('edit body');
    TestBed.tick();
    expect(s.saved.get('!a')).toBe('compose');

    s.editing.set(false);
    s.editTargetId.set(null);
    TestBed.tick();
    expect(s.text()).toBe('compose');
  });

  it('emits a managed draft instead of storing it, and mirrors an external change', () => {
    const s = setup({ roomId: '!a' });
    s.composeDraft.set('managed');
    TestBed.tick();
    expect(s.text()).toBe('managed');

    s.text.set('managed plus');
    TestBed.tick();
    expect(s.emitted.at(-1)).toBe('managed plus');
    expect(s.saved.get('!a')).toBe(''); // only the mount write

    s.composeDraft.set('external');
    TestBed.tick();
    expect(s.text()).toBe('external');
  });
});
