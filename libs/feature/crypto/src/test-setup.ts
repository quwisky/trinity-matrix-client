import '../../../../test-setup.base';
import { TestBed } from '@angular/core/testing';
import { provideTrnIcons } from '@trinity/components/foundations';
import { beforeEach } from 'vitest';

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [provideTrnIcons()] });
});
