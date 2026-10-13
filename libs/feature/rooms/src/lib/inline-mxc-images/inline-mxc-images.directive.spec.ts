import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MediaService } from '@trinity/data-access/media';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineMxcImagesDirective } from './inline-mxc-images.directive';

@Component({
  imports: [InlineMxcImagesDirective],
  template: `<div [innerHTML]="html()" [trnInlineMxcImages]="html()"></div>`,
})
class HostComponent {
  readonly html = signal(
    '<img class="mx-emoticon" data-mx-emoticon src="mxc://hs/wave" alt=":wave:">',
  );
}

describe('InlineMxcImagesDirective', () => {
  let fixture: ComponentFixture<HostComponent>;
  let resolved: Subject<string>;
  let sanitizerWarn: ReturnType<typeof vi.spyOn>;
  const media = {
    resolveMedia: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
  };

  beforeEach(async () => {
    sanitizerWarn = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    resolved = new Subject<string>();
    media.resolveMedia.mockReturnValue(resolved);
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [{ provide: MediaService, useValue: media }],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    await Promise.resolve();
  });

  afterEach(() => {
    expect(sanitizerWarn).toHaveBeenCalledWith(
      expect.stringContaining('sanitizing HTML stripped some content'),
    );
    sanitizerWarn.mockRestore();
  });

  it('resolves mxc through MediaService and pins the displayed blob', () => {
    expect(media.resolveMedia).toHaveBeenCalledWith(
      expect.objectContaining({ mxc: 'mxc://hs/wave' }),
      'thumbnail',
    );
    resolved.next('blob:wave');
    const image = fixture.nativeElement.querySelector(
      'img',
    ) as HTMLImageElement;
    expect(image.src).toBe('blob:wave');
    expect(media.pin).toHaveBeenCalledWith('blob:wave');
  });

  it('falls back to alt text when media resolution fails', () => {
    resolved.error(new Error('offline'));
    expect(fixture.nativeElement.textContent).toContain(':wave:');
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
  });

  it('unpins resolved media on teardown', () => {
    resolved.next('blob:wave');
    fixture.destroy();
    expect(media.unpin).toHaveBeenCalledWith('blob:wave');
  });

  it('unpins and falls back when the resolved bytes cannot decode', () => {
    resolved.next('blob:wave');
    const image = fixture.nativeElement.querySelector(
      'img',
    ) as HTMLImageElement;

    image.dispatchEvent(new Event('error'));

    expect(media.unpin).toHaveBeenCalledWith('blob:wave');
    expect(fixture.nativeElement.textContent).toContain(':wave:');
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
  });
});

describe('InlineMxcImagesDirective without custom emoji', () => {
  it('does not parse a body that declares none', async () => {
    const media = { resolveMedia: vi.fn(), pin: vi.fn(), unpin: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [{ provide: MediaService, useValue: media }],
    }).compileComponents();
    const fixture = TestBed.createComponent(HostComponent);
    const body = '<p>plain <b>text</b></p>';
    fixture.componentInstance.html.set(body);
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    try {
      fixture.detectChanges();
      await Promise.resolve();
      // Angular's own sanitizer also parses, but never the bare body.
      expect(parse).not.toHaveBeenCalledWith(body, 'text/html');
      expect(media.resolveMedia).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});

describe('InlineMxcImagesDirective with the same emoji twice', () => {
  it('releases each of its pins, since pins are counted per view', async () => {
    const sanitizerWarn = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const resolved = new Subject<string>();
    const media = {
      resolveMedia: vi.fn(() => resolved),
      pin: vi.fn(),
      unpin: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [{ provide: MediaService, useValue: media }],
    }).compileComponents();
    const fixture = TestBed.createComponent(HostComponent);
    const wave =
      '<img class="mx-emoticon" data-mx-emoticon src="mxc://hs/wave" alt=":wave:">';
    fixture.componentInstance.html.set(`${wave} and ${wave}`);
    fixture.detectChanges();
    await Promise.resolve();
    resolved.next('blob:wave'); // both images share the one cached URL

    // One image fails to decode, then the message goes.
    fixture.nativeElement
      .querySelector('img')
      .dispatchEvent(new Event('error'));
    fixture.destroy();

    const count = (spy: typeof media.pin) =>
      spy.mock.calls.filter(([url]) => url === 'blob:wave').length;
    expect(count(media.pin)).toBe(2);
    expect(count(media.unpin)).toBe(2);
    sanitizerWarn.mockRestore();
  });
});
