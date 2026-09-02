import { Component, input, output, signal } from '@angular/core';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { APP_CONFIG_ENTRIES, type ConfigEntry } from '@trinity/platform-native';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdvancedSettingsComponent } from './advanced-settings.component';
import {
  CONFIG_EDITOR_LOADER,
  type ConfigEditorHost,
} from './config-editor-loader';

const platform = vi.hoisted(() => ({ native: false }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  supportsRichConfigEditing: () => !platform.native,
}));

/**
 * The rich editor and the platform gate around it.
 *
 * The real editor is not mounted here — that is CodeMirror's job and it is covered in
 * `config-editor/`. What matters at this level is the contract between the section and
 * whatever editor arrives: one document in, edits out, and the same dirty-state rule the
 * textarea obeys. A stand-in component makes that testable without the chunk.
 */
const palette = signal('violet');

const ENTRIES: readonly ConfigEntry[] = [
  {
    path: 'theme.palette',
    key: 'trinity.palette',
    description: 'The accent colour the whole app is themed from.',
    type: 'string',
    read: () => palette(),
    reset: () => palette.set('trinity'),
    write: (value) => palette.set(String(value)),
    validate: (value) =>
      typeof value === 'string'
        ? { ok: true, value }
        : { ok: false, problem: 'is not text' },
  },
];

/** Stands in for the lazily-loaded editor: the same two-way contract, none of the weight. */
@Component({
  selector: 'trn-stub-config-editor',
  template: `<textarea
    data-testid="stub-editor"
    [value]="value()"
    (input)="edited.emit($any($event.target).value)"
  ></textarea>`,
})
class StubConfigEditorComponent implements ConfigEditorHost {
  readonly value = input.required<string>();
  readonly edited = output<string>();
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve));

function query(container: Element, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid=${testid}]`);
}

function documentJson(settings: object): string {
  return JSON.stringify({
    version: 1,
    exportedAt: '2026-08-09T00:00:00.000Z',
    settings,
  });
}

describe('AdvancedSettingsComponent — the rich editor', () => {
  beforeEach(() => {
    palette.set('violet');
    platform.native = false;
  });

  afterEach(() => vi.restoreAllMocks());

  function providers(withEditor: boolean) {
    return [
      { provide: APP_CONFIG_ENTRIES, multi: true, useValue: ENTRIES },
      MockProvider(TrnAlertService, { prompt$: vi.fn() }),
      MockProvider(TrnToastService, { show: vi.fn() }),
      ...(withEditor
        ? [
            {
              provide: CONFIG_EDITOR_LOADER,
              useValue: () => of(StubConfigEditorComponent),
            },
          ]
        : []),
    ];
  }

  async function open(withEditor = true) {
    const rendered = await render(AdvancedSettingsComponent, {
      providers: providers(withEditor),
    });
    await flush();
    rendered.fixture.detectChanges();
    return rendered;
  }

  function editor(container: Element): HTMLTextAreaElement {
    return query(container, 'stub-editor') as HTMLTextAreaElement;
  }

  it('replaces the textarea once the editor chunk arrives', async () => {
    const { container } = await open();

    expect(editor(container)).not.toBeNull();
    expect(query(container, 'advanced-config-json')).toBeNull();
    expect(JSON.parse(editor(container).value)).toMatchObject({
      settings: { theme: { palette: 'violet' } },
    });
  });

  it('keeps the textarea when no editor is wired up, and still edits in it', async () => {
    // The production case this covers is not a missing provider but a chunk that never
    // arrives — offline on a first visit, since the service worker holds it lazily.
    const { container, fixture } = await open(false);
    const box = query(container, 'advanced-config-json') as HTMLTextAreaElement;

    box.value = documentJson({ theme: { palette: 'amethyst' } });
    box.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(box.readOnly).toBe(false);
    expect(query(container, 'advanced-discard')).not.toBeNull();
  });

  it('takes the document over from the live settings when the editor is typed in', async () => {
    const { container, fixture } = await open();
    const mine = documentJson({ theme: { palette: 'amethyst' } });

    editor(container).value = mine;
    editor(container).dispatchEvent(new Event('input'));
    fixture.detectChanges();
    // Without the dirty rule, a preference moving anywhere would overwrite what was typed.
    palette.set('emerald');
    fixture.detectChanges();

    expect(editor(container).value).toBe(mine);
    expect(query(container, 'advanced-edited-note')?.textContent).toContain(
      'stopped following',
    );
  });

  it('gives the editor back to the live document when the edit is discarded', async () => {
    const { container, fixture } = await open();
    editor(container).value = '{ not a document';
    editor(container).dispatchEvent(new Event('input'));
    fixture.detectChanges();

    (query(container, 'advanced-discard') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(JSON.parse(editor(container).value)).toMatchObject({
      settings: { theme: { palette: 'violet' } },
    });
  });

  it('checks what the editor holds, not what the app holds', async () => {
    const { container, fixture } = await open();
    editor(container).value = documentJson({ theme: { palette: 'amethyst' } });
    editor(container).dispatchEvent(new Event('input'));
    fixture.detectChanges();

    (query(container, 'advanced-apply') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(query(container, 'advanced-apply-summary')?.textContent).toContain(
      'theme.palette',
    );
    expect(palette()).toBe('violet');
  });
});

describe('AdvancedSettingsComponent — the mobile app', () => {
  beforeEach(() => {
    palette.set('violet');
    platform.native = true;
  });

  afterEach(() => vi.restoreAllMocks());

  async function openNative() {
    return await render(AdvancedSettingsComponent, {
      providers: [
        { provide: APP_CONFIG_ENTRIES, multi: true, useValue: ENTRIES },
        MockProvider(TrnAlertService, { prompt$: vi.fn() }),
        MockProvider(TrnToastService, { show: vi.fn() }),
      ],
    });
  }

  it('shows the document read-only, with no way to apply or import one', async () => {
    const { container } = await openNative();
    const box = query(container, 'advanced-config-json') as HTMLTextAreaElement;

    expect(box.readOnly).toBe(true);
    for (const gone of [
      'advanced-apply',
      'advanced-import-file',
      'advanced-import-clipboard',
      'advanced-import-file-input',
    ]) {
      expect(query(container, gone)).toBeNull();
    }
  });

  it('keeps the half that is useful on a phone — read, copy, reset', async () => {
    const { container } = await openNative();

    expect(query(container, 'advanced-copy')).not.toBeNull();
    expect(query(container, 'advanced-reset')).not.toBeNull();
  });

  it('says why editing is missing rather than leaving a gap', async () => {
    const { container } = await openNative();

    expect(
      query(container, 'advanced-editing-unavailable')?.textContent,
    ).toContain('mobile app');
  });
});
