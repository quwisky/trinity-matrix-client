export type ForegroundNotificationChannel =
  'default' | 'trinity-notifications-silent';

export function foregroundNotificationChannel(
  silent: boolean,
): ForegroundNotificationChannel {
  return silent ? 'trinity-notifications-silent' : 'default';
}
