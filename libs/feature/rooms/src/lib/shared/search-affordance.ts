import { isMobileOs } from '@trinity/platform-native';

/** The switcher button's label and icon: a phone has no Ctrl/Cmd+K, so it gets a plain search. */
export function searchAffordance(): {
  label: string;
  icon: 'search' | 'command';
} {
  return isMobileOs()
    ? { label: 'Search', icon: 'search' }
    : { label: 'Search (Ctrl/Cmd+K)', icon: 'command' };
}
