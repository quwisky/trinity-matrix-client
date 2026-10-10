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
import dev.trinityproject.trinity.push.PushTapKt;
import dev.trinityproject.trinity.push.RoomNotificationKey;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Writes the push handoff store TrinityMessagingService reads while the app is closed: each
 * account's homeserver, access token and sound choice, and its room names. PushHandoffService
 * in data-access/notifications is the only caller. Never logs what it stores.
 */
@CapacitorPlugin(name = "PushHandoff")
public class PushHandoffPlugin extends Plugin {
    private PushHandoffStore store;

    @Override
    public void load() {
        store = new PushHandoffStore(getContext());
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
        if (store.setAccount(userId, new HandoffAccount(homeserverUrl, accessToken, sound))) {
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
                parsed.put(room.getString("roomId"), new HandoffRoom(room.getString("name"), room.getBoolean("direct")));
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
}
