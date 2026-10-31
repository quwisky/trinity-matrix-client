package dev.trinityproject.trinity;

import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.FirebaseApp;
import dev.trinityproject.trinity.push.DeliveredPushesKt;
import dev.trinityproject.trinity.push.HandoffAccount;
import dev.trinityproject.trinity.push.HandoffRoom;
import dev.trinityproject.trinity.push.PushHandoffStore;
import dev.trinityproject.trinity.push.PushHandoffStoreKt;
import dev.trinityproject.trinity.push.PushTapKt;
import dev.trinityproject.trinity.push.RoomNotificationKey;
import dev.trinityproject.trinity.push.TokenRecord;
import dev.trinityproject.trinity.push.TokenRecordKt;
import dev.trinityproject.trinity.push.TokenRefresher;
import dev.trinityproject.trinity.push.TokenRemoval;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import kotlin.Pair;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Writes the push handoff store TrinityMessagingService reads while the app is closed: each
 * account's homeserver, access token (with its expiry, when it has one) and sound choice, and
 * its room names. PushHandoffService in data-access/notifications is the only caller of those.
 * Also exposes the native token refresher, whose calls answer the access token and expiry only:
 * the refresh token never crosses back to the app. Never logs what it stores.
 */
@CapacitorPlugin(name = "PushHandoff")
public class PushHandoffPlugin extends Plugin {
    // A grant and a wait for the lease both block, so no token call runs on the plugin thread.
    private final ExecutorService tokenWork = Executors.newCachedThreadPool();
    private PushHandoffStore store;
    private TokenRefresher tokens;

    @Override
    public void load() {
        store = new PushHandoffStore(getContext());
        tokens = TokenRefresher.fromContext(getContext());
    }

    @PluginMethod
    public void setAccount(PluginCall call) {
        String userId = call.getString("userId");
        String homeserverUrl = call.getString("homeserverUrl");
        String accessToken = call.getString("accessToken");
        Boolean sound = call.getBoolean("sound");
        if (userId == null || homeserverUrl == null || accessToken == null || sound == null) {
            call.reject("Must provide userId, homeserverUrl, accessToken and sound");
            return;
        }
        // Epoch milliseconds; absent for a token that does not expire on a schedule.
        Long accessTokenExpiresAt = PushHandoffStoreKt.accessTokenExpiryFrom(call.getData().opt("accessTokenExpiresAt"));
        if (store.setAccount(userId, new HandoffAccount(homeserverUrl, accessToken, sound, accessTokenExpiresAt))) {
            call.resolve();
        } else {
            call.reject("Could not store the push account");
        }
    }

    @PluginMethod
    public void setRooms(PluginCall call) {
        String userId = call.getString("userId");
        JSArray rooms = call.getArray("rooms");
        if (userId == null || rooms == null) {
            call.reject("Must provide userId and rooms");
            return;
        }
        Map<String, HandoffRoom> parsed = new HashMap<>();
        try {
            for (int index = 0; index < rooms.length(); index++) {
                JSONObject room = rooms.getJSONObject(index);
                // A room the app sent without the flag counts as encrypted.
                parsed.put(
                    room.getString("roomId"),
                    new HandoffRoom(room.getString("name"), room.getBoolean("direct"), room.optBoolean("encrypted", true))
                );
            }
        } catch (JSONException error) {
            call.reject("Rooms must carry roomId, name and direct");
            return;
        }
        if (store.mergeRooms(userId, parsed)) {
            call.resolve();
        } else {
            call.reject("Could not store the push rooms");
        }
    }

