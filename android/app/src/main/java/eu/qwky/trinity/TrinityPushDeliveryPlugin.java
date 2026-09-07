package eu.qwky.trinity;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.Map;
import android.content.SharedPreferences;

@CapacitorPlugin(name = "TrinityPushDelivery")
public final class TrinityPushDeliveryPlugin extends Plugin {
    private static final Map<String, String> owners = new HashMap<>();
    private String listenerOwner;
    private String presentationOwner;
    private SharedPreferences preferences;
    private final SharedPreferences.OnSharedPreferenceChangeListener preferenceListener = (prefs, key) -> {
        if (key == null || "matrix.accounts".equals(key) || "trinity.push.gateway".equals(key)) TrinityPushDelivery.refresh(getContext());
    };
    @Override public void load() {
        super.load();
        preferences = getContext().getSharedPreferences(TrinityPushDelivery.STORAGE, 0);
        preferences.registerOnSharedPreferenceChangeListener(preferenceListener);
    }
    static boolean ready() { synchronized (owners) { return owners.containsKey("listener") && owners.containsKey("presentation"); } }
    @PluginMethod public void claimPresentation(PluginCall call) {
        String route=call.getString("accountRoute"), event=call.getString("eventId");
        String channelId = call.getString("channelId");
        TrinityPushDelivery.ClaimOutcome outcome = TrinityPushDelivery.claimOutcome(getContext(), route, event,
                channelId == null || channelId.isEmpty() ? "messages" : channelId);
        if (outcome == TrinityPushDelivery.ClaimOutcome.ERROR) { call.reject("Push delivery is unavailable"); return; }
        boolean claimed=outcome == TrinityPushDelivery.ClaimOutcome.CLAIMED;
        call.resolve(new com.getcapacitor.JSObject().put("claimed", claimed));
    }
    @PluginMethod public void setForegroundOwner(PluginCall call) {
        String kind=call.getString("kind"), owner=call.getString("owner"); boolean active=Boolean.TRUE.equals(call.getBoolean("active"));
        if ((kind == null) || (!kind.equals("listener") && !kind.equals("presentation")) || owner == null || owner.isEmpty()) { call.resolve(); return; }
        synchronized (owners) {
            if (kind.equals("listener")) { if (active) { listenerOwner=owner; owners.put(kind, owner); } else if (owner.equals(listenerOwner) && owner.equals(owners.get(kind))) { listenerOwner=null; owners.remove(kind); } }
            else { if (active) { presentationOwner=owner; owners.put(kind, owner); } else if (owner.equals(presentationOwner) && owner.equals(owners.get(kind))) { presentationOwner=null; owners.remove(kind); } }
        }
        call.resolve();
    }
    @Override protected void handleOnDestroy() {
        if (preferences != null) preferences.unregisterOnSharedPreferenceChangeListener(preferenceListener);
        synchronized (owners) {
            if (listenerOwner != null && listenerOwner.equals(owners.get("listener"))) owners.remove("listener");
            if (presentationOwner != null && presentationOwner.equals(owners.get("presentation"))) owners.remove("presentation");
        }
        super.handleOnDestroy();
    }
}
