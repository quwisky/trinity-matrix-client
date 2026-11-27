package dev.trinityproject.trinity;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Handler;
import android.os.Looper;
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
    /** How long the web layer has to leave the call and end() before the receiver stops it: outlasts its 10 s leave timeout. */
    private static final long HANG_UP_FALLBACK_MS = 15_000;

    private final Handler main = new Handler(Looper.getMainLooper());
    /** Counts begin() calls, so a late fallback stop never ends a newer call's service. */
    private volatile int generation = 0;

    private final BroadcastReceiver hangUpReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            notifyListeners("hangUp", new JSObject());
            int hungUp = generation;
            // The web layer ends the service once the call has settled, at most its 10 s leave
            // timeout after this hang-up; this stops it if the web layer never answers.
            main.postDelayed(() -> {
                if (generation == hungUp) CallSessionService.end(getContext());
            }, HANG_UP_FALLBACK_MS);
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
        main.removeCallbacksAndMessages(null);
        stopService();
    }

    @PluginMethod
    public void begin(PluginCall call) {
        JSObject result = new JSObject();
        try {
            generation++;
            CallSessionService.begin(getContext(), call.getString("roomName", ""));
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
        CallSessionService.end(getContext());
    }
}
