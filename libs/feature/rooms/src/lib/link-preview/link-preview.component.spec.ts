import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  UrlPreviewService,
  type UrlPreview,
} from '@trinity/data-access/timeline';
import { PrivacySettingsService } from '@trinity/platform-native';
import { AVATAR_RESOLVER } from '@trinity/ui';
import { LinkPreviewComponent } from './link-preview.component';

function preview(over: Partial<UrlPreview> = {}): UrlPreview {
  return {
    url: 'https://example.com',
    title: 'Example',
    description: 'A description',
    imageMxc: null,
    ...over,
  };
}

async function build(
  opts: {
    url?: string;
    enabled?: boolean;
    encrypted?: boolean;
    encryptedEnabled?: boolean;
    result?: UrlPreview | null;
    resolveImage?: string | null;
  } = {},
) {
  const result: UrlPreview | null =
    'result' in opts ? (opts.result ?? null) : preview();
  const previewFn = vi.fn(() => of(result));
  const resolver = vi.fn(() => of(opts.resolveImage ?? null));
  const { fixture, container } = await render(LinkPreviewComponent, {
    inputs: {
      url: opts.url ?? 'https://example.com',
      encrypted: opts.encrypted ?? false,
    },
    providers: [
      MockProvider(UrlPreviewService, { preview: previewFn }),
      MockProvider(PrivacySettingsService, {
        linkPreviews: signal(opts.enabled ?? true).asReadonly(),
        linkPreviewsInEncrypted: signal(
          opts.encryptedEnabled ?? false,
        ).asReadonly(),
      }),
      { provide: AVATAR_RESOLVER, useValue: resolver },
    ],
  });
  return { cmp: fixture.componentInstance, container, previewFn, resolver };
}

describe('LinkPreviewComponent', () => {
  it('renders the preview card (title, host, description) when one resolves', async () => {
    const { container } = await build();
    const card = container.querySelector('[data-testid=link-preview]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('href')).toBe('https://example.com');
    expect(container.textContent).toContain('Example');
    expect(container.textContent).toContain('example.com'); // host line
    expect(container.textContent).toContain('A description');
  });

  it('renders nothing when link previews are turned off (no fetch)', async () => {
    const { container, previewFn } = await build({ enabled: false });
    expect(container.querySelector('[data-testid=link-preview]')).toBeNull();
    expect(previewFn).not.toHaveBeenCalled();
  });

  it('renders nothing when there is no preview to show', async () => {
    const { container } = await build({ result: null });
    expect(container.querySelector('[data-testid=link-preview]')).toBeNull();
  });

  it('does not fetch for an encrypted message without the encrypted-rooms opt-in', async () => {
    const { container, previewFn } = await build({
      encrypted: true,
      encryptedEnabled: false,
    });
    expect(previewFn).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid=link-preview]')).toBeNull();
  });

  it('fetches for an encrypted message once the encrypted-rooms opt-in is on', async () => {
    const { container, previewFn } = await build({
      encrypted: true,
      encryptedEnabled: true,
    });
    expect(previewFn).toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid=link-preview]'),
    ).not.toBeNull();
  });

  it('resolves the preview image via the avatar/media resolver', async () => {
    const { cmp, resolver } = await build({
      result: preview({ imageMxc: 'mxc://hs/img' }),
      resolveImage: 'blob:image',
    });
    expect(resolver).toHaveBeenCalledWith('mxc://hs/img', expect.any(Number));
    expect(cmp.imageUrl()).toBe('blob:image');
  });
});
