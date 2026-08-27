import { Routes } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { AdvancedSettingsComponent } from './advanced/advanced-settings.component';
import { ServerSectionComponent } from './server/server-section.component';
import { SettingsPage } from './settings/settings.page';
import { settingsRoutes } from './settings.routes';
import { ImagePacksSectionComponent } from './image-packs/image-packs-section.component';

/**
 * The section routes, read straight off the table. This is deliberately a structural
 * assertion rather than a navigation: every one of these components pulls a data-access
 * service (and through it matrix-js-sdk) into the run, and the settings shell resolves the
 * submenu against the router — the question worth pinning here is only whether the child
 * path exists and points at the component the submenu links to. Navigation through this
 * table is covered by the settings E2E journey.
 */
const children: Routes = settingsRoutes[0].children ?? [];

function componentFor(path: string): unknown {
  return children.find((route) => route.path === path)?.component;
}

describe('settings routes', () => {
  it('hosts every section inside the settings shell', () => {
    expect(settingsRoutes).toHaveLength(1);
    expect(settingsRoutes[0]).toMatchObject({
      path: '',
      component: SettingsPage,
    });
    expect(children.length).toBeGreaterThan(0);
  });

  // The submenu links to /settings/advanced; without this child the shell renders an empty
  // outlet and the section is unreachable, which no other spec in the workspace would notice.
  it('resolves advanced to the advanced settings section', () => {
    expect(componentFor('advanced')).toBe(AdvancedSettingsComponent);
  });

  // Same reasoning as `advanced` above: the submenu links to /settings/server, and without
  // this child the link lands on an empty outlet with every other spec still green.
  it('resolves server to the server settings section', () => {
    expect(componentFor('server')).toBe(ServerSectionComponent);
  });

  it('resolves stickers to the image-pack manager', () => {
    expect(componentFor('stickers')).toBe(ImagePacksSectionComponent);
  });

  it('gives every section a path and a component', () => {
    const incomplete = children.filter(
      (route) => !route.path || !route.component,
    );

    expect(incomplete).toEqual([]);
  });

  it('declares each section path exactly once', () => {
    const paths = children.map((route) => route.path);

    expect(new Set(paths).size).toBe(paths.length);
  });
});
