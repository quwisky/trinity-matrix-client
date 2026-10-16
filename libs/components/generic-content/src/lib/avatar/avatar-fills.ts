/** The six themed avatar fills, each with its own AA ink. Spelled out in full so the token guard sees every name. */
export const AVATAR_FILLS = [
  { fill: 'var(--trinity-avatar-1)', ink: 'var(--trinity-avatar-1-ink)' },
  { fill: 'var(--trinity-avatar-2)', ink: 'var(--trinity-avatar-2-ink)' },
  { fill: 'var(--trinity-avatar-3)', ink: 'var(--trinity-avatar-3-ink)' },
  { fill: 'var(--trinity-avatar-4)', ink: 'var(--trinity-avatar-4-ink)' },
  { fill: 'var(--trinity-avatar-5)', ink: 'var(--trinity-avatar-5-ink)' },
  { fill: 'var(--trinity-avatar-6)', ink: 'var(--trinity-avatar-6-ink)' },
] as const;

/** Stable 0-based index into {@link AVATAR_FILLS} from a key, like Discord's default avatars. */
export function hashSlot(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % AVATAR_FILLS.length;
}
