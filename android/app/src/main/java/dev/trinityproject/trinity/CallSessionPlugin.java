package dev.trinityproject.trinity;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps a joined call alive while Trinity is in the background: begin() starts
 * CallSessionService, end() stops it, and the notification's Hang up comes back as "hangUp".
 */
@CapacitorPlugin(name = "CallSession")
public class CallSessionPlugin extends Plugin {
    private final BroadcastReceiver hangUpReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            notifyListeners("hangUp", new JSObject());
            // Gone even if the web layer never answers.
            stopService();
        }
    };

    @Override
    public void load() {
        ContextCompat.registerReceiver(
            getContext(),
            hangUpReceiver,
            new IntentFilter(CallSessionService.ACTION_HANG_UP),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    @Override
    protected void handleOnDestroy() {
        getContext().unregisterReceiver(hangUpReceiver);
        stopService();
    }

    @PluginMethod
    public void begin(PluginCall call) {
        Intent intent = new Intent(getContext(), CallSessionService.class)
            .putExtra(CallSessionService.EXTRA_ROOM_NAME, call.getString("roomName", ""));
        JSObject result = new JSObject();
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            result.put("started", true);
        } catch (RuntimeException error) {
            // ForegroundServiceStartNotAllowedException (Android 12+, from the background) and
            // SecurityException: the call goes on without the service.
            result.put("started", false);
            result.put("reason", error.getClass().getSimpleName());
        }
        call.resolve(result);
    }

    @PluginMethod
    public void end(PluginCall call) {
        stopService();
        call.resolve();
    }

    private void stopService() {
        getContext().stopService(new Intent(getContext(), CallSessionService.class));
    }
}
