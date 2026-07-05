/**
 * Format an unread count for a pill/row badge, Discord-style: exact up to 99,
 * then capped as "99+". Shared by the server rail and the channel sidebar.
 */
export function unreadBadgeLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
}
