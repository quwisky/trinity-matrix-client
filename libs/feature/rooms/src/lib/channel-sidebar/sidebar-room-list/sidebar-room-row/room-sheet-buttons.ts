import type { ActionSheetButton } from '@trinity/components/overlay';
import type { RoomNotifyMode } from '@trinity/data-access/notifications';
import type { RoomSummary } from '@trinity/data-access/room-library';
import type { SidebarRoomAction } from './sidebar-room-row.component';

export interface RoomSheetContext {
  readonly room: RoomSummary;
  readonly active: boolean;
  readonly mode: RoomNotifyMode | 'mixed';
  readonly canReport: boolean;
  readonly spaceActive: boolean;
  readonly canCurate: boolean;
  readonly curateReason: string | null;
  readonly emit: (action: SidebarRoomAction) => void;
}

const NOTIFY_CHOICES = [
  ['all', 'Notify for all messages', 'bell'],
  ['mentions', 'Mute except mentions & keywords', 'bell-off'],
  ['mute', 'Mute everything', 'bell-off'],
] as const;

/** The kebab menu's actions as sheet rows; the Notifications submenu is flattened, minus the mode already set. */
export function roomSheetButtons(c: RoomSheetContext): ActionSheetButton[] {
  const { room, emit } = c;
  const act =
    (kind: Extract<SidebarRoomAction, { room: unknown }>['kind']) => () =>
      emit({ kind, room } as SidebarRoomAction);
  const buttons: ActionSheetButton[] = [
    {
      text: room.favourite ? 'Unfavourite' : 'Favourite',
      icon: 'star',
      testId: 'sheet-room-favourite',
      handler: act('favourite'),
    },
    {
      text: room.lowPriority ? 'Restore to list' : 'Low priority',
      icon: 'arrow-down-wide-narrow',
      testId: 'sheet-room-low-priority',
      handler: act('low-priority'),
    },
  ];
  if (room.hasUnread) {
    buttons.push({
      text: 'Mark as read',
      icon: 'check-check',
      testId: 'sheet-room-mark-read',
      handler: act('mark-read'),
    });
  } else if (!c.active) {
    buttons.push({
      text: 'Mark as unread',
      icon: 'mail-open',
      testId: 'sheet-room-mark-unread',
      handler: act('mark-unread'),
    });
  }
  for (const [mode, text, icon] of NOTIFY_CHOICES) {
    if (mode === c.mode) continue;
    buttons.push({
      text,
      icon,
      testId: `sheet-room-notify-${mode}`,
      handler: () => emit({ kind: 'notify', room, mode }),
    });
  }
  if (c.spaceActive) {
    buttons.push({
      text: 'Remove from space',
      icon: 'circle-minus',
      variant: 'danger',
      disabled: !c.canCurate,
      separatorBefore: true,
      testId: 'sheet-room-remove',
      handler: act('remove'),
    });
  }
  if (c.canReport) {
    buttons.push({
      text: 'Report room',
      icon: 'flag',
      testId: 'sheet-room-report',
      handler: act('report'),
    });
  }
  buttons.push(
    {
      text: 'Leave room',
      icon: 'log-out',
      variant: 'danger',
      testId: 'sheet-room-leave',
      handler: act('leave'),
    },
    { text: 'Cancel', role: 'cancel' },
  );
  return buttons;
}
