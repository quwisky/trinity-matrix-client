package dev.trinityproject.trinity;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
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
 * notification. Lives from begin() to end(), or until the task is removed.
 */
public class CallSessionService extends Service {
    static final String ACTION_HANG_UP = "dev.trinityproject.trinity.CALL_HANG_UP";
    static final String EXTRA_ROOM_NAME = "roomName";

    private static final String CHANNEL_ID = "calls";
    private static final int NOTIFICATION_ID = 0x7ca11;

    private static final Object lock = new Object();
    /** Starts asked for whose onStartCommand has not run yet. */
    private static int pendingStarts = 0;
    /** end() came while a start was pending: stop once startForeground has been called. */
    private static boolean stopRequested = false;

    /** Throws what startForegroundService throws (ForegroundServiceStartNotAllowedException). */
    static void begin(Context context, String roomName) {
        Intent intent = new Intent(context, CallSessionService.class)
            .putExtra(EXTRA_ROOM_NAME, roomName);
        synchronized (lock) {
            ContextCompat.startForegroundService(context, intent);
            pendingStarts++;
            stopRequested = false;
        }
    }

    /**
     * Stopping a service between startForegroundService and its startForeground kills the app
     * (Android 9+), so a pending start is left to stop itself once it reaches the foreground.
     */
    static void end(Context context) {
        synchronized (lock) {
            if (pendingStarts > 0) {
                stopRequested = true;
            } else {
                context.stopService(new Intent(context, CallSessionService.class));
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String roomName = intent != null ? intent.getStringExtra(EXTRA_ROOM_NAME) : null;
        boolean foreground = startForeground(notification(roomName != null ? roomName : ""));
        boolean stop;
        synchronized (lock) {
            pendingStarts = Math.max(0, pendingStarts - 1);
            stop = !foreground || (stopRequested && pendingStarts == 0);
            if (stop && pendingStarts == 0) stopRequested = false;
        }
        if (stop) {
            // Every startForeground attempt failed, so stopping is all that is left; the mediaPlayback
            // fallback needs no permission beyond the manifest's, so this is practically unreachable.
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            // A newer start's id makes this a no-op, so that start still reaches the foreground.
            stopSelf(startId);
        }
        return START_NOT_STICKY;
    }

    /** Tries the granted types, then mediaPlayback, then (before Android 14) no type. */
    private boolean startForeground(Notification notification) {
        int[] attempts = Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE
            ? new int[] { grantedTypes(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK, 0 }
            : new int[] { grantedTypes(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK };
        for (int types : attempts) {
            try {
                ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, types);
                return true;
            } catch (RuntimeException error) {
                // SecurityException or ForegroundServiceStartNotAllowedException: try the next.
            }
        }
        return false;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        end(this);
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
