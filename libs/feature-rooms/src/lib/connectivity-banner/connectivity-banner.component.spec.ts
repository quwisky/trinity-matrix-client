import { signal } from '@angular/core';
import { render } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { MatrixClientService } from '@trinity/core';
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
});
