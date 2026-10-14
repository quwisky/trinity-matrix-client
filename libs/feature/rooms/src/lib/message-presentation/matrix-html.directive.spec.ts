import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  MediaPipeline,
  MediaService,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { sanitizeMatrixHtml } from '@trinity/util/matrix';
import { Subject, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineMxcImagesDirective } from '../inline-mxc-images/inline-mxc-images.directive';
import {
  MediaViewerLauncher,
  type MediaViewerOutcome,
} from '../media-attachment/media-viewer-launcher';
import { type MatrixLinkClick } from '../matrix-link/matrix-link.directive';
import { MatrixHtmlDirective } from './matrix-html.directive';

@Component({
  imports: [MatrixHtmlDirective],
  template: `<div
    class="body"
    [trnMatrixHtml]="html()"
    (matrixLink)="followed.push($event)"
  ></div>`,
})
class HostComponent {
  readonly html = signal('');
  readonly followed: MatrixLinkClick[] = [];
}

describe('MatrixHtmlDirective', () => {
  const resolved = new Subject<string>();
  const media = { resolveMedia: vi.fn(), pin: vi.fn(), unpin: vi.fn() };

  beforeEach(() => {
    media.resolveMedia.mockReset().mockReturnValue(resolved);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [{ provide: MediaService, useValue: media }],
    });
  });

  function render(html: string) {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.html.set(html);
    fixture.detectChanges();
    const host = fixture.nativeElement.querySelector('.body') as HTMLElement;
    return { fixture, host, component: fixture.componentInstance };
  }

  it('renders the message HTML into its host', () => {
    const { host } = render('<p>hello <strong>there</strong></p>');

    expect(host.querySelector('strong')?.textContent).toBe('there');
  });

  it('uncovers a spoiler on its first click', () => {
    const { host } = render('<span class="mx-spoiler">secret</span>');
    const spoiler = host.querySelector<HTMLElement>('.mx-spoiler')!;

    spoiler.click();

    expect(spoiler.classList.contains('is-revealed')).toBe(true);
  });

  it('hands a matrix.to link to the host instead of following it', () => {
    const { host, component } = render(
      '<a href="https://matrix.to/#/!room:hs">room</a>',
    );

    host.querySelector('a')!.click();

    expect(component.followed).toHaveLength(1);
    expect(component.followed[0].target).toMatchObject({ kind: 'room' });
  });

  it('opens an external link in a new tab', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { host, component } = render('<a href="https://example.org/x">x</a>');

    host.querySelector('a')!.click();

    expect(open).toHaveBeenCalledWith(
      'https://example.org/x',
      '_blank',
      'noopener,noreferrer',
    );
    expect(component.followed).toEqual([]);
  });

  it('resolves inline custom emoji through the media service', async () => {
    render(
      sanitizeMatrixHtml(
        '<img data-mx-emoticon src="mxc://hs/wave" alt=":wave:">',
      ),
    );
    await Promise.resolve();

    expect(media.resolveMedia).toHaveBeenCalledWith(
      expect.objectContaining({ mxc: 'mxc://hs/wave' }),
      'thumbnail',
    );
  });

  it('highlights a fenced code block once the grammars load', async () => {
    const source = 'const a = 1;\nconst b = "x";\n';
    const { fixture, host } = render(
      sanitizeMatrixHtml(
        `<pre><code class="language-typescript">${source}</code></pre>`,
      ),
    );

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelectorAll('[class^="tok-"]').length).toBeGreaterThan(
        0,
      );
    });
    expect(host.textContent).toBe(source);
  });

  it('keeps the new-tab attributes through Angular’s sanitizer', () => {
    const { host } = render(
      sanitizeMatrixHtml('<a href="https://example.org/x">x</a>'),
    );
    const link = host.querySelector('a')!;

    // Angular re-sanitizes [innerHTML] against its own allowlist. If an upgrade drops
    // `target` or `rel`, middle-click opens would lose `noopener` silently; fail here.
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('keeps the colour tokens through Angular’s sanitizer', () => {
    const { host } = render(
      sanitizeMatrixHtml('<span data-mx-color="#e03030">r</span>'),
    );

    expect(host.querySelector('.mx-fg-e03030')).not.toBeNull();
  });

  it('keeps the spoiler reason through Angular’s sanitizer and drops the name on reveal', () => {
    const { host } = render(
      sanitizeMatrixHtml('<span data-mx-spoiler="ending">she lives</span>'),
    );
    const spoiler = host.querySelector<HTMLElement>('.mx-spoiler')!;

    // Angular keeps `label` today; an upgrade that drops it must fail here, not silently.
    expect(spoiler.getAttribute('label')).toBe('ending');
    expect(spoiler.getAttribute('aria-label')).toBe(
      'Spoiler: ending, activate to reveal',
    );

    spoiler.click();

    expect(spoiler.hasAttribute('aria-label')).toBe(false);
    expect(spoiler.hasAttribute('role')).toBe(false);
    expect(spoiler.hasAttribute('tabindex')).toBe(false);
  });

  it.each(['Enter', ' '])(
    'keeps focus on a spoiler revealed with %j until focus leaves it',
    (key) => {
      const { host } = render(
        sanitizeMatrixHtml('<span data-mx-spoiler>x</span>'),
      );
      const spoiler = host.querySelector<HTMLElement>('.mx-spoiler')!;
      spoiler.focus();

      spoiler.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      );

      expect(spoiler.classList.contains('is-revealed')).toBe(true);
      expect(document.activeElement).toBe(spoiler);
      expect(spoiler.hasAttribute('tabindex')).toBe(true);
      expect(spoiler.hasAttribute('role')).toBe(false);

      spoiler.blur();

      expect(spoiler.hasAttribute('tabindex')).toBe(false);
    },
  );

  it('reveals a concealed spoiler before opening an image inside it', async () => {
    const open = vi.fn(() => of<MediaViewerOutcome>('opened'));
    TestBed.overrideDirective(InlineMxcImagesDirective, {
      set: {
        providers: [
          { provide: MediaViewerLauncher, useValue: { open, close: vi.fn() } },
        ],
      },
    });
    TestBed.overrideProvider(MediaPipeline, {
      useValue: {
        present: () =>
          ({ id: 'presented' }) as unknown as PresentedMediaReference,
      },
    });
    const { host } = render(
      sanitizeMatrixHtml(
        '<span data-mx-spoiler><img src="mxc://hs/pic" alt="pic"></span>',
      ),
    );
    await Promise.resolve();
    const image = host.querySelector('img')!;

    image.click();

    expect(
      host.querySelector('.mx-spoiler')?.classList.contains('is-revealed'),
    ).toBe(true);
    expect(open).not.toHaveBeenCalled();

    image.click();

    expect(open).toHaveBeenCalledTimes(1);
  });
});