    @PluginMethod
    public void removeAccount(PluginCall call) {
        String userId = call.getString("userId");
        if (userId == null) {
            call.reject("Must provide userId");
            return;
        }
        // Its delivered notifications go too: they carry message text of an account now gone.
        DeliveredPushesKt.cancelDeliveredPushes(getContext(), userId);
        if (store.removeAccount(userId)) {
            call.resolve();
        } else {
            call.reject("Could not remove the push account");
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        DeliveredPushesKt.cancelDeliveredPushes(getContext(), null);
        if (store.clear()) {
            call.resolve();
        } else {
            call.reject("Could not clear the push handoff");
        }
    }

    /** App lock's effective Notification text, for TrinityMessagingService; refuses an unknown mode. */
    @PluginMethod
    public void setNotificationText(PluginCall call) {
        String mode = call.getString("mode");
        if (mode == null || !store.setNotificationText(mode)) {
            call.reject("Could not store the notification text");
            return;
        }
        call.resolve();
    }

    /**
     * The text became more private: cancel every notification Trinity posted, the pushes
     * TrinityMessagingService rendered and the running app's own alike. Rejects when the
     * notification manager refuses; the app treats that as best effort.
     */
    @PluginMethod
    public void clearDelivered(PluginCall call) {
        try {
            NotificationManagerCompat.from(getContext()).cancelAll();
        } catch (RuntimeException error) {
            call.reject("Could not clear the delivered notifications");
            return;
        }
        call.resolve();
    }

    /** The room was opened: drop the notification TrinityMessagingService posted for it. */
    @PluginMethod
    public void clearRoom(PluginCall call) {
        String userId = call.getString("userId");
        String roomId = call.getString("roomId");
        if (userId == null || roomId == null) {
            call.reject("Must provide userId and roomId");
            return;
        }
        RoomNotificationKey key = PushTapKt.roomNotificationKey(userId, roomId);
        NotificationManagerCompat.from(getContext()).cancel(key.getTag(), key.getId());
        call.resolve();
    }

    /**
     * Whether Firebase is configured (a google-services.json was present at build time).
     * PushNotifications.register() crashes the app without it, so the web layer asks first.
     */
    @PluginMethod
    public void registrationAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("value", !FirebaseApp.getApps(getContext()).isEmpty());
        call.resolve(result);
    }

    /**
     * iOS holds background run time here; Android has no equivalent the web layer needs, so this
     * holds nothing and answers id 0. Android never locks the session's stored tokens away while
     * the app runs, so protected data is always available and the device never locks.
     */
    @PluginMethod
    public void beginBackgroundWork(PluginCall call) {
        JSObject result = new JSObject();
        result.put("id", 0);
        result.put("protectedDataAvailable", true);
        result.put("locking", false);
        call.resolve(result);
    }

    /** Nothing was held by beginBackgroundWork, so there is nothing to end. */
    @PluginMethod
    public void endBackgroundWork(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void refreshTokens(PluginCall call) {
        String userId = call.getString("userId");
        String lineage = call.getString("lineage");
        String tokenSeen = call.getString("tokenSeen");
        if (userId == null || lineage == null || tokenSeen == null) {
            call.reject("Must provide userId, lineage and tokenSeen");
            return;
        }
        answerOnWorker(call, transientAnswer(), () -> tokens.refresh(userId, lineage, tokenSeen, TokenRefresher.appDeadline()).wire());
    }

    @PluginMethod
    public void currentTokens(PluginCall call) {
        String userId = call.getString("userId");
        String lineage = call.getString("lineage");
        if (userId == null || lineage == null) {
            call.reject("Must provide userId and lineage");
            return;
        }
        answerOnWorker(call, transientAnswer(), () -> tokens.current(userId, lineage).wire());
    }

    @PluginMethod
    public void migrateTokens(PluginCall call) {
        Pair<String, TokenRecord> parsed = TokenRecordKt.tokenRecordFromPluginCall(call.getData());
        if (parsed == null) {
            call.reject("Must provide userId, lineage, accessToken, refreshToken, tokenEndpoint, clientId and deviceId");
            return;
        }
        answerOnWorker(call, new JSObject().put("stored", false), () ->
            new JSObject().put("stored", tokens.migrate(parsed.getSecond(), parsed.getFirst()))
        );
    }

    @PluginMethod
    public void revokeTokens(PluginCall call) {
        String userId = call.getString("userId");
        String lineage = call.getString("lineage");
        if (userId == null || lineage == null) {
            call.reject("Must provide userId and lineage");
            return;
        }
        answerOnWorker(call, transientAnswer(), () -> tokens.revoke(userId, lineage).wire());
    }

    /**
     * One account, or every record with all: true. Rejects on anything but exactly one of those, or
     * on a store failure.
     */
    @PluginMethod
    public void removeTokens(PluginCall call) {
        TokenRemoval removal = TokenRecordKt.tokenRemovalFromPluginCall(call.getData());
        if (removal == null) {
            call.reject("Must provide a userId or all: true");
            return;
        }
        tokenWork.execute(() -> {
            boolean removed;
            try {
                removed = tokens.remove(removal.getAccount());
            } catch (RuntimeException error) {
                removed = false;
            }
            if (removed) {
                call.resolve();
            } else {
                call.reject("Could not remove the tokens");
            }
        });
    }

    /** Failures are answers: whatever `work` throws resolves `failed`, never crossing the bridge. */
    private void answerOnWorker(PluginCall call, JSObject failed, Callable<JSONObject> work) {
        tokenWork.execute(() -> {
            JSObject answer;
            try {
                answer = JSObject.fromJSONObject(work.call());
            } catch (Exception error) {
                answer = failed;
            }
            call.resolve(answer);
        });
    }

    private static JSObject transientAnswer() {
        return new JSObject().put("kind", "transient");
    }
}
