// Shared TestBed scaffolding for the message-composer specs.
//
// This file exists because the suite was one 3181-line spec holding 169 `it`s. vitest isolates
// per FILE, not per test, so a single file's TestBeds all sit in one fork's heap — and this
// repo has already watched a suite of that size die mid-run under `pool: 'forks'`
// (`rooms-page.spec-harness.ts` is the same shape for the same reason). Splitting the themes
// across files is what bounds the peak; this holds what they all shared.
//
// Every spec file must import this one FIRST: the `vi.mock` below has to be registered before
// anything pulls in `@trinity/platform-native`, and import order is what decides that.
import { signal, type Provider } from '@angular/core';
import { type ComponentFixture } from '@angular/core/testing';
import { of } from 'rxjs';
import { type Mock, vi } from 'vitest';
import { render, type ComponentInput } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import {
  GifService,
  GifSettingsService,
  type GifProviderId,
  type GifResult,
} from '@trinity/data-access/gif';
import { TrnToastService } from '@trinity/components/overlay';
import {
  WorkspaceApplicationSurfaceService,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';
import { MessageComposerComponent } from './message-composer.component';
import { Router } from '@angular/router';

/** Per-test interaction model; desktop remains the default for the composer suite. */
const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isMobileOs: () => platform.mobile,
}));

export function setMobilePlatform(mobile: boolean): void {
  platform.mobile = mobile;
}

// The draft store persists to Capacitor Preferences (debounced); stub it so the
// composer's real DraftStoreService is a no-op on the storage side.
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn().mockResolvedValue({ value: null }),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

/** The staged files, in order — the list equivalent of the old scalar `pendingFile()`. */
export const stagedFiles = (cmp: MessageComposerComponent): readonly File[] =>
  cmp.staged().map((attachment) => attachment.file);

/**
 * Subscribe to `submitMedia`, record the filenames dispatched, and report every item as
 * delivered — which is what drains the strip, exactly as the owner's batch outcome does.
 */
export function collectSends(cmp: MessageComposerComponent): string[] {
  const names: string[] = [];
  cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
    names.push(...items.map((item) => item.file.name));
    onOutcomes(items.map((item) => ({ id: item.id, failed: false })));
  });
  return names;
}

/**
 * Like `collectSends`, but never reports outcomes — which is what an upload still running looks
 * like to the composer. Reporting them synchronously drains the staging and would make the
 * concurrency tests below pass for the wrong reason.
 */
export function collectHeldSends(cmp: MessageComposerComponent): string[] {
  const names: string[] = [];
  cmp.submitMedia.subscribe(({ items }) => {
    names.push(...items.map((item) => item.file.name));
  });
  return names;
}

export let createObjectURL: Mock;
export let revokeObjectURL: Mock;

/**
 * Replace the object-URL API for determinism and spying — Node supplies a real one here, so a
 * dropped stub would silently work instead of throwing. A COUNTER, not a constant: with several
 * files staged the URLs must be distinguishable, and a constant made every revoke assertion
 * vacuous.
 */
export function stubObjectUrls(): void {
  let issued = 0;
  createObjectURL = vi.fn(() => `blob:preview-${++issued}`);
  revokeObjectURL = vi.fn();
  URL.createObjectURL =
    createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL =
    revokeObjectURL as unknown as typeof URL.revokeObjectURL;
}

/** Render the composer with the toast service auto-mocked (plus any extra providers). */
export function renderComposer(
  inputs: ComponentInput<MessageComposerComponent> = {},
  providers: Provider[] = [],
) {
  return render(MessageComposerComponent, {
    inputs,
    providers: [
      MockProvider(TrnToastService),
      // Settings presentation is verified in its own library. Composer tests exercise only
      // the boundary and may override this default when they assert a manage-packs call.
      MockProvider(WorkspaceApplicationSurfaceService, {
        open: (request: WorkspaceApplicationSurfaceRequest) =>
          of({ kind: 'presented' as const, surface: request.surface }),
      }),
      MockProvider(Router, { navigate: vi.fn().mockResolvedValue(true) }),
      ...providers,
    ],
  });
}

export function enter(shift = false): Event {
  return new KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift });
}

export function pasteEvent(opts: { files?: File[]; items?: unknown[] }): {
  event: ClipboardEvent;
  preventDefault: Mock;
} {
  const preventDefault = vi.fn();
  const event = {
    clipboardData: { files: opts.files ?? [], items: opts.items ?? [] },
    preventDefault,
  } as unknown as ClipboardEvent;
  return { event, preventDefault };
}

/** Fire the hidden file input's change event with `files` attached. */
export function pickFiles(
  cmp: MessageComposerComponent,
  files: File[],
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'file';
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  cmp.onFilePicked({ target: input } as unknown as Event);
  return input;
}

export const png = (name: string) =>
  new File([new Uint8Array([1])], name, { type: 'image/png' });

/** Type `value` into the textarea and place the caret (default: at the end). */
export function type(
  fixture: ComponentFixture<MessageComposerComponent>,
  value: string,
  caret = value.length,
): HTMLTextAreaElement {
  const ta = fixture.nativeElement.querySelector(
    'textarea',
  ) as HTMLTextAreaElement;
  ta.value = value;
  ta.selectionStart = ta.selectionEnd = caret;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
  return ta;
}

/**
 * `document`, not the fixture: the suggestion menus render in the CDK overlay container now,
 * so they are no longer inside the component's own DOM. Same reason the insert tray below is
 * asserted this way — it has been a CDK menu all along.
 *
 * The fixture argument is unused and kept only so the twelve call sites read unchanged —
 * the lookup happens whenever this is called, with or without it.
 */
export const menu = (_fixture: ComponentFixture<MessageComposerComponent>) =>
  document.querySelector('[data-testid=emoji-autocomplete]');

export const gifResult: GifResult = {
  id: 'g1',
  description: 'Happy Cat',
  previewUrl: 'https://x/tiny',
  previewWidth: 1,
  previewHeight: 1,
  url: 'https://x/gif',
  width: 2,
  height: 2,
};

/** Providers that enable the GIF affordance and stub the download to `file`. */
export function gifProviders(
  download: () => ReturnType<GifService['download']> = () =>
    of(new File([new Uint8Array([1])], 'happy-cat.gif', { type: 'image/gif' })),
): Provider[] {
  return [
    MockProvider(GifSettingsService, {
      provider: signal<GifProviderId>('klipy').asReadonly(),
      apiKey: signal('KEY').asReadonly(),
      configured: signal(true).asReadonly(),
    }),
    MockProvider(GifService, { download }),
  ];
}
