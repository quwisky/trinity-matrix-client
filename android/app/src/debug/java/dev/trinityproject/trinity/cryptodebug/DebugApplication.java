package dev.trinityproject.trinity.cryptodebug;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * Debug builds only: registers {@link TrinityCryptoDebugPlugin} with every bridge activity, so
 * MainActivity and release builds never name it. Needs Android 10 (API 29) for the pre-create
 * callback, which runs before MainActivity builds its bridge.
 */
public class DebugApplication extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        registerActivityLifecycleCallbacks(
            new ActivityLifecycleCallbacks() {
                @Override
                public void onActivityPreCreated(Activity activity, Bundle savedInstanceState) {
                    if (activity instanceof BridgeActivity) {
                        ((BridgeActivity) activity).registerPlugin(TrinityCryptoDebugPlugin.class);
                    }
                }

                @Override
                public void onActivityCreated(Activity activity, Bundle savedInstanceState) {}

                @Override
                public void onActivityStarted(Activity activity) {}

                @Override
                public void onActivityResumed(Activity activity) {}

                @Override
                public void onActivityPaused(Activity activity) {}

                @Override
                public void onActivityStopped(Activity activity) {}

                @Override
                public void onActivitySaveInstanceState(Activity activity, Bundle outState) {}

                @Override
                public void onActivityDestroyed(Activity activity) {}
            }
        );
    }
}
