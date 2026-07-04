import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { AvatarComponent } from './avatar.component';
import { AVATAR_RESOLVER } from './avatar-resolver';

// The image-shows-once-loaded / falls-back-on-error swap is BrnAvatar's job (and
// needs a real image load, which jsdom can't do), so these cover the component's
// own contract: the resolved `src`, and the initials fallback that renders while
// there's no image. The rendered image path is verified in the browser (e2e).
describe('AvatarComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [AvatarComponent] }),
  );

  const fallback = (host: HTMLElement) =>
    host.querySelector('[data-slot="avatar-fallback"]');

  it('shows the initials fallback when no image source is given', () => {
    const fixture = TestBed.createComponent(AvatarComponent);
    fixture.componentRef.setInput('initial', 'A');
    fixture.componentRef.setInput('name', 'Alice');
    fixture.detectChanges();

    expect(fixture.componentInstance.src()).toBeNull();
    const fb = fallback(fixture.nativeElement);
    expect(fb).toBeTruthy();
    expect(fb?.textContent?.trim()).toBe('A');
  });

  it('uses the direct url as the image source', () => {
    const fixture = TestBed.createComponent(AvatarComponent);
    fixture.componentRef.setInput('url', 'https://hs.example/avatar.png');
    fixture.detectChanges();

    expect(fixture.componentInstance.src()).toBe(
      'https://hs.example/avatar.png',
    );
  });

  it('resolves an mxc via the resolver and uses the resolved url', () => {
    const resolver = vi.fn(() => of('blob:resolved'));
    TestBed.configureTestingModule({
      providers: [{ provide: AVATAR_RESOLVER, useValue: resolver }],
    });
    const fixture = TestBed.createComponent(AvatarComponent);
    fixture.componentRef.setInput('mxc', 'mxc://hs/a');
    fixture.componentRef.setInput('size', 64);
    fixture.detectChanges();

    expect(resolver).toHaveBeenCalledWith('mxc://hs/a', 64);
    expect(fixture.componentInstance.src()).toBe('blob:resolved');
  });

  it('falls back to initials when the resolver yields null', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: AVATAR_RESOLVER, useValue: () => of(null) }],
    });
    const fixture = TestBed.createComponent(AvatarComponent);
    fixture.componentRef.setInput('mxc', 'mxc://hs/missing');
    fixture.componentRef.setInput('initial', 'C');
    fixture.detectChanges();

    expect(fixture.componentInstance.src()).toBeNull();
    expect(fallback(fixture.nativeElement)?.textContent?.trim()).toBe('C');
  });
});
