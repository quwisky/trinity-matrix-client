import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EditorView } from '@codemirror/view';
import { APP_CONFIG_ENTRIES, type ConfigEntry } from '@trinity/platform-native';
import { render } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { ConfigEditorComponent } from './config-editor.component';

const ENTRIES: readonly ConfigEntry[] = [
  {
    path: 'theme.palette',
    key: 'trinity.palette',
    description: 'The accent colour the whole app is themed from.',
    type: 'string',
    choices: ['trinity', 'amethyst'],
    read: () => 'trinity',
    reset: () => undefined,
    write: () => undefined,
    validate: (value) =>
      value === 'trinity' || value === 'amethyst'
        ? { ok: true, value }
        : { ok: false, problem: 'is not a known palette' },
  },
];

function documentOf(palette: string): string {
  return JSON.stringify(
    { version: 1, settings: { theme: { palette } } },
    null,
    2,
  );
}

/** Mount the editor and hand back the `EditorView` it built, found through its own DOM. */
async function open(value: string) {
  const edits: string[] = [];
  const rendered = await render(ConfigEditorComponent, {
    providers: [
      { provide: APP_CONFIG_ENTRIES, multi: true, useValue: ENTRIES },
    ],
    inputs: { value },
    on: { edited: (text: string) => edits.push(text) },
  });
  // `afterNextRender` is what creates the editor, and it runs on a real application tick
  // rather than on a fixture's own change detection.
  TestBed.inject(ApplicationRef).tick();
  const host = rendered.container.querySelector(
    '[data-testid=advanced-config-editor-host]',
  ) as HTMLElement;
  const view = EditorView.findFromDOM(host);
  return { ...rendered, edits, view };
}

describe('ConfigEditorComponent', () => {
  it('shows the document it is given', async () => {
    const doc = documentOf('trinity');
    const { view } = await open(doc);

    expect(view?.state.doc.toString()).toBe(doc);
  });

  it('names itself for the harness and for a screen reader', async () => {
    const { container } = await open(documentOf('trinity'));
    const content = container.querySelector(
      '[data-testid=advanced-config-editor]',
    );

    expect(content?.getAttribute('aria-label')).toBe('Settings JSON');
  });

  it('reports what the user types', async () => {
    const { view, edits } = await open(documentOf('trinity'));

    view?.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: '{"edited":true}',
      },
    });

    expect(edits).toEqual(['{"edited":true}']);
  });

  it('does not report a document that was pushed in from outside as an edit', async () => {
    const doc = documentOf('trinity');
    const { fixture, view, edits } = await open(doc);
    const next = documentOf('amethyst');

    fixture.componentRef.setInput('value', next);
    fixture.detectChanges();

    expect(view?.state.doc.toString()).toBe(next);
    // The section's own text coming back out would mark a box dirty that nobody touched.
    expect(edits).toEqual([]);
  });

  it('tears the editor down with the component', async () => {
    const { fixture, view } = await open(documentOf('trinity'));
    const destroy = vi.spyOn(view as EditorView, 'destroy');

    fixture.destroy();

    expect(destroy).toHaveBeenCalled();
  });
});
