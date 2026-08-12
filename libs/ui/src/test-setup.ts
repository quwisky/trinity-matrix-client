import '../../../test-setup.base';
import { TestBed } from '@angular/core/testing';
import { provideTrnIcons } from '@trinity/kit/icon';
import { beforeEach } from 'vitest';

// Icons are registered once at the app root in `main.ts`, not per component, so a spec that
// renders one resolves nothing unless the TestBed mirrors that. It is not a silent gap: a
// full run emitted 6,000 "No icon named …" warnings, which both drowned genuine stderr and
// meant any assertion on a rendered icon would have passed against an empty element. Doing
// it here rather than in each spec keeps the test environment faithful to the running app.
beforeEach(() =>
  TestBed.configureTestingModule({ providers: [provideTrnIcons()] }),
);
