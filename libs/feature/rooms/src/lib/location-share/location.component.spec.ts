import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { LocationComponent } from './location.component';

describe('LocationComponent', () => {
  it('renders the label, coordinates, and an OpenStreetMap link', async () => {
    const { container } = await render(LocationComponent, {
      inputs: { location: { lat: 52.51, lng: 13.38, label: 'Berlin' } },
    });

    const card = container.querySelector('[data-testid=location-card]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Berlin');
    expect(card?.textContent).toContain('52.51000, 13.38000');
    expect(card?.getAttribute('href')).toContain(
      'openstreetmap.org/?mlat=52.51&mlon=13.38',
    );
  });
});
