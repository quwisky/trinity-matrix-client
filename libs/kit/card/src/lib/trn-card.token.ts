import { inject, InjectionToken, type ValueProvider } from '@angular/core';

export type TrnCardConfig = {
	size: 'sm' | 'default';
};

const defaultConfig: TrnCardConfig = {
	size: 'default',
};

const TrnCardConfigToken = new InjectionToken<TrnCardConfig>('TrnCardConfig');

export function provideTrnCardConfig(config: Partial<TrnCardConfig>): ValueProvider {
	return { provide: TrnCardConfigToken, useValue: { ...defaultConfig, ...config } };
}

export function injectTrnCardConfig(): TrnCardConfig {
	return inject(TrnCardConfigToken, { optional: true }) ?? defaultConfig;
}
