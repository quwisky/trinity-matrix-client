package eu.qwky.trinity;

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps the renderer's Android registration call on the already loaded push plugin.
 *
 * PushNotificationsPlugin owns permissions and token listeners. This
 * companion only provides a guarded entry point so an unprovisioned Android build reports
 * a rejected Capacitor call instead of letting a Firebase initialization exception escape.
 */
@CapacitorPlugin(name = "TrinityPushRegistration")
public class TrinityPushRegistrationPlugin extends Plugin {

    private static final String CONFIGURATION_ERROR = "Push notifications are not configured for this Android build";

    @PluginMethod
    public void register(PluginCall call) {
        try {
            PluginHandle handle = getBridge().getPlugin("PushNotifications");
            if (handle == null || !(handle.getInstance() instanceof PushNotificationsPlugin)) {
                call.reject(CONFIGURATION_ERROR);
                return;
            }

            ((PushNotificationsPlugin) handle.getInstance()).register(call);
        } catch (RuntimeException ignored) {
            call.reject(CONFIGURATION_ERROR);
        }
    }
}
