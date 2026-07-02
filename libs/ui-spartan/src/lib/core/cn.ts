import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The spartan/helm class-merge helper: compose conditional class lists with
 * `clsx`, then let `tailwind-merge` resolve conflicting Tailwind utilities so a
 * caller-supplied `class` wins over the component's defaults (e.g. `px-6`
 * overrides a built-in `px-4`). Every helm primitive routes its host `class`
 * through this so consumers can override styling without `!important`.
 */
export function hlm(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
