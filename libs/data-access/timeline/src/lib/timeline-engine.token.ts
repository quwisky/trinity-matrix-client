import { InjectionToken, inject } from '@angular/core';
import type { TimelineEngine } from './timeline-engine';
import { JsSdkTimelineEngine } from './js-sdk/js-sdk-timeline-engine';

export const TIMELINE_ENGINE = new InjectionToken<TimelineEngine>(
  'TIMELINE_ENGINE',
  { providedIn: 'root', factory: () => inject(JsSdkTimelineEngine) },
);
