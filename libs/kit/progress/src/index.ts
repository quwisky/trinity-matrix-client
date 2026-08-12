import { TrnProgress } from './lib/trn-progress';
import { TrnProgressIndicator } from './lib/trn-progress-indicator';

export * from './lib/trn-progress';
export * from './lib/trn-progress-indicator';

export const TrnProgressImports = [TrnProgress, TrnProgressIndicator] as const;
