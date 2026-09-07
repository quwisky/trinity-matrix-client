package eu.qwky.trinity;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static volatile boolean resumed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(TrinityPushRegistrationPlugin.class);
        registerPlugin(TrinityPushDeliveryPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() { super.onResume(); resumed = true; }

    @Override
    public void onPause() { resumed = false; super.onPause(); }

    static boolean isResumed() { return resumed; }
}
