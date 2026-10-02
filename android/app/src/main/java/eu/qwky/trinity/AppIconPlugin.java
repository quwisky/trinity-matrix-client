package eu.qwky.trinity;

import android.content.ComponentName;
import android.content.pm.PackageManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Switches the launcher icon for the App icon preference by enabling one of the two
 * launcher aliases in AndroidManifest.xml. Called only on an explicit user choice: some
 * launchers drop pinned shortcuts, and the OS may close the app, when a launcher
 * component changes.
 */
@CapacitorPlugin(name = "AppIcon")
public class AppIconPlugin extends Plugin {
    private static final String BLURPLE = "LauncherBlurple";
    private static final String DARK = "LauncherDark";

    @PluginMethod
    public void set(PluginCall call) {
        String name = call.getString("name");
        if (!"blurple".equals(name) && !"dark".equals(name)) {
            call.reject("Unknown app icon: " + name);
            return;
        }
        String target = "dark".equals(name) ? DARK : BLURPLE;
        String other = "dark".equals(name) ? BLURPLE : DARK;
        PackageManager pm = getContext().getPackageManager();
        if (isEnabled(pm, target)) {
            call.resolve();
            return;
        }
        pm.setComponentEnabledSetting(
            component(target),
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
            PackageManager.DONT_KILL_APP
        );
        pm.setComponentEnabledSetting(
            component(other),
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP
        );
        call.resolve();
    }

    /** DEFAULT means "as declared in the manifest", where only the blurple alias is enabled. */
    private boolean isEnabled(PackageManager pm, String alias) {
        int state = pm.getComponentEnabledSetting(component(alias));
        return state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            || (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && BLURPLE.equals(alias));
    }

    /** Package = applicationId (may carry a suffix); class = the source namespace. */
    private ComponentName component(String alias) {
        return new ComponentName(
            getContext().getPackageName(),
            MainActivity.class.getPackage().getName() + "." + alias
        );
    }
}
