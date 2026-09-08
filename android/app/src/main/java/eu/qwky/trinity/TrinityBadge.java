package eu.qwky.trinity;

import android.content.Context;
import android.content.SharedPreferences;
import me.leolin.shortcutbadger.ShortcutBadger;

/** Owns Trinity's aggregate unread badge while preserving the vendor storage contract. */
final class TrinityBadge {
    static final Object LOCK = new Object();
    private static final String PREFS = "capacitor.badge";
    private static final String KEY = "capacitor.badge";
    private static final int MAX = 9999;

    private TrinityBadge() {}

    static boolean supported(Context context) {
        synchronized (LOCK) {
            try {
                boolean supported = ShortcutBadger.isBadgeCounterSupported(context);
                if (!supported) return false;
                if (!ShortcutBadger.applyCount(context, stored(context))) {
                    throw new IllegalStateException("Badge support is unavailable");
                }
                return true;
            } catch (RuntimeException error) {
                if (error instanceof IllegalStateException) throw error;
                throw new IllegalStateException("Badge support is unavailable", error);
            }
        }
    }

    static void restore(Context context) {
        synchronized (LOCK) {
            int count = stored(context);
            try { if (ShortcutBadger.isBadgeCounterSupported(context)) ShortcutBadger.applyCount(context, count); }
            catch (RuntimeException ignored) { }
        }
    }

    static boolean set(Context context, int count) {
        synchronized (LOCK) {
            int normalized = Math.max(0, Math.min(MAX, count));
            if (!preferences(context).edit().putInt(KEY, normalized).commit()) return false;
            try {
                if (ShortcutBadger.isBadgeCounterSupported(context)
                        && !ShortcutBadger.applyCount(context, normalized)) return false;
            }
            catch (RuntimeException ignored) { return false; }
            return true;
        }
    }

    static int get(Context context) { synchronized (LOCK) { return stored(context); } }

    private static int stored(Context context) {
        return Math.max(0, Math.min(MAX, preferences(context).getInt(KEY, 0)));
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
