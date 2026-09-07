package eu.qwky.trinity;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.RemoteMessage;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONException;

/** Validates and presents the string-only gateway contract at the Android boundary. */
final class TrinityPushDelivery {
    static final String STORAGE = "CapacitorStorage";
    static final String ACCOUNTS_KEY = "matrix.accounts";
    static final String GATEWAY_KEY = "trinity.push.gateway";
    static final String DEDUPE_KEY = "trinity.push.delivery";
    private static final String CHANNEL = "messages";
    private static final Object LOCK = new Object();
    private static final int MAX_CLAIMS = 500;

    private TrinityPushDelivery() {}

    static void handle(Context context, Map<String, String> input) {
        handle(context, input, null);
    }

    static void handle(Context context, RemoteMessage message) {
        handle(context, message.getData(), message);
    }

    private static void handle(Context context, Map<String, String> input, RemoteMessage original) {
        Payload payload = Payload.parse(input);
        if (payload == null) return;
        synchronized (LOCK) {
            Registry registry = Registry.read(context);
            if (registry == null || registry.routes.contains(payload.route) == false) return;
            if (disabled(context)) return;
            if (payload.kind == Kind.COUNTS) return;
            if (MainActivity.isResumed() && TrinityPushDeliveryPlugin.ready()
                    && PushNotificationsPlugin.getPushNotificationsInstance() != null) {
                PushNotificationsPlugin.sendRemoteMessage(original == null ? payload.remoteMessage : original);
                return;
            }
            if (!canPresent(context)) return;
            if (claimOutcome(context, registry.routes, payload.route, payload.eventId) != ClaimOutcome.CLAIMED) return;
            present(context, payload);
        }
    }

    static boolean claim(Context context, String route, String event) {
        synchronized (LOCK) {
            Registry registry = Registry.read(context);
            return claimOutcome(context, route, event) == ClaimOutcome.CLAIMED;
        }
    }

    static ClaimOutcome claimOutcome(Context context, String route, String event) {
        return claimOutcome(context, route, event, "messages");
    }

    static ClaimOutcome claimOutcome(Context context, String route, String event, String channelId) {
        synchronized (LOCK) {
            if (!canClaim(context, channelId)) return ClaimOutcome.ERROR;
            Registry registry = Registry.read(context);
            if (registry == null || !registry.routes.contains(route) || event == null || event.isEmpty() || disabled(context)) return ClaimOutcome.ERROR;
            return claimOutcome(context, registry.routes, route, event);
        }
    }

    static void refresh(Context context) {
        synchronized (LOCK) {
            Registry registry = Registry.read(context);
            if (registry == null || disabled(context)) {
                cancelOwned(context, null);
                return;
            }
            NotificationManagerCompat notifications = NotificationManagerCompat.from(context);
            for (StatusBarNotification notification : notifications.getActiveNotifications()) {
                String tag = notification.getTag();
                if (tag != null && tag.startsWith("trinity.push.") && !registry.routeHashes.contains(tagRouteHash(tag))) notifications.cancel(tag, notification.getId());
            }
            SharedPreferences prefs = context.getSharedPreferences(STORAGE, Context.MODE_PRIVATE);
            String raw = prefs.getString(DEDUPE_KEY, null);
            if (raw == null) return;
            try {
                JSONArray source = new JSONArray(raw), kept = new JSONArray();
                for (int i = 0; i < source.length(); i++) {
                    JSONObject item = source.getJSONObject(i);
                    if (registry.routeHashes.contains(item.getString("route"))) kept.put(item);
                }
                prefs.edit().putString(DEDUPE_KEY, kept.toString()).commit();
            } catch (JSONException ignored) { }
        }
    }

