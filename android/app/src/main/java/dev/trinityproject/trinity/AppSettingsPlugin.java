package dev.trinityproject.trinity;

import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/**
 * Opens Trinity's page in the system settings, where a permission the user refused for good
 * can be turned back on. The composer offers it after camera access is denied (#919). App
 * lock's "Hide on the lock screen" opens the Messages channel's settings, whose lock-screen
 * setting that choice follows (decision 16).
 */
@CapacitorPlugin(name = "AppSettings")
public class AppSettingsPlugin extends Plugin {
    /** The channel TrinityMessagingService posts message pushes on (MESSAGES_CHANNEL_ID). */
    private static final String MESSAGES_CHANNEL_ID = "messages";

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        open(call, appDetails());
    }

    /**
     * The Messages channel's page, where people can hide sensitive content for Trinity alone.
     * That channel exists once push is set up; before then (and the Settings app closes a
     * channel page for a channel that doesn't exist) Trinity's notification page, and before
     * Android 8, which has no channels, Trinity's page.
     */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            open(call, appDetails());
            return;
        }
        String packageName = getContext().getPackageName();
        NotificationManager manager =
            (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        Intent intent =
            manager != null && manager.getNotificationChannel(MESSAGES_CHANNEL_ID) != null
                ? new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    .putExtra(Settings.EXTRA_CHANNEL_ID, MESSAGES_CHANNEL_ID)
                : new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName);
        open(call, intent);
    }

    /** Android has no app-readable equivalent of iOS's Show Previews. */
    @PluginMethod
    public void notificationPreviewSetting(PluginCall call) {
        JSObject result = new JSObject();
        result.put("value", JSONObject.NULL);
        call.resolve(result);
    }

    private Intent appDetails() {
        return new Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", getContext().getPackageName(), null)
        );
    }

    private void open(PluginCall call, Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException error) {
            call.reject("Settings are unavailable");
        }
    }
}
