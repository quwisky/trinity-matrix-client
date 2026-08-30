import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { type LocationView } from '@trinity/data-access/timeline';
import { TrnIconComponent } from '@trinity/components/foundations';

/**
 * A shared-location (`m.location`) card: a pin, the coordinates, and an "Open in maps"
 * link. Deliberately map-tile-free — it links out to OpenStreetMap rather than embedding
 * a map, keeping the strict connect-src CSP intact.
 */
@Component({
  selector: 'trn-location',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent],
  templateUrl: './location.component.html',
  styleUrl: './location.component.scss',
})
export class LocationComponent {
  readonly location = input.required<LocationView>();

  /** Coordinates, fixed to 5 decimals (~1 m), for display. */
  readonly coords = computed(() => {
    const { lat, lng } = this.location();
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  });

  /** An OpenStreetMap link that drops a marker at the point. */
  readonly mapUrl = computed(() => {
    const { lat, lng } = this.location();
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
  });
}
