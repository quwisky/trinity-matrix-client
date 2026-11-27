package dev.trinityproject.trinity;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * The foreground service that keeps a joined call's WebView capturing and connected while
 * Trinity is in the background or the screen is off, with an ongoing "Call in progress"
 * notification. Lives from CallSessionPlugin.begin() to end(), or until the task is removed.
 */
public class CallSessionService extends Service {
    static final String ACTION_HANG_UP = "dev.trinityproject.trinity.CALL_HANG_UP";
    static final String EXTRA_ROOM_NAME = "roomName";

    private static final String CHANNEL_ID = "calls";
    private static final int NOTIFICATION_ID = 0x7ca11;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String roomName = intent != null ? intent.getStringExtra(EXTRA_ROOM_NAME) : null;
        Notification notification = notification(roomName != null ? roomName : "");
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, grantedTypes());
        } catch (RuntimeException error) {
            // SecurityException or ForegroundServiceStartNotAllowedException: no service.
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /**
     * Android 14+ only allows a camera or microphone service type whose runtime permission is
     * granted. A call joined without either (receive-only) still plays the others' audio.
     */
    private int grantedTypes() {
        int types = 0;
        if (granted(Manifest.permission.RECORD_AUDIO)) {
            types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        }
        if (granted(Manifest.permission.CAMERA)) {
            types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
        }
        return types != 0 ? types : ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(this, permission)
            == PackageManager.PERMISSION_GRANTED;
    }

    private Notification notification(String roomName) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null && manager.getNotificationChannel(CHANNEL_ID) == null) {
                manager.createNotificationChannel(
                    new NotificationChannel(CHANNEL_ID, "Calls", NotificationManager.IMPORTANCE_LOW)
                );
            }
        }
        PendingIntent open = PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        PendingIntent hangUp = PendingIntent.getBroadcast(
            this,
            0,
            new Intent(ACTION_HANG_UP).setPackage(getPackageName()),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_trinity)
            .setContentTitle("Call in progress")
            .setContentText(roomName)
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, "Hang up", hangUp)
            .build();
    }
}
