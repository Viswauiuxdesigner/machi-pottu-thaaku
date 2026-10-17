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
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.audiofx.AudioEffect;
import android.media.audiofx.BassBoost;
import android.media.audiofx.Equalizer;
import android.media.audiofx.PresetReverb;
import android.media.audiofx.Virtualizer;
import org.json.JSONObject;

public class AudioPlayerService extends MediaSessionService {

    private static final String TAG = "AudioPlayerService";
    public static final String PLAYBACK_CHANNEL_ID = "playback_channel";
    private MediaSession mediaSession = null;
    private static AudioPlayerService instance = null;
    private AudioEffectsManager audioEffectsManager = null;
    private ExoPlayer exoPlayer = null;

    public static AudioPlayerService getInstance() {
        return instance;
    }

    public AudioEffectsManager getAudioEffectsManager() {
        if (audioEffectsManager != null && exoPlayer != null) {
            try {
                int sid = exoPlayer.getAudioSessionId();
                if (sid > 0 && (!audioEffectsManager.isAvailable() || audioEffectsManager.getCurrentSessionId() != sid)) {
                    Log.i(TAG, "Attaching audio effects in getAudioEffectsManager to session: " + sid);
                    audioEffectsManager.attachToSession(sid);
                }
            } catch (Exception e) {
                Log.w(TAG, "Could not query audioSessionId in getAudioEffectsManager", e);
            }
        }
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

        exoPlayer = new ExoPlayer.Builder(this)
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

        exoPlayer.addAnalyticsListener(new AnalyticsListener() {
            @Override
            public void onAudioSessionIdChanged(EventTime eventTime, int audioSessionId) {
                Log.i(TAG, "AnalyticsListener onAudioSessionIdChanged: " + audioSessionId);
                if (audioEffectsManager != null && audioSessionId > 0) {
                    audioEffectsManager.attachToSession(audioSessionId);
                }
            }
        });

        exoPlayer.addListener(new androidx.media3.common.Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (audioEffectsManager != null && exoPlayer != null) {
                    try {
                        int sid = exoPlayer.getAudioSessionId();
                        if (sid > 0 && (!audioEffectsManager.isAvailable() || audioEffectsManager.getCurrentSessionId() != sid)) {
                            Log.i(TAG, "Attaching audio effects on playback state change to session: " + sid);
                            audioEffectsManager.attachToSession(sid);
                        }
                    } catch (Exception e) {
                        Log.w(TAG, "Error checking audio session ID on playback state change", e);
                    }
                }
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                if (isPlaying && audioEffectsManager != null && exoPlayer != null) {
                    try {
                        int sid = exoPlayer.getAudioSessionId();
                        if (sid > 0 && (!audioEffectsManager.isAvailable() || audioEffectsManager.getCurrentSessionId() != sid)) {
                            Log.i(TAG, "Attaching audio effects on isPlaying change to session: " + sid);
                            audioEffectsManager.attachToSession(sid);
                        }
                    } catch (Exception e) {
                        Log.w(TAG, "Error checking audio session ID on isPlaying change", e);
                    }
                }
            }
        });
        
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

        if (exoPlayer != null) {
            exoPlayer = null;
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
        private Virtualizer virtualizer;
        private PresetReverb presetReverb;
        private int currentSessionId = 0;
        private boolean isAvailable = false;

        // Normalized equalizer values (0 to 100, default 50)
        private int bassValue = 50;
        private int midValue = 50;
        private int trebleValue = 50;
        private boolean isEnabled = true;

        // 360 Spatial Audio settings
        private boolean spatialEnabled = false;
        private int spatialIntensity = 75; // 0..100
        private int spatialWidth = 80;     // 0..100
        private int spatialDistance = 40;  // 0..100
        private int spatialAzimuth = 0;    // 0..360 (degrees around listener)

        public AudioEffectsManager(Context context, int audioSessionId) {
            this.context = context.getApplicationContext();
            loadPreferences();
            if (audioSessionId > 0) {
                attachToSession(audioSessionId);
            }
        }

        public synchronized boolean isAvailable() {
            return isAvailable;
        }

        public synchronized int getCurrentSessionId() {
            return currentSessionId;
        }

        public synchronized void attachToSession(int audioSessionId) {
            if (audioSessionId <= 0) {
                Log.w(TAG, "Cannot attach to invalid audio session ID: " + audioSessionId);
                return;
            }
            if (currentSessionId == audioSessionId && isAvailable && equalizer != null) {
                applySettings();
                applySpatialSettings();
                return;
            }

            release();
            this.currentSessionId = audioSessionId;

            try {
                // Broadcast ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION
                try {
                    Intent intent = new Intent(AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION);
                    intent.putExtra(AudioEffect.EXTRA_AUDIO_SESSION, audioSessionId);
                    intent.putExtra(AudioEffect.EXTRA_PACKAGE_NAME, context.getPackageName());
                    context.sendBroadcast(intent);
                } catch (Exception e) {
                    Log.w(TAG, "Failed to broadcast ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION", e);
                }

                // Priority 1000 ensures this application effect has priority control
                equalizer = new Equalizer(1000, audioSessionId);
                boolean eqControl = equalizer.hasControl();
                short numBands = equalizer.getNumberOfBands();
                short[] bandRange = equalizer.getBandLevelRange();
                Log.i(TAG, "Equalizer created on session " + audioSessionId + ": control=" + eqControl + ", bands=" + numBands + ", range=[" + bandRange[0] + ", " + bandRange[1] + "] mB");

                for (short b = 0; b < numBands; b++) {
                    try {
                        Log.i(TAG, "Equalizer band " + b + ": centerFreq=" + (equalizer.getCenterFreq(b) / 1000) + " Hz");
                    } catch (Exception ignored) {}
                }

                equalizer.setControlStatusListener((effect, controlGranted) -> {
                    Log.i(TAG, "Equalizer control status changed: granted=" + controlGranted);
                    if (controlGranted) {
                        applySettings();
                    }
                });

                try {
                    bassBoost = new BassBoost(1000, audioSessionId);
                    Log.i(TAG, "BassBoost created on session " + audioSessionId + ": control=" + bassBoost.hasControl() + ", strengthSupported=" + bassBoost.getStrengthSupported());
                    bassBoost.setControlStatusListener((effect, controlGranted) -> {
                        Log.i(TAG, "BassBoost control status changed: granted=" + controlGranted);
                        if (controlGranted) {
                            applySettings();
                        }
                    });
                } catch (Exception e) {
                    Log.w(TAG, "BassBoost unsupported on device: " + e.getMessage());
                    bassBoost = null;
                }

                try {
                    virtualizer = new Virtualizer(1000, audioSessionId);
                    Log.i(TAG, "Virtualizer created on session " + audioSessionId + ": control=" + virtualizer.hasControl() + ", strengthSupported=" + virtualizer.getStrengthSupported());

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        try {
                            boolean canBinaural = virtualizer.canVirtualize(AudioFormat.CHANNEL_OUT_STEREO, Virtualizer.VIRTUALIZATION_MODE_BINAURAL);
                            Log.i(TAG, "Virtualizer canVirtualize BINAURAL: " + canBinaural);
                            if (canBinaural) {
                                virtualizer.forceVirtualizationMode(Virtualizer.VIRTUALIZATION_MODE_BINAURAL);
                            }
                        } catch (Exception be) {
                            Log.w(TAG, "Virtualizer forceVirtualizationMode failed: " + be.getMessage());
                        }
                    }

                    virtualizer.setControlStatusListener((effect, controlGranted) -> {
                        Log.i(TAG, "Virtualizer control status changed: granted=" + controlGranted);
                        if (controlGranted) {
                            applySpatialSettings();
                        }
                    });
                } catch (Exception e) {
                    Log.w(TAG, "Virtualizer unsupported on session " + audioSessionId + ": " + e.getMessage());
                    virtualizer = null;
                }

                try {
                    presetReverb = new PresetReverb(1000, audioSessionId);
                    Log.i(TAG, "PresetReverb created on session " + audioSessionId + ": control=" + presetReverb.hasControl());
                    presetReverb.setControlStatusListener((effect, controlGranted) -> {
                        Log.i(TAG, "PresetReverb control status changed: granted=" + controlGranted);
                        if (controlGranted) {
                            applySpatialSettings();
                        }
                    });
                } catch (Exception e) {
                    Log.w(TAG, "PresetReverb unsupported on session " + audioSessionId + ": " + e.getMessage());
                    presetReverb = null;
                }

                equalizer.setEnabled(isEnabled);
                if (bassBoost != null) {
                    bassBoost.setEnabled(isEnabled);
                }
                isAvailable = true;

                applySettings();
                applySpatialSettings();
                Log.i(TAG, "AudioEffects successfully attached and configured on session " + audioSessionId);
            } catch (Exception e) {
                Log.e(TAG, "AudioEffects initialization failed on session " + audioSessionId + ": " + e.getMessage(), e);
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
                    if (enabled) {
                        applySettings();
                    }
                } catch (Exception e) {
                    Log.w(TAG, "Error toggling effects enabled", e);
                }
            }
        }

        public synchronized void setSpatialParams(boolean enabled, int intensity, int width, int distance, int azimuth) {
            this.spatialEnabled = enabled;
            this.spatialIntensity = Math.max(0, Math.min(100, intensity));
            this.spatialWidth = Math.max(0, Math.min(100, width));
            this.spatialDistance = Math.max(0, Math.min(100, distance));
            this.spatialAzimuth = ((azimuth % 360) + 360) % 360;
            savePreferences();
            applySpatialSettings();
        }

        public synchronized void setSpatialEnabled(boolean enabled) {
            this.spatialEnabled = enabled;
            savePreferences();
            applySpatialSettings();
        }

        private void applySettings() {
            if (!isAvailable || equalizer == null) {
                Log.d(TAG, "applySettings skipped: isAvailable=" + isAvailable + ", equalizer=" + (equalizer != null));
                return;
            }
            try {
                if (!isEnabled) {
                    equalizer.setEnabled(false);
                    if (bassBoost != null) {
                        bassBoost.setEnabled(false);
                    }
                    Log.i(TAG, "Equalizer and BassBoost disabled (bypassed)");
                    return;
                }

                equalizer.setEnabled(true);
                if (bassBoost != null) {
                    bassBoost.setEnabled(true);
                }

                short numBands = equalizer.getNumberOfBands();
                if (numBands <= 0) return;

                short[] bandRange = equalizer.getBandLevelRange(); // e.g., -1500 to +1500 mB
                short minLevel = bandRange[0];
                short maxLevel = bandRange[1];

                // Calculate target gains in millibels (50 is 0 mB flat)
                short bassGain = calcGain(bassValue, minLevel, maxLevel);
                short midGain = calcGain(midValue, minLevel, maxLevel);
                short trebleGain = calcGain(trebleValue, minLevel, maxLevel);

                // Map each hardware band to its acoustic role based on real center frequency
                for (short i = 0; i < numBands; i++) {
                    short targetLevel;
                    int freqHz = -1;
                    try {
                        freqHz = equalizer.getCenterFreq(i) / 1000;
                    } catch (Exception ignored) {}

                    if (freqHz > 0) {
                        if (freqHz < 350) {
                            // Sub-bass and bass (< 350 Hz): e.g. 60Hz, 230Hz
                            targetLevel = bassGain;
                        } else if (freqHz <= 2500) {
                            // Midrange / Vocals (350Hz - 2.5kHz): e.g. 910Hz, 1kHz
                            targetLevel = midGain;
                        } else {
                            // Highs / Treble (> 2.5kHz): e.g. 3.6kHz, 4kHz, 14kHz
                            targetLevel = trebleGain;
                        }
                    } else {
                        // Positional fallback if getCenterFreq is unavailable
                        if (numBands == 5) {
                            if (i <= 1) targetLevel = bassGain;
                            else if (i == 2) targetLevel = midGain;
                            else targetLevel = trebleGain;
                        } else {
                            if (i < numBands / 3) {
                                targetLevel = bassGain;
                            } else if (i < (2 * numBands) / 3) {
                                targetLevel = midGain;
                            } else {
                                targetLevel = trebleGain;
                            }
                        }
                    }

                    // Clamp to device band range
                    if (targetLevel < minLevel) targetLevel = minLevel;
                    if (targetLevel > maxLevel) targetLevel = maxLevel;

                    equalizer.setBandLevel(i, targetLevel);
                    Log.d(TAG, "Band " + i + " (" + (freqHz > 0 ? freqHz + "Hz" : "pos " + i) + ") set to " + targetLevel + " mB");
                }

                // BassBoost hardware effect
                if (bassBoost != null && bassBoost.getStrengthSupported()) {
                    short boostStrength = (short) Math.min(1000, Math.max(0, (bassValue - 50) * 20));
                    bassBoost.setStrength(boostStrength);
                    Log.d(TAG, "BassBoost strength set to " + boostStrength);
                }
            } catch (Exception e) {
                Log.w(TAG, "Error applying audio effect settings", e);
            }
        }

        private void applySpatialSettings() {
            if (!isAvailable) {
                Log.d(TAG, "applySpatialSettings skipped: isAvailable=false");
                return;
            }
            try {
                if (virtualizer != null) {
                    virtualizer.setEnabled(spatialEnabled);
                    if (spatialEnabled && virtualizer.getStrengthSupported()) {
                        int effectiveStrength = (int) Math.round((spatialIntensity / 100.0f) * (spatialWidth / 100.0f) * 1000.0f);
                        effectiveStrength = Math.max(0, Math.min(1000, effectiveStrength));
                        virtualizer.setStrength((short) effectiveStrength);
                        Log.d(TAG, "Virtualizer strength set to " + effectiveStrength);
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Error applying virtualizer settings", e);
            }

            try {
                if (presetReverb != null) {
                    if (!spatialEnabled || spatialDistance <= 10) {
                        presetReverb.setEnabled(false);
                        presetReverb.setPreset(PresetReverb.PRESET_NONE);
                    } else {
                        presetReverb.setEnabled(true);
                        short preset;
                        if (spatialDistance < 40) {
                            preset = PresetReverb.PRESET_SMALLROOM;
                        } else if (spatialDistance < 70) {
                            preset = PresetReverb.PRESET_MEDIUMHALL;
                        } else {
                            preset = PresetReverb.PRESET_LARGEHALL;
                        }
                        presetReverb.setPreset(preset);
                        Log.d(TAG, "PresetReverb preset set to " + preset);
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Error applying presetReverb settings", e);
            }
        }

        private static short calcGain(int sliderVal, short minLevel, short maxLevel) {
            if (sliderVal == 50) return 0;
            if (sliderVal > 50) {
                return (short) Math.round(((sliderVal - 50) / 50.0f) * maxLevel);
            } else {
                return (short) Math.round(((50 - sliderVal) / 50.0f) * minLevel);
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
                obj.put("sessionId", currentSessionId);
                if (isAvailable && equalizer != null) {
                    obj.put("numBands", equalizer.getNumberOfBands());
                    obj.put("hasControl", equalizer.hasControl());
                    obj.put("effectEnabled", equalizer.getEnabled());
                    short[] range = equalizer.getBandLevelRange();
                    obj.put("minBandLevel", range[0]);
                    obj.put("maxBandLevel", range[1]);
                }
                if (bassBoost != null) {
                    obj.put("bassBoostSupported", bassBoost.getStrengthSupported());
                    obj.put("bassBoostHasControl", bassBoost.hasControl());
                    obj.put("bassBoostEnabled", bassBoost.getEnabled());
                    if (bassBoost.getStrengthSupported()) {
                        obj.put("bassBoostStrength", bassBoost.getRoundedStrength());
                    }
                }

                // Spatial Audio Telemetry
                obj.put("spatialEnabled", spatialEnabled);
                obj.put("spatialIntensity", spatialIntensity);
                obj.put("spatialWidth", spatialWidth);
                obj.put("spatialDistance", spatialDistance);
                obj.put("spatialAzimuth", spatialAzimuth);
                if (virtualizer != null) {
                    obj.put("virtualizerSupported", virtualizer.getStrengthSupported());
                    obj.put("virtualizerHasControl", virtualizer.hasControl());
                    obj.put("virtualizerEnabled", virtualizer.getEnabled());
                    if (virtualizer.getStrengthSupported()) {
                        obj.put("virtualizerStrength", virtualizer.getRoundedStrength());
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        try {
                            obj.put("virtualizerMode", virtualizer.getVirtualizationMode());
                        } catch (Exception ignored) {}
                    }
                }
                if (presetReverb != null) {
                    obj.put("presetReverbHasControl", presetReverb.hasControl());
                    obj.put("presetReverbEnabled", presetReverb.getEnabled());
                    try {
                        obj.put("presetReverbPreset", presetReverb.getPreset());
                    } catch (Exception ignored) {}
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    try {
                        AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
                        if (am != null) {
                            android.media.Spatializer s = am.getSpatializer();
                            obj.put("platformSpatializerAvailable", s.isAvailable());
                            obj.put("platformSpatializerEnabled", s.isEnabled());
                            obj.put("platformHeadTrackerAvailable", s.isHeadTrackerAvailable());
                        }
                    } catch (Exception ignored) {}
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

                spatialEnabled = prefs.getBoolean("spatial_enabled", false);
                spatialIntensity = prefs.getInt("spatial_intensity", 75);
                spatialWidth = prefs.getInt("spatial_width", 80);
                spatialDistance = prefs.getInt("spatial_distance", 40);
                spatialAzimuth = prefs.getInt("spatial_azimuth", 0);
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
                    .putBoolean("spatial_enabled", spatialEnabled)
                    .putInt("spatial_intensity", spatialIntensity)
                    .putInt("spatial_width", spatialWidth)
                    .putInt("spatial_distance", spatialDistance)
                    .putInt("spatial_azimuth", spatialAzimuth)
                    .apply();
            } catch (Exception ignored) {}
        }

        public synchronized void release() {
            if (currentSessionId > 0) {
                try {
                    Intent closeIntent = new Intent(AudioEffect.ACTION_CLOSE_AUDIO_EFFECT_CONTROL_SESSION);
                    closeIntent.putExtra(AudioEffect.EXTRA_AUDIO_SESSION, currentSessionId);
                    closeIntent.putExtra(AudioEffect.EXTRA_PACKAGE_NAME, context.getPackageName());
                    context.sendBroadcast(closeIntent);
                } catch (Exception be) {
                    Log.w(TAG, "Failed to broadcast ACTION_CLOSE_AUDIO_EFFECT_CONTROL_SESSION", be);
                }
            }
            if (equalizer != null) {
                try { equalizer.release(); } catch (Exception ignored) {}
                equalizer = null;
            }
            if (bassBoost != null) {
                try { bassBoost.release(); } catch (Exception ignored) {}
                bassBoost = null;
            }
            if (virtualizer != null) {
                try { virtualizer.release(); } catch (Exception ignored) {}
                virtualizer = null;
            }
            if (presetReverb != null) {
                try { presetReverb.release(); } catch (Exception ignored) {}
                presetReverb = null;
            }
            isAvailable = false;
        }
    }
}