    private static void cancelOwned(Context context, Set<String> routeHashes) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        for (StatusBarNotification notification : manager.getActiveNotifications()) {
            String tag = notification.getTag();
            if (tag != null && tag.startsWith("trinity.push.") && (routeHashes == null || !routeHashes.contains(tagRouteHash(tag)))) {
                manager.cancel(tag, notification.getId());
            }
        }
    }

    private static String tagRouteHash(String tag) {
        String value = tag.substring("trinity.push.".length());
        int separator = value.indexOf('.');
        return separator < 0 ? value : value.substring(0, separator);
    }

    private static boolean disabled(Context context) {
        String value = context.getSharedPreferences(STORAGE, Context.MODE_PRIVATE).getString(GATEWAY_KEY, null);
        if (value == null) return false;
        try { return new JSONObject(value).optBoolean("disabled", false); }
        catch (JSONException ignored) { return true; }
    }

    private static ClaimOutcome claimOutcome(Context context, Set<String> routes, String route, String event) {
        SharedPreferences prefs = context.getSharedPreferences(STORAGE, Context.MODE_PRIVATE);
        String raw = prefs.getString(DEDUPE_KEY, null);
        JSONArray old;
        if (raw == null) old = new JSONArray();
        else try { old = new JSONArray(raw); } catch (JSONException ignored) { return ClaimOutcome.ERROR; }
        String routeHash = digest(route);
        Set<String> routeHashes = new HashSet<>();
        for (String knownRoute : routes) routeHashes.add(digest(knownRoute));
        String identity = digest(route + "\u0000" + event);
        JSONArray next = new JSONArray();
        boolean duplicate = false;
        for (int i = 0; i < old.length(); i++) {
            Object value = old.opt(i);
            if (!(value instanceof JSONObject)) return ClaimOutcome.ERROR;
            JSONObject claim = (JSONObject) value;
            String claimRoute = claim.optString("route", null);
            String claimId = claim.optString("id", null);
            if (claimRoute == null || claimId == null || !hexDigest(claimRoute) || !hexDigest(claimId)) return ClaimOutcome.ERROR;
            if (!routeHashes.contains(claimRoute)) continue;
            if (identity.equals(claimId)) duplicate = true;
            next.put(claim);
        }
        if (duplicate) return ClaimOutcome.DUPLICATE;
        try { next.put(new JSONObject().put("route", routeHash).put("id", identity)); }
        catch (JSONException ignored) { return ClaimOutcome.ERROR; }
        while (next.length() > MAX_CLAIMS) {
            JSONArray trimmed = new JSONArray();
            for (int i = 1; i < next.length(); i++) trimmed.put(next.opt(i));
            next = trimmed;
        }
        return prefs.edit().putString(DEDUPE_KEY, next.toString()).commit() ? ClaimOutcome.CLAIMED : ClaimOutcome.ERROR;
    }

    private static void present(Context context, Payload payload) {
        if (!canPresent(context)) return;
        String identity = digest(payload.route + "\u0000" + payload.eventId);
        String tag = "trinity.push." + digest(payload.route) + "." + identity;
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return;
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nativeManager = context.getSystemService(NotificationManager.class);
            if (nativeManager == null) return;
            NotificationChannel channel = nativeManager.getNotificationChannel(CHANNEL);
            if (channel == null) {
                nativeManager.createNotificationChannel(new NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH));
            } else if (channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return;
        }
        Intent intent = new Intent(context, MainActivity.class).setAction("trinity.push.open");
        intent.setData(android.net.Uri.parse("trinity://push/" + identity));
        payload.putExtras(intent);
        int requestCode = 0;
        PendingIntent click = PendingIntent.getActivity(context, requestCode, intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(context.getApplicationInfo().icon)
                .setContentTitle("Trinity")
                .setContentText("New message")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true).setContentIntent(click);
        manager.notify(tag, requestCode, builder.build());
    }

    private static boolean canClaim(Context context) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return false;
        return NotificationManagerCompat.from(context).areNotificationsEnabled();
    }

    private static boolean canClaim(Context context, String channelId) {
        if (!canClaim(context)) return false;
        if (Build.VERSION.SDK_INT < 26 || channelId == null || channelId.isEmpty()) return true;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = manager == null ? null : manager.getNotificationChannel(channelId);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    private static boolean canPresent(Context context) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nativeManager = context.getSystemService(NotificationManager.class);
            if (nativeManager == null) return false;
            NotificationChannel channel = nativeManager.getNotificationChannel(CHANNEL);
            if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        }
        return true;
    }

    private static boolean hexDigest(String value) { return value != null && value.matches("[a-f0-9]{64}"); }
    private static String digest(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder();
            for (byte b : bytes) result.append(String.format("%02x", b));
            return result.toString();
        } catch (Exception ignored) { return ""; }
    }

    enum Kind { EVENT, COUNTS }
    static final class Payload {
        final Kind kind; final String route; final String eventId; final String messageId; final Map<String,String> data; final RemoteMessage remoteMessage;
        private Payload(Kind kind, String route, String eventId, String messageId, Map<String,String> data) {
            this.kind=kind; this.route=route; this.eventId=eventId; this.messageId=messageId; this.data=data;
            this.remoteMessage = new RemoteMessage.Builder("trinity").setMessageId(messageId).setData(data).build();
        }
        void putExtras(Intent intent) {
            intent.putExtra("google.message_id", messageId);
            intent.putExtra("schema", "1"); intent.putExtra("kind", kind == Kind.EVENT ? "event" : "counts");
            intent.putExtra("trinity_account_id", route); intent.putExtra("unread", data.get("unread"));
            intent.putExtra("missed_calls", data.get("missed_calls")); intent.putExtra("sound", data.get("sound"));
            if (data.containsKey("highlight")) intent.putExtra("highlight", data.get("highlight"));
            if (kind == Kind.EVENT) { intent.putExtra("event_id", eventId); intent.putExtra("room_id", data.get("room_id")); }
        }
        static Payload parse(Map<String,String> d) {
            if (d == null || !"1".equals(d.get("schema"))) return null;
            String kind=d.get("kind"), route=d.get("trinity_account_id"), unread=d.get("unread"), missed=d.get("missed_calls"), sound=d.get("sound");
            if ((kind == null) || (!kind.equals("event") && !kind.equals("counts")) || !validRoute(route) || !decimal(unread) || !decimal(missed) || !("true".equals(sound)||"false".equals(sound))) return null;
            String highlight=d.get("highlight"); if (highlight != null && !(highlight.equals("true")||highlight.equals("false"))) return null;
            String event= d.get("event_id"), room=d.get("room_id"), message=d.get("google.message_id");
            if (kind.equals("event") && (empty(event)||empty(room))) return null;
            if (empty(message)) message = kind + ":" + route + ":" + (event == null ? "counts" : event);
            return new Payload(kind.equals("event") ? Kind.EVENT : Kind.COUNTS, route, event, message, new HashMap<>(d));
        }
        static boolean empty(String s) { return s == null || s.isEmpty(); }
        static boolean decimal(String s) {
            if (s == null || !s.matches("(0|[1-9][0-9]*)")) return false;
            try { return Long.parseLong(s) <= 9007199254740991L; }
            catch (NumberFormatException ignored) { return false; }
        }
        static boolean validRoute(String s) { return s != null && s.matches("[A-Za-z0-9_-]{1,48}"); }
    }

    private static final class Registry {
        final Set<String> routes;
        final Set<String> routeHashes;
        private Registry(Set<String> routes) { this.routes=routes; this.routeHashes=new HashSet<>(); for (String route: routes) routeHashes.add(digest(route)); }
        static Registry read(Context c) {
            String raw=c.getSharedPreferences(STORAGE, Context.MODE_PRIVATE).getString(ACCOUNTS_KEY,null);
            if (raw == null) return null;
            try {
                JSONObject root=new JSONObject(raw); JSONArray accounts=root.getJSONArray("accounts"); Map<String,Integer> counts=new HashMap<>();
                for (int i=0;i<accounts.length();i++) { JSONObject account=accounts.getJSONObject(i); String route=account.optString("pushAccountRoute", null); if (Payload.validRoute(route)) counts.put(route, counts.containsKey(route) ? counts.get(route)+1 : 1); }
                Set<String> routes=new HashSet<>(); for (Map.Entry<String,Integer> entry: counts.entrySet()) if (entry.getValue()==1) routes.add(entry.getKey());
                return new Registry(routes);
            } catch (JSONException ignored) { return null; }
        }
    }
    enum ClaimOutcome { CLAIMED, DUPLICATE, ERROR }
}
