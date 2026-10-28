import { InjectionToken, inject } from '@angular/core';
import type { ExpressionEngine } from './expression-engine';
import { JsSdkExpressionEngine } from './js-sdk/js-sdk-expression-engine';

export const EXPRESSION_ENGINE = new InjectionToken<ExpressionEngine>(
  'EXPRESSION_ENGINE',
  { providedIn: 'root', factory: () => inject(JsSdkExpressionEngine) },
);
