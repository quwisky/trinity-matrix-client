// @trinity/util/ui: view-layer helpers that are not components. `type:util`, so nothing here may
// need Angular DI: `runWithBusy` and `mediaQuerySignal` TAKE a `DestroyRef` rather than
// injecting one, which also means nothing can throw NG0203.
export * from './lib/delayed-busy';
export * from './lib/with-busy';
export * from './lib/media-query';
export { textScaledViewportSignal } from './lib/text-scaled-viewport';
export * from './lib/reduced-motion';
export * from './lib/internal-url';
export * from './lib/latest-guard';
export * from './lib/routed-page';
export * from './lib/shown-error';
