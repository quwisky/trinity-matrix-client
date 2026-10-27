import { InjectionToken } from '@angular/core';
import type { TimelineEngine } from './timeline-engine';

export const TIMELINE_ENGINE = new InjectionToken<TimelineEngine>(
  'TIMELINE_ENGINE',
  {
    providedIn: 'root',
    factory: () => {
      throw new Error('TimelineEngine has no adapter yet');
    },
  },
);
