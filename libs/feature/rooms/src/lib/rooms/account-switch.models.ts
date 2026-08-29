export type AccountSwitchDestination =
  | { readonly kind: 'home' }
  | {
      readonly kind: 'room';
      readonly roomId: string;
      readonly source: 'user' | 'hop';
    }
  | { readonly kind: 'space'; readonly spaceId: string | null };
