import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockProvider } from 'ng-mocks';
import { GifService } from '@trinity/data-access/gif';
import { GifThumbComponent } from './gif-thumb.component';

describe('GifThumbComponent', () => {
  beforeEach(() => {
    // jsdom has no object-URL API; the thumb revokes its blob URL on teardown.
    URL.revokeObjectURL = vi.fn();
  });

  function setup(fetchPreview = vi.fn(() => of('blob:1'))) {
    TestBed.configureTestingModule({
      imports: [GifThumbComponent],
      providers: [MockProvider(GifService, { fetchPreview })],
    });
    const fixture = TestBed.createComponent(GifThumbComponent);
    fixture.componentRef.setInput('url', 'https://x/tiny');
    fixture.componentRef.setInput('alt', 'a cat');
    fixture.detectChanges();
    return fixture;
  }

  it('fetches the preview and binds it as the img src', () => {
    const fixture = setup();
    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('blob:1');
    expect(img.getAttribute('alt')).toBe('a cat');
  });

  it('renders no img when the preview fails to load', () => {
    const fixture = setup(vi.fn(() => throwError(() => new Error('boom'))));
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
  });

  it('revokes the object URL on destroy', () => {
    const fixture = setup();
    fixture.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
  });
});
