import { TrnCard } from './lib/trn-card';
import { TrnCardAction } from './lib/trn-card-action';
import { TrnCardContent } from './lib/trn-card-content';
import { TrnCardDescription } from './lib/trn-card-description';
import { TrnCardFooter } from './lib/trn-card-footer';
import { TrnCardHeader } from './lib/trn-card-header';
import { TrnCardTitle } from './lib/trn-card-title';

export * from './lib/trn-card';
export * from './lib/trn-card-action';
export * from './lib/trn-card-content';
export * from './lib/trn-card-description';
export * from './lib/trn-card-footer';
export * from './lib/trn-card-header';
export * from './lib/trn-card-title';

export const TrnCardImports = [
  TrnCard,
  TrnCardAction,
  TrnCardContent,
  TrnCardDescription,
  TrnCardFooter,
  TrnCardHeader,
  TrnCardTitle,
] as const;
