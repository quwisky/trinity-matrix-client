import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { ConnectivityBannerComponent } from './connectivity-banner.component';

describe('ConnectivityBannerComponent', () => {
  let connectivity: ReturnType<typeof signal<'online' | 'offline'>>;

  beforeEach(() => {
    connectivity = signal<'online' | 'offline'>('online');
  });

  const renderBanner = () =>
    render(ConnectivityBannerComponent, {
      providers: [MockProvider(MatrixClientService, { connectivity })],
    });

  const banner = (el: HTMLElement) => el.querySelector('trn-banner');

  it('renders nothing while online', async () => {
    const { container } = await renderBanner();

    expect(banner(container)).toBeNull();
  });

  it('shows the offline banner when connectivity drops', async () => {
    const { container, fixture } = await renderBanner();

    connectivity.set('offline');
    fixture.detectChanges();

    const el = banner(container);
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain('offline');
  });

  it('mirrors the offline state in an always-mounted live region', async () => {
    const { container, fixture } = await renderBanner();
    const liveRegion = () => container.querySelector('.sr-only[role="status"]');

    // Persistent and empty while online: a role="status" region must already exist
    // when its text changes to be reliably announced (inserting it with its text via
    // @if is not), so the announcement lives here rather than inside the banner.
    expect(liveRegion()).not.toBeNull();
    expect(liveRegion()?.textContent?.trim()).toBe('');

    connectivity.set('offline');
    fixture.detectChanges();

    expect(liveRegion()?.textContent).toContain('offline');
  });
});
