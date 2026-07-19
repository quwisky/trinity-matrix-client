import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockProvider } from 'ng-mocks';
import {
  GifService,
  GifSettingsService,
  type GifProviderId,
  type GifResult,
} from '@trinity/data-access-gif';
import { GifPickerComponent } from './gif-picker.component';

const results: GifResult[] = [
  {
    id: 'a',
    description: 'cat',
    previewUrl: 'https://x/a',
    previewWidth: 1,
    previewHeight: 1,
    url: 'https://x/a-full',
    width: 2,
    height: 2,
  },
  {
    id: 'b',
    description: 'dog',
    previewUrl: 'https://x/b',
    previewWidth: 1,
    previewHeight: 1,
    url: 'https://x/b-full',
    width: 2,
    height: 2,
  },
];

/** Build a detached fixture (avoids ATL render()'s sync-rAF re-entrancy). */
function setup(
  search = vi.fn(() => of(results)),
  provider: GifProviderId = 'tenor',
) {
  TestBed.configureTestingModule({
    imports: [GifPickerComponent],
    providers: [
      MockProvider(GifService, {
        search,
        // Thumbs fetch their preview bytes → blob URL; stub it to an Observable.
        fetchPreview: () => of('blob:preview'),
      }),
      MockProvider(GifSettingsService, {
        provider: signal<GifProviderId>(provider).asReadonly(),
      }),
    ],
  });
  const fixture = TestBed.createComponent(GifPickerComponent);
  fixture.detectChanges();
  return fixture;
}

describe('GifPickerComponent', () => {
  beforeEach(() => {
    // jsdom has no object-URL API; the GIF thumbs revoke their blob URLs.
    URL.revokeObjectURL = vi.fn();
  });

  it('loads trending GIFs on open (empty query, debounced)', async () => {
    const search = vi.fn(() => of(results));
    const fixture = setup(search);
    await vi.waitFor(
      () => {
        fixture.detectChanges();
        expect(search).toHaveBeenCalledWith('');
      },
      { timeout: 1500, interval: 40 },
    );
  });

  it('renders a grid of results and emits the chosen GIF on click', () => {
    const fixture = setup();
    const cmp = fixture.componentInstance;
    cmp.loading.set(false);
    cmp.results.set(results);
    fixture.detectChanges();

    let picked: GifResult | undefined;
    cmp.gifSelect.subscribe((g) => (picked = g));

    const items = fixture.nativeElement.querySelectorAll(
      '[data-testid=gif-result]',
    );
    expect(items.length).toBe(2);
    (items[1] as HTMLButtonElement).click();
    expect(picked).toBe(results[1]);
  });

  it('shows the loading state first, then an empty state when there are none', () => {
    const fixture = setup();
    const cmp = fixture.componentInstance;
    expect(fixture.nativeElement.textContent).toContain('Loading');

    cmp.loading.set(false);
    cmp.results.set([]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No GIFs found');
  });

  it('surfaces a failure state', () => {
    const fixture = setup();
    const cmp = fixture.componentInstance;
    cmp.loading.set(false);
    cmp.failed.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("Couldn't load");
  });

  it('retries the current query after a load failure', async () => {
    const search = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('boom')))
      .mockReturnValue(of(results));
    const fixture = setup(search);
    const cmp = fixture.componentInstance;

    // The initial trending load fails.
    await vi.waitFor(
      () => {
        fixture.detectChanges();
        expect(cmp.failed()).toBe(true);
      },
      { timeout: 1500, interval: 40 },
    );

    // Retry re-runs the same (empty) query — bypassing distinctUntilChanged — and
    // this time it succeeds.
    cmp.retry();
    await vi.waitFor(
      () => {
        fixture.detectChanges();
        expect(cmp.results()).toEqual(results);
      },
      { timeout: 1500, interval: 40 },
    );

    expect(cmp.failed()).toBe(false);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenNthCalledWith(2, '');
  });

  it('updates the query signal as the user types', () => {
    const fixture = setup();
    const input = fixture.nativeElement.querySelector(
      '[data-testid=gif-search]',
    ) as HTMLInputElement;
    input.value = 'cats';
    input.dispatchEvent(new Event('input'));
    expect(fixture.componentInstance.query()).toBe('cats');
  });

  it('shows the active provider attribution', () => {
    const fixture = setup(
      vi.fn(() => of(results)),
      'giphy',
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Powered by GIPHY');
  });
});
