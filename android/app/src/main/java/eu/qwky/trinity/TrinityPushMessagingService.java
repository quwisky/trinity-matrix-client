package eu.qwky.trinity;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

/** Native gateway delivery owner. onNewToken intentionally remains inherited. */
public final class TrinityPushMessagingService extends MessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        TrinityPushDelivery.handle(this, message);
    }
}
