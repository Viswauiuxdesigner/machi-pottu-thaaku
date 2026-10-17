package us.mediagrid.capacitorjs.plugins.nativeaudio;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import android.content.Context;
import android.content.SharedPreferences;
import android.media.audiofx.BassBoost;
import android.media.audiofx.Equalizer;
import org.json.JSONObject;

public class AudioPlayerService extends MediaSessionService {

    private static final String TAG = "AudioPlayerService";
    public static final String PLAYBACK_CHANNEL_ID = "playback_channel";
    private MediaSession mediaSession = null;
    private static AudioPlayerService instance = null;
    private AudioEffectsManager audioEffectsManager = null;

    public static AudioPlayerService getInstance() {
        return instance;
    }

    public AudioEffectsManager getAudioEffectsManager() {
        return audioEffectsManager;
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null && manager.getNotificationChannel(PLAYBACK_CHANNEL_ID) == null) {
                NotificationChannel playbackChannel = new NotificationChannel(
                    PLAYBACK_CHANNEL_ID,
                    "Audio playback",
                    NotificationManager.IMPORTANCE_LOW
                );
                manager.createNotificationChannel(playbackChannel);
                Log.i(TAG, "Playback notification channel created in AudioPlayerService");
            }
        }
    }

    @Override
    public void onCreate() {
        Log.i(TAG, "Service being created");
        instance = this;
        super.onCreate();
        ensureNotificationChannel();

        String packageName = getApplicationContext().getPackageName();
        Intent sessionActivityIntent = getPackageManager().getLaunchIntentForPackage(packageName);

        PendingIntent sessionActivityPendingIntent = PendingIntent.getActivity(
            this,
            0,
            sessionActivityIntent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        ExoPlayer exoPlayer = new ExoPlayer.Builder(this)
            .setAudioAttributes(
                new AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                true
            )
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build();
        exoPlayer.setPlayWhenReady(false);

        audioEffectsManager = new AudioEffectsManager(this, exoPlayer.getAudioSessionId());
        
        androidx.media3.common.ForwardingPlayer player = new androidx.media3.common.ForwardingPlayer(exoPlayer) {
            @Override
            public androidx.media3.common.Player.Commands getAvailableCommands() {
                return super.getAvailableCommands().buildUpon()
                        .add(androidx.media3.common.Player.COMMAND_SEEK_TO_NEXT)
                        .add(androidx.media3.common.Player.COMMAND_SEEK_TO_PREVIOUS)
                        .add(androidx.media3.common.Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                        .add(androidx.media3.common.Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                        .build();
            }

            @Override
            public boolean isCommandAvailable(int command) {
                if (command == androidx.media3.common.Player.COMMAND_SEEK_TO_NEXT
                        || command == androidx.media3.common.Player.COMMAND_SEEK_TO_PREVIOUS
                        || command == androidx.media3.common.Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM
                        || command == androidx.media3.common.Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM) {
                    return true;
                }
                return super.isCommandAvailable(command);
            }

            @Override
            public boolean hasNextMediaItem() {
                return true;
            }

            @Override
            public boolean hasPreviousMediaItem() {
                return true;
            }

            @Override
            public void seekToNext() {
                triggerNext();
            }

            @Override
            public void seekToNextMediaItem() {
                triggerNext();
            }

            @Override
            public void seekToPrevious() {
                triggerPrevious();
            }

            @Override
            public void seekToPreviousMediaItem() {
                triggerPrevious();
            }

            private void triggerNext() {
                if (getMediaItemCount() > 1 && getCurrentMediaItemIndex() < getMediaItemCount() - 1) {
                    Log.i(TAG, "Native next: advancing to queued media item directly in ExoPlayer");
                    super.seekToNextMediaItem();
                    return;
                }
                Log.i(TAG, "Native next: at edge of buffered playlist, checking master in AudioSource");
                AudioSources audioSources = getAudioSourcesFromMediaSession();
                if (audioSources != null) {
                    AudioSource source = audioSources.forNotification();
                    if (source != null) {
                        if (source.advanceNextInMaster(this)) {
                            return;
                        }
                        source.emitNext();
                    }
                }
            }

            private void triggerPrevious() {
                if (getCurrentMediaItemIndex() > 0) {
                    Log.i(TAG, "Native previous: moving to previous media item directly in ExoPlayer");
                    super.seekToPreviousMediaItem();
                    return;
                }
                Log.i(TAG, "Native previous: at start of buffered playlist, checking master in AudioSource");
                AudioSources audioSources = getAudioSourcesFromMediaSession();
                if (audioSources != null) {
                    AudioSource source = audioSources.forNotification();
                    if (source != null) {
                        if (source.advancePreviousInMaster(this)) {
                            return;
                        }
                        source.emitPrevious();
                    }
                }
            }
        };

        mediaSession = new MediaSession.Builder(this, player)
            .setCallback(new MediaSessionCallback(this))
            .setSessionActivity(sessionActivityPendingIntent)
            .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.i(TAG, "Service starting");

        return super.onStartCommand(intent, flags, startId);
    }

    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    @OptIn(markerClass = UnstableApi.class)
    @Override
    public void onUpdateNotification(MediaSession session, boolean startInForegroundRequired) {
        Player player = session != null ? session.getPlayer() : null;
        if (player != null && (player.getPlayWhenReady() || player.isPlaying())) {
            startInForegroundRequired = true;
        } else {
            AudioSources audioSources = getAudioSourcesFromMediaSession();
            if (audioSources != null) {
                AudioSource source = audioSources.forNotification();
                if (source != null && (source.isTransitioning() || source.isPlaying())) {
                    startInForegroundRequired = true;
                }
            }
        }

        try {
            super.onUpdateNotification(session, startInForegroundRequired);
        } catch (Exception e) {
            Log.w(TAG, "Error updating notification in foreground", e);
        }
    }

    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        Log.i(TAG, "Task removed");

        AudioSources audioSources = getAudioSourcesFromMediaSession();

        if (audioSources != null) {
            Log.i(TAG, "Destroying all non-notification audio sources");
            audioSources.destroyAllNonNotificationSources();
        }

        Player player = mediaSession.getPlayer();

        // Make sure the service is not in foreground
        if (player.getPlayWhenReady()) {
            player.pause();
        }

        stopSelf();
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "Service being destroyed");

        AudioSources audioSources = getAudioSourcesFromMediaSession();

        if (audioSources != null) {
            Log.i(TAG, "Destroying all non-notification audio sources");
            audioSources.destroyAllNonNotificationSources();
        }

        if (audioEffectsManager != null) {
            audioEffectsManager.release();
            audioEffectsManager = null;
        }

        if (instance == this) {
            instance = null;
        }

        mediaSession.getPlayer().release();
        mediaSession.release();
        mediaSession = null;

        super.onDestroy();
    }

    @OptIn(markerClass = UnstableApi.class)
    private AudioSources getAudioSourcesFromMediaSession() {
        IBinder sourcesBinder = mediaSession.getSessionExtras().getBinder("audioSources");

        if (sourcesBinder != null) {
            return (AudioSources) sourcesBinder;
        }

        return null;
    }

    public static class AudioEffectsManager {
        private static final String TAG = "AudioEffectsManager";
        private static final String PREFS_NAME = "MPT_AudioEffects";

        private final Context context;
        private Equalizer equalizer;
        private BassBoost bassBoost;
        private int currentSessionId = 0;
        private boolean isAvailable = false;

        // Normalized slider values (0 to 100, default 50)
        private int bassValue = 50;
        private int midValue = 50;
        private int trebleValue = 50;
        private boolean isEnabled = true;

        public AudioEffectsManager(Context context, int audioSessionId) {
            this.context = context.getApplicationContext();
            loadPreferences();
            attachToSession(audioSessionId);
        }

        public synchronized void attachToSession(int audioSessionId) {
            if (audioSessionId <= 0) {
                Log.w(TAG, "Cannot attach to invalid audio session ID: " + audioSessionId);
                return;
            }
            if (currentSessionId == audioSessionId && isAvailable) {
                return;
            }

            release();
            this.currentSessionId = audioSessionId;

            try {
                equalizer = new Equalizer(0, audioSessionId);
                bassBoost = new BassBoost(0, audioSessionId);

                equalizer.setEnabled(isEnabled);
                bassBoost.setEnabled(isEnabled);
                isAvailable = true;

                applySettings();
                Log.i(TAG, "AudioEffects successfully attached to session " + audioSessionId);
            } catch (Exception e) {
                Log.e(TAG, "AudioEffects initialization failed on session " + audioSessionId + ": " + e.getMessage());
                isAvailable = false;
                release();
            }
        }

        public synchronized void setBandLevels(int bass, int mid, int treble) {
            this.bassValue = Math.max(0, Math.min(100, bass));
            this.midValue = Math.max(0, Math.min(100, mid));
            this.trebleValue = Math.max(0, Math.min(100, treble));
            savePreferences();
            applySettings();
        }

        public synchronized void setEnabled(boolean enabled) {
            this.isEnabled = enabled;
            savePreferences();
            if (isAvailable) {
                try {
                    if (equalizer != null) equalizer.setEnabled(enabled);
                    if (bassBoost != null) bassBoost.setEnabled(enabled);
                } catch (Exception e) {
                    Log.w(TAG, "Error toggling effects enabled", e);
                }
            }
        }

        private void applySettings() {
            if (!isAvailable || equalizer == null) return;
            try {
                short numBands = equalizer.getNumberOfBands();
                if (numBands <= 0) return;

                short[] bandRange = equalizer.getBandLevelRange(); // e.g., -1500 to +1500 mB
                short minLevel = bandRange[0];
                short maxLevel = bandRange[1];

                // Map 0..100 to minLevel..maxLevel
                short bassLevel = (short) (minLevel + (maxLevel - minLevel) * (bassValue / 100.0f));
                short midLevel = (short) (minLevel + (maxLevel - minLevel) * (midValue / 100.0f));
                short trebleLevel = (short) (minLevel + (maxLevel - minLevel) * (trebleValue / 100.0f));

                // Band 0 is Bass
                equalizer.setBandLevel((short) 0, bassLevel);

                // Middle band is Mid
                short midBand = (short) (numBands / 2);
                equalizer.setBandLevel(midBand, midLevel);

                // Highest band is Treble
                short trebleBand = (short) (numBands - 1);
                equalizer.setBandLevel(trebleBand, trebleLevel);

                // BassBoost effect: strength 0..1000
                if (bassBoost != null && bassBoost.getStrengthSupported()) {
                    short boostStrength = (short) (bassValue * 10); // 0 to 1000
                    bassBoost.setStrength(boostStrength);
                }
            } catch (Exception e) {
                Log.w(TAG, "Error applying audio effect settings", e);
            }
        }

        public synchronized JSONObject getStatus() {
            JSONObject obj = new JSONObject();
            try {
                obj.put("isAvailable", isAvailable);
                obj.put("isEnabled", isEnabled);
                obj.put("bass", bassValue);
                obj.put("mid", midValue);
                obj.put("treble", trebleValue);
                if (isAvailable && equalizer != null) {
                    obj.put("numBands", equalizer.getNumberOfBands());
                }
            } catch (Exception ignored) {}
            return obj;
        }

        private void loadPreferences() {
            try {
                SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                bassValue = prefs.getInt("bass", 50);
                midValue = prefs.getInt("mid", 50);
                trebleValue = prefs.getInt("treble", 50);
                isEnabled = prefs.getBoolean("enabled", true);
            } catch (Exception ignored) {}
        }

        private void savePreferences() {
            try {
                SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit()
                    .putInt("bass", bassValue)
                    .putInt("mid", midValue)
                    .putInt("treble", trebleValue)
                    .putBoolean("enabled", isEnabled)
                    .apply();
            } catch (Exception ignored) {}
        }

        public synchronized void release() {
            if (equalizer != null) {
                try { equalizer.release(); } catch (Exception ignored) {}
                equalizer = null;
            }
            if (bassBoost != null) {
                try { bassBoost.release(); } catch (Exception ignored) {}
                bassBoost = null;
            }
            isAvailable = false;
        }
    }
}
