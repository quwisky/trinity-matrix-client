package dev.trinityproject.trinity;

import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int TABLET_SMALLEST_WIDTH_DP = 600;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must register before super.onCreate() builds the bridge.
        registerPlugin(AppSettingsPlugin.class);
        super.onCreate(savedInstanceState);
        applyOrientationPolicy(getResources().getConfiguration());
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // A foldable changes size without recreating the activity.
        applyOrientationPolicy(newConfig);
    }

    private void applyOrientationPolicy(Configuration config) {
        setRequestedOrientation(
            config.smallestScreenWidthDp < TABLET_SMALLEST_WIDTH_DP
                ? ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        );
    }
}
