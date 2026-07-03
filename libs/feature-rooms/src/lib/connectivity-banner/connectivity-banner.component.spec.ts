import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { MatrixClientService } from '@trinity/core';
import { ConnectivityBannerComponent } from './connectivity-banner.component';

describe('ConnectivityBannerComponent', () => {
  let connectivity: ReturnType<typeof signal<'online' | 'offline'>>;

  beforeEach(() => {
    connectivity = signal<'online' | 'offline'>('online');
    TestBed.configureTestingModule({
      imports: [ConnectivityBannerComponent],
      providers: [
        {
          provide: MatrixClientService,
          useValue: { connectivity } as unknown as MatrixClientService,
        },
      ],
    });
  });

  const banner = (el: HTMLElement) => el.querySelector('trn-banner');

  it('renders nothing while online', () => {
    const fixture = TestBed.createComponent(ConnectivityBannerComponent);
    fixture.detectChanges();

    expect(banner(fixture.nativeElement)).toBeNull();
  });

  it('shows the offline banner when connectivity drops', () => {
    const fixture = TestBed.createComponent(ConnectivityBannerComponent);
    fixture.detectChanges();

    connectivity.set('offline');
    fixture.detectChanges();

    const el = banner(fixture.nativeElement);
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain('offline');
  });
});
