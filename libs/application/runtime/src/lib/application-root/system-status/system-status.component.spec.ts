import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string): string =>
  readFileSync(join(import.meta.dirname, name), 'utf8');

// System status is a dialog (a sheet on a phone), never the full-screen settings layer.
// It presents itself outside the dialog service, so it hands the layout its presentation
// and the shared dialog shell draws the surface, header and close. jsdom applies no
// cascade, so the presentation is pinned at its source.
describe('SystemStatusComponent presentation', () => {
  const css = read('system-status.component.scss');
  const html = read('system-status.component.html');
  const ts = read('system-status.component.ts');

  it('is framed by the shared dialog shell, centred over a scrim', () => {
    expect(html).toContain('[presentation]="presentation"');
    expect(html).toContain('system-status__backdrop');
    expect(css).toMatch(/place-items:\s*center/u);
    // The shell draws the card; a second border, radius or shadow would double it.
    const layout = /\n  trn-settings-layout \{([^}]*)\}/u.exec(css)?.[1];
    expect(layout).toBeDefined();
    expect(layout).not.toMatch(
      /border|box-shadow|block-size|(?<!max-)inline-size:/u,
    );
  });

  it('becomes a bottom sheet on a phone', () => {
    expect(ts).toMatch(/\? 'sheet'\s*:\s*'dialog'/u);
    expect(css).toMatch(
      /:host\.system-status--sheet\s*\{[^}]*place-items:\s*end center/u,
    );
  });

  it('keeps its own close label and no fullscreen placement', () => {
    expect(html).toContain('closeLabel="Close System status"');
    expect(html).not.toMatch(/fullscreen/u);
  });
});
