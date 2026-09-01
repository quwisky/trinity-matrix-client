import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runtimeVendorImportSpecifiers,
  validateRuntimeVendorStyles,
} from './runtime-vendor-style-contract.mjs';

const catalog = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../architecture/runtime-vendor-styles.json'),
    'utf8',
  ),
);
const copyCatalog = () => structuredClone(catalog);

describe('runtime vendor style contract', () => {
  it('accepts the complete checked-in catalog', () => {
    expect(validateRuntimeVendorStyles(copyCatalog())).toEqual([]);
  });

  it('rejects allowlist growth and a static stylesheet outside vendor', () => {
    const changed = copyCatalog();
    changed.runtimeStyles.push({
      ...changed.runtimeStyles[0],
      id: 'unreviewed-runtime-style',
    });
    changed.staticStyles[0].layer = 'components';

    expect(validateRuntimeVendorStyles(changed)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Runtime vendor runtime allowlist must be exactly',
        ),
        'cdk-overlay-static static stylesheet must enter layer(vendor)',
      ]),
    );
  });

  it('rejects runtime imports that escape their audited source prefixes', () => {
    const changed = copyCatalog();
    const overlay = changed.runtimeStyles.find(
      ({ id }) => id === 'cdk-overlay-loader',
    );
    overlay.allowedSourcePrefixes = [];

    expect(validateRuntimeVendorStyles(changed)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'cdk-overlay-loader runtime vendor import escaped its seam',
        ),
      ]),
    );
  });

  it('ignores commented imports while finding named, side-effect, and dynamic imports', () => {
    expect(
      runtimeVendorImportSpecifiers(`
        // import '@ng-icons/core';
        /* import { Overlay } from '@angular/cdk/overlay'; */
        import '@ctrl/ngx-emoji-mart/picker.css';
        import { NgIcon } from '@ng-icons/core';
        const load = () => import('@spartan-ng/brain/sonner');
      `),
    ).toEqual([
      '@ctrl/ngx-emoji-mart/picker.css',
      '@ng-icons/core',
      '@spartan-ng/brain/sonner',
    ]);
  });
});
