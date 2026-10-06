import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string): string =>
  readFileSync(join(import.meta.dirname, name), 'utf8');

// System status is a framed workspace card (a sheet on a phone), never the full-screen
// settings layer that app, Room and Space settings use. jsdom applies no cascade, so the
// presentation is pinned at its source.
describe('SystemStatusComponent presentation', () => {
  const css = read('system-status.component.scss');
  const html = read('system-status.component.html');

  it('stays a bounded, rounded card centred over a scrim', () => {
    expect(css).toMatch(/place-items:\s*center/u);
    expect(css).toMatch(/inline-size:\s*min\(72rem/u);
    expect(css).toMatch(/block-size:\s*min\(\s*48rem/u);
    expect(css).toMatch(
      /border-radius:\s*var\(--trinity-shape-overlay-radius\)/u,
    );
    expect(html).toContain('system-status__backdrop');
  });

  it('becomes a bottom sheet on a phone', () => {
    expect(css).toMatch(
      /:host\.system-status--mobile\s*\{[^}]*place-items:\s*end center/u,
    );
  });

  it('keeps its own close label and no fullscreen placement', () => {
    expect(html).toContain('closeLabel="Close System status"');
    expect(html).not.toMatch(/fullscreen/u);
  });
});
