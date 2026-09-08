package eu.qwky.trinity;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.core.app.NotificationCompat;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.InputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.Assume;

/** Exercises the installed Android delivery boundary with the shared payload fixtures. */
@RunWith(AndroidJUnit4.class)
public final class TrinityPushDeliveryInstrumentedTest {
    private static final String ROUTE_A = "route_a";
    private static final String ROUTE_B = "route_b";
    private static final String CHANNEL = "messages";

    private Context context;
    private NotificationManager notifications;
    private String savedAccounts;
    private String savedGateway;
    private String savedLedger;

    @Before
    public void setUp() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        notifications = context.getSystemService(NotificationManager.class);
        android.content.SharedPreferences prefs = context.getSharedPreferences(TrinityPushDelivery.STORAGE, Context.MODE_PRIVATE);
        savedAccounts = prefs.getString(TrinityPushDelivery.ACCOUNTS_KEY, null);
        savedGateway = prefs.getString(TrinityPushDelivery.GATEWAY_KEY, null);
        savedLedger = prefs.getString(TrinityPushDelivery.DEDUPE_KEY, null);
        if (!InstrumentationRegistry.getArguments().containsKey("route")) clearState();
        if (!"true".equals(InstrumentationRegistry.getArguments().getString("permissionDenied"))) grantNotifications();
    }

    @After
    public void tearDown() {
        notifications.cancelAll();
        assertNotificationCount(0);
        context.getSharedPreferences(TrinityPushDelivery.STORAGE, Context.MODE_PRIVATE).edit()
                .putString(TrinityPushDelivery.ACCOUNTS_KEY, savedAccounts)
                .putString(TrinityPushDelivery.GATEWAY_KEY, savedGateway)
                .putString(TrinityPushDelivery.DEDUPE_KEY, savedLedger).commit();
    }

    @Test
    public void sharedFixturesDecodeLikeTheSharedClient() throws Exception {
        JSONArray fixtures = readFixtures();
        for (int i = 0; i < fixtures.length(); i++) {
            JSONObject fixture = fixtures.getJSONObject(i);
            Map<String, String> data = stringMap(fixture.optJSONObject("data"));
            JSONObject expected = fixture.optJSONObject("expected");
            TrinityPushDelivery.Payload parsed = TrinityPushDelivery.Payload.parse(data);
            if (expected == null) assertEquals(fixture.getString("name"), null, parsed);
            else {
                assertNotNull(parsed);
                JSONObject summary = fixture.optJSONObject("expectedSummary");
                assertNotNull("valid fixture must define summary", summary);
                assertEquals(expected.optString("kind"), parsed.kind == TrinityPushDelivery.Kind.EVENT ? "event" : "counts");
                assertEquals(expected.optString("accountRoute"), parsed.route);
                if (parsed.kind == TrinityPushDelivery.Kind.EVENT) {
                    assertEquals(expected.optString("eventId"), parsed.eventId);
                    assertEquals(expected.optString("roomId"), parsed.data.get("room_id"));
                }
                assertEquals(expected.optLong("unread"), Long.parseLong(parsed.data.get("unread")));
                assertEquals(expected.optLong("missedCalls"), Long.parseLong(parsed.data.get("missed_calls")));
                assertEquals(expected.optBoolean("sound"), "true".equals(parsed.data.get("sound")));
                assertEquals(summary.getLong("badgeCount"), (long) parsed.unread);
                assertEquals(summary.getLong("missedCalls"), Long.parseLong(parsed.data.get("missed_calls")));
                assertEquals(summary.getBoolean("effectiveSound"), parsed.kind == TrinityPushDelivery.Kind.EVENT && "true".equals(parsed.data.get("sound")));
                assertEquals(summary.has("highlight"), parsed.data.containsKey("highlight"));
                if (summary.has("highlight")) assertEquals(summary.getBoolean("highlight"), "true".equals(parsed.data.get("highlight")));
            }
        }
    }

    @Test
    public void unknownAndRetiredRoutesAreIgnoredWhileAccountsRemainSeparate() throws Exception {
        Map<String, String> unknown = event("unknown_route", "$event:unknown", "!room:unknown");
        TrinityPushDelivery.handle(context, unknown);
        assertNotificationCount(0);

        TrinityPushDelivery.handle(context, event(ROUTE_A, "$event:a", "!room:a"));
        TrinityPushDelivery.handle(context, event(ROUTE_B, "$event:b", "!room:b"));
        assertNotificationCount(2);
        notifications.notify("local.alert", 7, new NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(context.getApplicationInfo().icon).setContentTitle("Local").setContentText("Keep").build());

        clearLedger();
        setAccounts(ROUTE_A);
        TrinityPushDelivery.refresh(context);
        TrinityPushDelivery.handle(context, event(ROUTE_B, "$event:retired", "!room:retired"));
        assertNotificationCount(2);
        TrinityPushDelivery.handle(context, event(ROUTE_A, "$event:live", "!room:live"));
        assertNotificationCount(3);
    }

    @Test
    public void countOnlyAndDuplicateEventsDoNotPresentTwice() throws Exception {
        TrinityPushDelivery.handle(context, counts(ROUTE_A));
        assertNotificationCount(0);

        Map<String, String> event = event(ROUTE_A, "$event:dedupe", "!room:dedupe");
        TrinityPushDelivery.handle(context, event);
        TrinityPushDelivery.handle(context, event);
        TrinityPushDelivery.handle(context, event(ROUTE_B, "$event:dedupe", "!room:dedupe"));
        assertNotificationCount(2);
        JSONArray ledger = new JSONArray(context
                .getSharedPreferences(TrinityPushDelivery.STORAGE, Context.MODE_PRIVATE)
                .getString(TrinityPushDelivery.DEDUPE_KEY, "[]"));
        assertEquals(2, ledger.length());
    }

    @Test
    public void disabledGatewaySuppressesPresentation() {
        TrinityBadge.set(context, 12);
        context.getSharedPreferences(TrinityPushDelivery.STORAGE, Context.MODE_PRIVATE)
                .edit().putString(TrinityPushDelivery.GATEWAY_KEY, "{\"disabled\":true}").commit();
        TrinityPushDelivery.handle(context, event(ROUTE_A, "$event:disabled", "!room:disabled"));
        assertNotificationCount(0);
        assertEquals(12, TrinityBadge.get(context));
    }

    @Test
    public void silentEventUsesSilentChannelAndUpdatesAbsoluteBadge() {
        notifications.deleteNotificationChannel("trinity-notifications-silent");
        Map<String, String> payload = event(ROUTE_A, "$event:silent", "!room:silent");
        payload.put("sound", "false");
        payload.put("unread", "10000");
        TrinityPushDelivery.handle(context, payload);
        assertEquals(9999, TrinityBadge.get(context));
        assertNotificationCount(1);
        assertEquals("trinity-notifications-silent", activeNotifications().get(0).getChannelId());
        assertEquals(NotificationCompat.PRIORITY_LOW, activeNotifications().get(0).priority);
        assertEquals(0, activeNotifications().get(0).defaults & NotificationCompat.DEFAULT_SOUND);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel silent = notifications.getNotificationChannel("trinity-notifications-silent");
            assertNotNull(silent);
            assertEquals(null, silent.getSound());
            assertEquals(false, silent.shouldVibrate());
        }
        TrinityPushDelivery.handle(context, payload);
        assertEquals(9999, TrinityBadge.get(context));
        assertNotificationCount(1);
    }

    @Test
    public void countSnapshotsSetAbsoluteBadgeWithoutAlertsAndIgnoreMissedCalls() {
        TrinityBadge.set(context, 77);
        Map<String, String> first = counts(ROUTE_A);
        first.put("unread", "4");
        first.put("missed_calls", "9");
        TrinityPushDelivery.handle(context, first);
        assertEquals(4, TrinityBadge.get(context));
        assertEquals(0, activeNotifications().size());

        Map<String, String> second = counts(ROUTE_B);
        second.put("unread", "0");
        TrinityPushDelivery.handle(context, second);
        assertEquals(0, TrinityBadge.get(context));
        TrinityPushDelivery.handle(context, second);
        assertEquals(0, TrinityBadge.get(context));
        assertEquals(0, activeNotifications().size());
    }

    @Test
    public void malformedAndUnknownRoutesDoNotChangeBadge() {
        TrinityBadge.set(context, 12);
        Map<String, String> unknown = counts("unknown_route");
        unknown.put("unread", "9999");
        TrinityPushDelivery.handle(context, unknown);
        assertEquals(12, TrinityBadge.get(context));

        Map<String, String> malformed = counts(ROUTE_A);
        malformed.remove("schema");
        malformed.put("unread", "9999");
        TrinityPushDelivery.handle(context, malformed);
        assertEquals(12, TrinityBadge.get(context));
    }

    @Test
    public void foregroundClaimsRespectTheirOwnChannelWithoutConsumingBlockedEvents() throws Exception {
        String blocked = "push-test-blocked", allowed = "push-test-allowed";
        notifications.createNotificationChannel(new NotificationChannel(blocked, "Blocked test", NotificationManager.IMPORTANCE_NONE));
        notifications.createNotificationChannel(new NotificationChannel(allowed, "Allowed test", NotificationManager.IMPORTANCE_DEFAULT));
        try {
            assertEquals(TrinityPushDelivery.ClaimOutcome.ERROR,
                    TrinityPushDelivery.claimOutcome(context, ROUTE_A, "$event:blocked", blocked));
            assertEquals("[]", context.getSharedPreferences(TrinityPushDelivery.STORAGE, Context.MODE_PRIVATE)
                    .getString(TrinityPushDelivery.DEDUPE_KEY, "[]"));
            // The same identity is still available when a permitted channel is chosen.
            assertEquals(TrinityPushDelivery.ClaimOutcome.CLAIMED,
                    TrinityPushDelivery.claimOutcome(context, ROUTE_A, "$event:blocked", allowed));
            assertEquals(TrinityPushDelivery.ClaimOutcome.DUPLICATE,
                    TrinityPushDelivery.claimOutcome(context, ROUTE_A, "$event:blocked", allowed));
            // Blocking a foreground channel does not prevent background messages.
            TrinityPushDelivery.handle(context, event(ROUTE_A, "$event:background", "!room:a"));
            assertNotificationCount(1);
        } finally {
            notifications.deleteNotificationChannel(blocked);
            notifications.deleteNotificationChannel(allowed);
        }
    }

    @Test
    public void globallyBlockedNotificationsDoNotConsumePresentationClaims() throws Exception {
        Assume.assumeTrue("permission revoked before test process starts",
                "true".equals(InstrumentationRegistry.getArguments().getString("permissionDenied")));
        assertEquals(PackageManager.PERMISSION_DENIED, context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS));
        assertEquals(false, notifications.areNotificationsEnabled());
        assertEquals(TrinityPushDelivery.ClaimOutcome.ERROR,
                TrinityPushDelivery.claimOutcome(context, ROUTE_A, "$event:permission", "default"));
        TrinityPushDelivery.handle(context, event(ROUTE_A, "$event:permission", "!room:a"));
        assertNotificationCount(0);
        assertEquals("[]", context.getSharedPreferences(TrinityPushDelivery.STORAGE, Context.MODE_PRIVATE)
                .getString(TrinityPushDelivery.DEDUPE_KEY, "[]"));
    }

    @Test
    public void notificationUsesMessagesChannelAndPendingIntentCanBeSent() {
        TrinityPushDelivery.handle(context, event(ROUTE_A, "$event:click", "!room:click"));
        assertNotificationCount(1);
        List<Notification> posted = activeNotifications();
        assertEquals(1, posted.size());
        Notification notification = posted.get(0);
        assertEquals(CHANNEL, notification.getChannelId());
        assertEquals("Trinity", notification.extras.getString(Notification.EXTRA_TITLE));
        assertEquals("New message", notification.extras.getString(Notification.EXTRA_TEXT));
        assertEquals(NotificationCompat.PRIORITY_HIGH, notification.priority);
        assertEquals(Build.VERSION.SDK_INT < 26 ? NotificationCompat.DEFAULT_SOUND : 0,
                notification.defaults & NotificationCompat.DEFAULT_SOUND);
        assertNotNull(notification.contentIntent);
    }

    @Test
    public void channelIsCreatedForDelivery() {
        TrinityPushDelivery.handle(context, event(ROUTE_A, "$event:channel", "!room:channel"));
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = notifications.getNotificationChannel(CHANNEL);
            assertNotNull(channel);
            assertTrue(channel.getImportance() > NotificationManager.IMPORTANCE_NONE);
            assertNotNull(channel.getSound());
        }
    }

    @Test
    public void installedManifestRoutesFcmToTheNativeDeliveryService() {
        android.content.Intent message = new android.content.Intent("com.google.firebase.MESSAGING_EVENT")
                .setPackage(context.getPackageName());
        android.content.pm.ResolveInfo resolved = context.getPackageManager().resolveService(message, 0);
        assertNotNull(resolved);
        assertEquals(TrinityPushMessagingService.class.getName(), resolved.serviceInfo.name);
        assertEquals(false, resolved.serviceInfo.exported);
        for (android.content.pm.ResolveInfo candidate : context.getPackageManager().queryIntentServices(message, 0)) {
            assertTrue("Capacitor's replaced handler must not compete for FCM delivery",
                    !"com.capacitorjs.plugins.pushnotifications.MessagingService".equals(candidate.serviceInfo.name));
        }
    }

    /** E2E bridge: deliver a route already restored by the running WebView, then tap it. */
    @Test
    public void deliverConfiguredEventAndOpenPendingIntent() throws Exception {
        Bundle arguments = InstrumentationRegistry.getArguments();
        Assume.assumeTrue("bridge E2E requires explicit route argument", arguments.containsKey("route"));
        String route = arguments.getString("route", ROUTE_A);
        String targetUserId = arguments.getString("targetUserId", "");
        String eventId = arguments.getString("event", "$event:instrumented");
        String secondEventId = arguments.getString("event2", "$event:instrumented-warm");
        String roomId = arguments.getString("room", "!room:instrumented");
        assertEquals(new String(android.util.Base64.decode(arguments.getString("eventBase64", ""), android.util.Base64.DEFAULT), StandardCharsets.UTF_8), eventId);
        assertEquals(new String(android.util.Base64.decode(arguments.getString("event2Base64", ""), android.util.Base64.DEFAULT), StandardCharsets.UTF_8), secondEventId);
        assertEquals("cold delivery must precede Activity resume", false, MainActivity.isResumed());
        ensureAccountRoute(route, targetUserId);
        TrinityPushDelivery.handle(context, event(route, eventId, roomId));
        assertNotificationCount(1);
        List<Notification> posted = activeNotifications();
        assertEquals(1, posted.size());
        assertNotNull(posted.get(0).contentIntent);
        try {
            posted.get(0).contentIntent.send();
        } catch (PendingIntent.CanceledException error) {
            throw new AssertionError("configured push notification content intent was canceled", error);
        }
        File coldReady = new File(context.getFilesDir(), "push-e2e-cold-ready");
        File warmReady = new File(context.getFilesDir(), "push-e2e-warm-ready");
        File advance = new File(context.getFilesDir(), "push-e2e-advance");
        File finish = new File(context.getFilesDir(), "push-e2e-finish");
        try {
            awaitE2ePhase(coldReady, advance);
            advance.delete();
            long backgroundDeadline = System.currentTimeMillis() + 10_000;
            while (MainActivity.isResumed() && System.currentTimeMillis() < backgroundDeadline) Thread.sleep(25);
            assertEquals("warm delivery requires the Activity in background", false, MainActivity.isResumed());
            TrinityPushDelivery.handle(context, event(route, secondEventId, roomId));
            assertNotificationCount(2);
            byte[] identityBytes = java.security.MessageDigest.getInstance("SHA-256")
                    .digest((route + "\u0000" + secondEventId).getBytes(StandardCharsets.UTF_8));
            StringBuilder identity = new StringBuilder();
            for (byte value : identityBytes) identity.append(String.format("%02x", value));
            Notification warm = null;
            for (android.service.notification.StatusBarNotification notification : notifications.getActiveNotifications()) {
                if (notification.getTag() != null && notification.getTag().endsWith("." + identity)) warm = notification.getNotification();
            }
            assertNotNull("warm push must post the exact second event", warm);
            try {
                warm.contentIntent.send();
            } catch (PendingIntent.CanceledException error) {
                throw new AssertionError("warm push notification content intent was canceled", error);
            }
            awaitE2ePhase(warmReady, finish);
        } catch (Exception error) {
            throw new AssertionError("push E2E phase handshake failed", error);
        } finally {
            coldReady.delete(); warmReady.delete(); advance.delete(); finish.delete();
        }
    }

    private static void awaitE2ePhase(File ready, File release) throws Exception {
        ready.delete();
        release.delete();
        ready.createNewFile();
        long deadline = System.currentTimeMillis() + 60_000;
        while (!release.exists() && System.currentTimeMillis() < deadline) Thread.sleep(100);
        assertTrue("Playwright did not attach after native PendingIntent activation", release.exists());
    }

    private void clearState() throws Exception {
        notifications.cancelAll();
        assertNotificationCount(0);
        context.getSharedPreferences(TrinityPushDelivery.STORAGE, Context.MODE_PRIVATE).edit()
                .remove(TrinityPushDelivery.ACCOUNTS_KEY).remove(TrinityPushDelivery.GATEWAY_KEY)
                .remove(TrinityPushDelivery.DEDUPE_KEY).commit();
        setAccounts(ROUTE_A, ROUTE_B);
    }

    private void clearLedger() {
        context.getSharedPreferences(TrinityPushDelivery.STORAGE, Context.MODE_PRIVATE)
                .edit().remove(TrinityPushDelivery.DEDUPE_KEY).commit();
    }

    private void grantNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            InstrumentationRegistry.getInstrumentation().getUiAutomation()
                    .grantRuntimePermission(context.getPackageName(), Manifest.permission.POST_NOTIFICATIONS);
        }
    }

    private void setAccounts(String... routes) throws Exception {
        JSONArray accounts = new JSONArray();
        for (String route : routes) accounts.put(new JSONObject().put("pushAccountRoute", route));
        context.getSharedPreferences(TrinityPushDelivery.STORAGE, Context.MODE_PRIVATE).edit()
                .putString(TrinityPushDelivery.ACCOUNTS_KEY, new JSONObject().put("accounts", accounts).toString())
                .commit();
    }

    private void ensureAccountRoute(String route, String targetUserId) throws Exception {
        String raw = context.getSharedPreferences(TrinityPushDelivery.STORAGE, Context.MODE_PRIVATE)
                .getString(TrinityPushDelivery.ACCOUNTS_KEY, null);
        if (raw == null) {
            throw new AssertionError("restored matrix.accounts registry was absent");
        }
        try {
            JSONObject root = new JSONObject(raw);
            JSONArray accounts = root.getJSONArray("accounts");
            if (targetUserId.isEmpty()) throw new AssertionError("targetUserId is required for configured push delivery");
            boolean targetFound = false;
            for (int i = 0; i < accounts.length(); i++) {
                JSONObject account = accounts.getJSONObject(i);
                if (!targetUserId.isEmpty() && targetUserId.equals(account.optString("userId"))) {
                    account.put("pushAccountRoute", route);
                    targetFound = true;
                    break;
                }
                if (route.equals(account.optString("pushAccountRoute"))) return;
            }
            if (!targetFound) throw new AssertionError("target Account was not present in matrix.accounts");
            context.getSharedPreferences(TrinityPushDelivery.STORAGE, Context.MODE_PRIVATE).edit()
                    .putString(TrinityPushDelivery.ACCOUNTS_KEY, root.toString()).commit();
        } catch (RuntimeException error) {
            throw new AssertionError("restored matrix.accounts registry was not valid JSON", error);
        }
    }

    private void assertNotificationCount(int expected) {
        long deadline = android.os.SystemClock.elapsedRealtime() + 5_000;
        while (activeNotifications().size() != expected && android.os.SystemClock.elapsedRealtime() < deadline) {
            android.os.SystemClock.sleep(25);
        }
        assertEquals(expected, activeNotifications().size());
    }

    private List<Notification> activeNotifications() {
        if (Build.VERSION.SDK_INT < 23) return new ArrayList<>();
        Notification[] values = notifications.getActiveNotifications() == null
                ? new Notification[0]
                : java.util.Arrays.stream(notifications.getActiveNotifications())
                    .map(android.service.notification.StatusBarNotification::getNotification)
                    .toArray(Notification[]::new);
        return java.util.Arrays.asList(values);
    }

    private JSONArray readFixtures() throws Exception {
        try (InputStream input = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("payloads.json")) {
            byte[] bytes = input.readAllBytes();
            return new JSONArray(new String(bytes, StandardCharsets.UTF_8));
        }
    }

    private static Map<String, String> stringMap(JSONObject source) {
        Map<String, String> result = new HashMap<>();
        if (source == null) return result;
        java.util.Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object value = source.opt(key);
            result.put(key, value instanceof String ? (String) value : null);
        }
        return result;
    }

    private static Map<String, String> event(String route, String event, String room) {
        Map<String, String> result = base(route);
        result.put("kind", "event");
        result.put("event_id", event);
        result.put("room_id", room);
        result.put("sound", "true");
        return result;
    }

    private static Map<String, String> counts(String route) {
        Map<String, String> result = base(route);
        result.put("kind", "counts");
        result.put("sound", "false");
        return result;
    }

    private static Map<String, String> base(String route) {
        Map<String, String> result = new HashMap<>();
        result.put("schema", "1");
        result.put("trinity_account_id", route);
        result.put("unread", "2");
        result.put("missed_calls", "0");
        return result;
    }
}
