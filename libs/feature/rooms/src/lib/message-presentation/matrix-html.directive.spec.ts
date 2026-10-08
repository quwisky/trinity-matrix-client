import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MediaService } from '@trinity/data-access/media';
import { sanitizeMatrixHtml } from '@trinity/util/matrix';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      '<img class="mx-emoticon" data-mx-emoticon src="mxc://hs/wave" alt=":wave:">',
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
});
