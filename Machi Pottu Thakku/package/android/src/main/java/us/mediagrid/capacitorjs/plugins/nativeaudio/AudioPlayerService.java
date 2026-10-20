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
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.RenderersFactory;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
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
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;

public class AudioPlayerService extends MediaSessionService {

    private static final String TAG = "AudioPlayerService";
    public static final String PLAYBACK_CHANNEL_ID = "playback_channel";
    private MediaSession mediaSession = null;
    private static AudioPlayerService instance = null;
    private AudioEffectsManager audioEffectsManager = null;
    private SpatialAudioProcessor spatialAudioProcessor = null;
    private ExoPlayer exoPlayer = null;

    public static AudioPlayerService getInstance() {
        return instance;
    }

    public SpatialAudioProcessor getSpatialAudioProcessor() {
        return spatialAudioProcessor;
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

        spatialAudioProcessor = new SpatialAudioProcessor(this);

        RenderersFactory renderersFactory = new DefaultRenderersFactory(this) {
            @Nullable
            @Override
            protected AudioSink buildAudioSink(
                Context context,
                boolean enableFloatOutput,
                boolean enableAudioTrackPlaybackParams) {
                return new DefaultAudioSink.Builder(context)
                    .setEnableFloatOutput(enableFloatOutput)
                    .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                    .setAudioProcessors(new AudioProcessor[] { spatialAudioProcessor })
                    .build();
            }
        };

        exoPlayer = new ExoPlayer.Builder(this, renderersFactory)
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

        if (spatialAudioProcessor != null) {
            spatialAudioProcessor.reset();
            spatialAudioProcessor = null;
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
            // Processing is handled authoritatively by SpatialAudioProcessor (Native PCM Biquad EQ)
            // to ensure uninterrupted playback with screen off and across track changes without double-filtering.
            if (equalizer != null) {
                try {
                    equalizer.setEnabled(false);
                } catch (Exception ignored) {}
            }
            if (bassBoost != null) {
                try {
                    bassBoost.setEnabled(false);
                } catch (Exception ignored) {}
            }
        }

        private void applySpatialSettings() {
            // Processing is handled authoritatively by SpatialAudioProcessor in ExoPlayer PCM chain
            if (virtualizer != null) {
                try {
                    virtualizer.setEnabled(false);
                } catch (Exception ignored) {}
            }
            if (presetReverb != null) {
                try {
                    presetReverb.setEnabled(false);
                } catch (Exception ignored) {}
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

    /**
     * Real-time 360° Spatial Audio Processor for ExoPlayer.
     *
     * Implements binaural headphone spatialization directly in ExoPlayer's PCM audio pipeline:
     * 1. Multi-format PCM negotiation: Supports standard PCM 16-bit and PCM Float (32-bit), with
     *    automatic mono-to-stereo upmixing and safe non-destructive bypass for unsupported encodings.
     * 2. Mid/Side (M/S) Matrix Stereo Field Widening (0% mono to 220% ultra-wide).
     * 3. 360° Horizontal Azimuth Panning with Interaural Time Difference (ITD delay line up to ~0.75ms)
     *    and Interaural Level Difference (ILD constant-power panning).
     * 4. Contralateral Head Shadowing (1-pole IIR low-pass filter on the shaded ear).
     * 5. Front vs. Rear Pinna Simulation (high-frequency attenuation when sound source is behind).
     * 6. Distance Simulation (acoustic air absorption low-pass rolloff + early room reflections).
     * 7. Complete lifecycle clearing in flush() and reset() to prevent seek/track bleed.
     * 8. True Wet/Dry Intensity Crossfade and Polynomial Soft-Knee Anti-Clipping Limiter.
     */
    @OptIn(markerClass = UnstableApi.class)
    public static class SpatialAudioProcessor implements AudioProcessor {

        private static final String TAG = "SpatialAudioProcessor";
        private static final String PREFS_NAME = "MPT_AudioEffects";

        // Audio format tracking
        private AudioProcessor.AudioFormat inputAudioFormat;
        private AudioProcessor.AudioFormat outputAudioFormat;

        // Buffer management
        private ByteBuffer buffer;
        private ByteBuffer outputBuffer;
        private boolean inputEnded;

        // Thread-safe Spatial Audio parameters (0..100 or 0..360)
        private volatile boolean spatialEnabled = false;
        private volatile int intensity = 75; // 0..100
        private volatile int width = 80;     // 0..100
        private volatile int distance = 40;  // 0..100
        private volatile int azimuth = 0;    // 0..360 degrees
        private volatile boolean autoOrbit = false;
        private double fractionalAzimuth = 0.0;

        // 3-Band Parametric Biquad Equalizer Parameters (0..100, 50 = flat 0dB)
        private volatile boolean eqEnabled = true;
        private volatile int bassLevel = 50;
        private volatile int midLevel = 50;
        private volatile int trebleLevel = 50;

        // Biquad filter state for Direct Form II Transposed:
        // [band 0..2][channel 0..1][delay d1, d2]
        // Band 0: Bass (Low-shelf @ 100 Hz, Q = 0.707)
        // Band 1: Midrange (Peaking @ 1000 Hz, Q = 1.0)
        // Band 2: Treble (High-shelf @ 8000 Hz, Q = 0.707)
        private final float[][][] eqState = new float[3][2][2];
        private final float[][] eqCoeffs = new float[3][5];
        private volatile boolean eqCoeffsDirty = true;
        private float lastSampleRate = 48000.0f;

        // Telemetry: track processed sample frames
        private volatile long processedFramesTotal = 0;
        private volatile boolean isAttachedToSink = false;

        // Circular delay lines for ITD (Interaural Time Difference)
        // At 48 kHz, 1 ms = 48 samples. Maximum human head delay ~0.75 ms (~36 samples).
        private static final int ITD_BUFFER_SIZE = 64;
        private final float[] delayLineL = new float[ITD_BUFFER_SIZE];
        private final float[] delayLineR = new float[ITD_BUFFER_SIZE];
        private int itdWriteIndex = 0;

        // Filter states for Head Shadow (contralateral low-pass)
        private float shadowFilterL = 0.0f;
        private float shadowFilterR = 0.0f;

        // Filter states for Rear Pinna Shadow
        private float rearFilterL = 0.0f;
        private float rearFilterR = 0.0f;

        // Filter states for Air Absorption
        private float airFilterL = 0.0f;
        private float airFilterR = 0.0f;

        // Multi-tap early reflection room depth delay line
        // ~40ms at 48 kHz is ~1920 samples. 2048 is a safe power-of-two circular buffer.
        private static final int REVERB_BUFFER_SIZE = 2048;
        private final float[] roomDelayL = new float[REVERB_BUFFER_SIZE];
        private final float[] roomDelayR = new float[REVERB_BUFFER_SIZE];
        private int roomWriteIndex = 0;

        public SpatialAudioProcessor(Context context) {
            this.inputAudioFormat = AudioProcessor.AudioFormat.NOT_SET;
            this.outputAudioFormat = AudioProcessor.AudioFormat.NOT_SET;
            this.buffer = EMPTY_BUFFER;
            this.outputBuffer = EMPTY_BUFFER;
            loadPreferences(context);
        }

        public synchronized void setParams(boolean enabled, int intensity, int width, int distance, int azimuth) {
            this.spatialEnabled = enabled;
            this.intensity = Math.max(0, Math.min(100, intensity));
            this.width = Math.max(0, Math.min(100, width));
            this.distance = Math.max(0, Math.min(100, distance));
            this.azimuth = ((azimuth % 360) + 360) % 360;
            this.fractionalAzimuth = this.azimuth;
        }

        public synchronized void setEnabled(boolean enabled) {
            this.spatialEnabled = enabled;
        }

        public synchronized void setAutoOrbit(boolean autoOrbit) {
            this.autoOrbit = autoOrbit;
        }

        public synchronized void setEqualizerParams(boolean enabled, int bass, int mid, int treble) {
            this.eqEnabled = enabled;
            this.bassLevel = Math.max(0, Math.min(100, bass));
            this.midLevel = Math.max(0, Math.min(100, mid));
            this.trebleLevel = Math.max(0, Math.min(100, treble));
            this.eqCoeffsDirty = true;
        }

        public synchronized void setEqualizerEnabled(boolean enabled) {
            this.eqEnabled = enabled;
        }

        public JSONObject getEqualizerStatus() {
            JSONObject obj = new JSONObject();
            try {
                obj.put("isAvailable", true);
                obj.put("enabled", eqEnabled);
                obj.put("bass", bassLevel);
                obj.put("mid", midLevel);
                obj.put("treble", trebleLevel);
                obj.put("numBands", 3);
                obj.put("hasControl", true);
                obj.put("mode", "ExoPlayer Native PCM 3-Band Biquad EQ (Screen-off Resilient)");
            } catch (Exception ignored) {}
            return obj;
        }

        public synchronized void savePreferences(Context context) {
            try {
                SharedPreferences prefs = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit()
                    .putBoolean("spatial_enabled", spatialEnabled)
                    .putInt("spatial_intensity", intensity)
                    .putInt("spatial_width", width)
                    .putInt("spatial_distance", distance)
                    .putInt("spatial_azimuth", azimuth)
                    .putBoolean("spatial_auto_orbit", autoOrbit)
                    .putBoolean("eq_enabled", eqEnabled)
                    .putInt("eq_bass", bassLevel)
                    .putInt("eq_mid", midLevel)
                    .putInt("eq_treble", trebleLevel)
                    .apply();
            } catch (Exception ignored) {}
        }

        private void loadPreferences(Context context) {
            try {
                SharedPreferences prefs = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                spatialEnabled = prefs.getBoolean("spatial_enabled", false);
                intensity = prefs.getInt("spatial_intensity", 75);
                width = prefs.getInt("spatial_width", 80);
                distance = prefs.getInt("spatial_distance", 40);
                azimuth = prefs.getInt("spatial_azimuth", 0);
                fractionalAzimuth = azimuth;
                autoOrbit = prefs.getBoolean("spatial_auto_orbit", false);
                eqEnabled = prefs.getBoolean("eq_enabled", true);
                bassLevel = prefs.getInt("eq_bass", 50);
                midLevel = prefs.getInt("eq_mid", 50);
                trebleLevel = prefs.getInt("eq_treble", 50);
                eqCoeffsDirty = true;
            } catch (Exception ignored) {}
        }

        public JSONObject getStatus() {
            JSONObject obj = new JSONObject();
            try {
                boolean active = isActive();
                obj.put("processorActive", active);
                obj.put("isAttachedToSink", isAttachedToSink);
                obj.put("spatialEnabled", spatialEnabled);
                obj.put("spatialIntensity", intensity);
                obj.put("spatialWidth", width);
                obj.put("spatialDistance", distance);
                obj.put("spatialAzimuth", azimuth);
                obj.put("autoOrbit", autoOrbit);
                obj.put("eqEnabled", eqEnabled);
                obj.put("eqBass", bassLevel);
                obj.put("eqMid", midLevel);
                obj.put("eqTreble", trebleLevel);
                obj.put("processedFramesTotal", processedFramesTotal);
                obj.put("sampleRate", (inputAudioFormat != null) ? inputAudioFormat.sampleRate : 0);
                obj.put("channelCount", (inputAudioFormat != null) ? inputAudioFormat.channelCount : 0);
                obj.put("encoding", (inputAudioFormat != null) ?
                    (inputAudioFormat.encoding == C.ENCODING_PCM_16BIT ? "PCM_16BIT" :
                     (inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT ? "PCM_FLOAT" : "OTHER")) : "NONE");
                obj.put("isBypassed", (!spatialEnabled || intensity <= 0) && (!eqEnabled || (bassLevel == 50 && midLevel == 50 && trebleLevel == 50)));
                obj.put("mode", "ExoPlayer Custom DSP Engine (PCM Biquad EQ + Binaural ITD/ILD)");
            } catch (Exception ignored) {}
            return obj;
        }

        private void updateEqCoefficients(float sampleRate) {
            if (sampleRate <= 0) sampleRate = 48000.0f;
            lastSampleRate = sampleRate;

            // 1. Bass (Low Shelf at 100 Hz, Q = 0.707)
            float bassGainDb = (bassLevel - 50) * 0.24f; // -12dB .. +12dB
            computeLowShelfCoeffs(100.0f, bassGainDb, sampleRate, eqCoeffs[0]);

            // 2. Midrange (Peaking at 1000 Hz, Q = 1.0)
            float midGainDb = (midLevel - 50) * 0.24f; // -12dB .. +12dB
            computePeakingCoeffs(1000.0f, 1.0f, midGainDb, sampleRate, eqCoeffs[1]);

            // 3. Treble (High Shelf at 8000 Hz, Q = 0.707)
            float trebleGainDb = (trebleLevel - 50) * 0.24f; // -12dB .. +12dB
            computeHighShelfCoeffs(8000.0f, trebleGainDb, sampleRate, eqCoeffs[2]);

            eqCoeffsDirty = false;
        }

        private static void computeLowShelfCoeffs(float f0, float gainDb, float Fs, float[] out) {
            if (Math.abs(gainDb) < 0.05f) {
                out[0] = 1.0f; out[1] = 0.0f; out[2] = 0.0f; out[3] = 0.0f; out[4] = 0.0f;
                return;
            }
            double A = Math.pow(10.0, gainDb / 40.0);
            double omega = 2.0 * Math.PI * f0 / Fs;
            double cosw = Math.cos(omega);
            double sinw = Math.sin(omega);
            double twoSqrtAAlpha = sinw * Math.sqrt(2.0 * A);

            double a0 = (A + 1.0) + (A - 1.0) * cosw + twoSqrtAAlpha;
            out[0] = (float) ((A * ((A + 1.0) - (A - 1.0) * cosw + twoSqrtAAlpha)) / a0);
            out[1] = (float) ((2.0 * A * ((A - 1.0) - (A + 1.0) * cosw)) / a0);
            out[2] = (float) ((A * ((A + 1.0) - (A - 1.0) * cosw - twoSqrtAAlpha)) / a0);
            out[3] = (float) ((-2.0 * ((A - 1.0) + (A + 1.0) * cosw)) / a0);
            out[4] = (float) (((A + 1.0) + (A - 1.0) * cosw - twoSqrtAAlpha) / a0);
        }

        private static void computePeakingCoeffs(float f0, float Q, float gainDb, float Fs, float[] out) {
            if (Math.abs(gainDb) < 0.05f) {
                out[0] = 1.0f; out[1] = 0.0f; out[2] = 0.0f; out[3] = 0.0f; out[4] = 0.0f;
                return;
            }
            double A = Math.pow(10.0, gainDb / 40.0);
            double omega = 2.0 * Math.PI * f0 / Fs;
            double cosw = Math.cos(omega);
            double sinw = Math.sin(omega);
            double alpha = sinw / (2.0 * Q);

            double a0 = 1.0 + alpha / A;
            out[0] = (float) ((1.0 + alpha * A) / a0);
            out[1] = (float) ((-2.0 * cosw) / a0);
            out[2] = (float) ((1.0 - alpha * A) / a0);
            out[3] = (float) ((-2.0 * cosw) / a0);
            out[4] = (float) ((1.0 - alpha / A) / a0);
        }

        private static void computeHighShelfCoeffs(float f0, float gainDb, float Fs, float[] out) {
            if (Math.abs(gainDb) < 0.05f) {
                out[0] = 1.0f; out[1] = 0.0f; out[2] = 0.0f; out[3] = 0.0f; out[4] = 0.0f;
                return;
            }
            double A = Math.pow(10.0, gainDb / 40.0);
            double omega = 2.0 * Math.PI * f0 / Fs;
            double cosw = Math.cos(omega);
            double sinw = Math.sin(omega);
            double twoSqrtAAlpha = sinw * Math.sqrt(2.0 * A);

            double a0 = (A + 1.0) - (A - 1.0) * cosw + twoSqrtAAlpha;
            out[0] = (float) ((A * ((A + 1.0) + (A - 1.0) * cosw + twoSqrtAAlpha)) / a0);
            out[1] = (float) ((-2.0 * A * ((A - 1.0) + (A + 1.0) * cosw)) / a0);
            out[2] = (float) ((A * ((A + 1.0) + (A - 1.0) * cosw - twoSqrtAAlpha)) / a0);
            out[3] = (float) ((2.0 * ((A - 1.0) - (A + 1.0) * cosw)) / a0);
            out[4] = (float) (((A + 1.0) - (A - 1.0) * cosw - twoSqrtAAlpha) / a0);
        }

        private static float processBiquad(float in, float[] c, float[] s) {
            float y = c[0] * in + s[0];
            s[0] = c[1] * in - c[3] * y + s[1];
            s[1] = c[2] * in - c[4] * y;
            return y;
        }

        @Override
        public AudioProcessor.AudioFormat configure(AudioProcessor.AudioFormat inputAudioFormat) throws UnhandledAudioFormatException {
            // Support both 16-bit PCM and 32-bit Float PCM
            boolean is16Bit = (inputAudioFormat.encoding == C.ENCODING_PCM_16BIT);
            boolean isFloat = (inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT);

            // If format is unsupported or has invalid channels, safely bypass without throwing
            // an exception that would break ExoPlayer audio pipeline setup.
            if ((!is16Bit && !isFloat) || (inputAudioFormat.channelCount != 1 && inputAudioFormat.channelCount != 2)) {
                Log.w(TAG, "Unsupported audio format for spatial processing: encoding=" +
                        inputAudioFormat.encoding + ", channels=" + inputAudioFormat.channelCount + " -> Bypassing cleanly");
                this.inputAudioFormat = inputAudioFormat;
                this.outputAudioFormat = AudioProcessor.AudioFormat.NOT_SET;
                return AudioProcessor.AudioFormat.NOT_SET;
            }

            this.inputAudioFormat = inputAudioFormat;
            // Output stereo (2 channels) preserving the input sample rate and PCM encoding type
            int outEncoding = is16Bit ? C.ENCODING_PCM_16BIT : C.ENCODING_PCM_FLOAT;
            this.outputAudioFormat = new AudioProcessor.AudioFormat(inputAudioFormat.sampleRate, 2, outEncoding);
            this.isAttachedToSink = true;
            this.eqCoeffsDirty = true;
            Log.i(TAG, "Configured SpatialAudioProcessor: inRate=" + inputAudioFormat.sampleRate +
                    ", inChannels=" + inputAudioFormat.channelCount + ", encoding=" + (is16Bit ? "16BIT" : "FLOAT") + " -> outStereo");
            return outputAudioFormat;
        }

        @Override
        public boolean isActive() {
            return outputAudioFormat != AudioProcessor.AudioFormat.NOT_SET;
        }

        @Override
        public void queueInput(ByteBuffer inputBuffer) {
            int position = inputBuffer.position();
            int limit = inputBuffer.limit();
            int remaining = limit - position;
            if (remaining <= 0) {
                return;
            }

            boolean is16Bit = (inputAudioFormat.encoding == C.ENCODING_PCM_16BIT);
            int inChannelCount = inputAudioFormat.channelCount;
            int inBytesPerSample = is16Bit ? 2 : 4;
            int inBytesPerFrame = inChannelCount * inBytesPerSample;
            int frameCount = remaining / inBytesPerFrame;
            if (frameCount <= 0) {
                return;
            }
            int outBytesPerFrame = 2 * inBytesPerSample; // Always stereo
            int outBytesNeeded = frameCount * outBytesPerFrame;

            // Ensure output buffer has sufficient capacity without reallocating every frame
            if (buffer.capacity() < outBytesNeeded) {
                buffer = ByteBuffer.allocateDirect(outBytesNeeded).order(ByteOrder.nativeOrder());
            } else {
                buffer.clear();
            }

            // Snapshot current DSP parameters for audio block consistency
            final boolean enabled = this.spatialEnabled;
            final float curIntensity = this.intensity / 100.0f;
            final float curWidth = this.width / 100.0f;
            final float curDistance = this.distance / 100.0f;
            final float sampleRate = (inputAudioFormat.sampleRate > 0) ? (float) inputAudioFormat.sampleRate : 48000.0f;

            if (eqCoeffsDirty || sampleRate != lastSampleRate) {
                updateEqCoefficients(sampleRate);
            }

            final boolean eqActive = this.eqEnabled && (this.bassLevel != 50 || this.midLevel != 50 || this.trebleLevel != 50);
            final boolean spatialActive = enabled && (curIntensity > 0.001f);

            // Smooth native auto-orbit during screen-off / background playback
            if (this.autoOrbit && spatialEnabled) {
                fractionalAzimuth = (fractionalAzimuth + (30.0 * frameCount / sampleRate)) % 360.0;
                this.azimuth = (int) fractionalAzimuth;
            }
            final int curAzimuth = this.azimuth;

            // Pure passthrough only if BOTH Equalizer and Spatial Audio are bypassed
            if (!eqActive && !spatialActive) {
                if (inChannelCount == 2) {
                    // Direct stereo copy bounded by frameCount
                    int bytesToCopy = frameCount * inBytesPerFrame;
                    int oldLimit = inputBuffer.limit();
                    inputBuffer.limit(position + bytesToCopy);
                    buffer.put(inputBuffer);
                    inputBuffer.limit(oldLimit);
                } else {
                    // Mono to stereo copy
                    if (is16Bit) {
                        for (int f = 0; f < frameCount; f++) {
                            short monoSample = inputBuffer.getShort();
                            buffer.putShort(monoSample);
                            buffer.putShort(monoSample);
                        }
                    } else {
                        for (int f = 0; f < frameCount; f++) {
                            float monoSample = inputBuffer.getFloat();
                            buffer.putFloat(monoSample);
                            buffer.putFloat(monoSample);
                        }
                    }
                }
                inputBuffer.position(position + frameCount * inBytesPerFrame);
                buffer.flip();
                outputBuffer = buffer;
                processedFramesTotal += frameCount;
                return;
            }

            // Calculate Spatial DSP coefficients:
            // 1. Stereo Width (Mid/Side Matrix factor):
            final float widthFactor = (curWidth < 0.5f)
                    ? (curWidth / 0.5f)
                    : (1.0f + ((curWidth - 0.5f) / 0.5f) * 1.2f);

            // 2. 360° Horizontal Azimuth (ITD + ILD):
            final double rad = Math.toRadians(curAzimuth);
            final float x = (float) Math.sin(rad); // -1.0 (left) .. +1.0 (right)
            final float z = (float) Math.cos(rad); // +1.0 (front) .. -1.0 (back)

            // Interaural Level Difference (constant-energy panning)
            final float panAngle = (x + 1.0f) * 0.25f * (float) Math.PI; // 0..pi/2
            final float panL = (float) Math.cos(panAngle) * 1.4142f;
            final float panR = (float) Math.sin(panAngle) * 1.4142f;

            // Interaural Time Difference (delay in samples, max ~0.75ms)
            final float maxItdSamples = 0.00075f * sampleRate; // ~36 samples at 48 kHz
            final int itdDelayL = (x > 0.0f) ? Math.min(ITD_BUFFER_SIZE - 1, Math.round(x * maxItdSamples)) : 0;
            final int itdDelayR = (x < 0.0f) ? Math.min(ITD_BUFFER_SIZE - 1, Math.round(-x * maxItdSamples)) : 0;

            // Head shadow filter coefficient on contralateral ear
            final float shadowAmount = Math.abs(x);
            final float shadowAlpha = 1.0f - (shadowAmount * 0.55f); // 1.0 (open) to 0.45 (muffled)

            // Rear Pinna filter coefficient (attenuates high frequencies when z < 0)
            final float rearAmount = (z < 0.0f) ? (-z) : 0.0f;
            final float rearAlpha = 1.0f - (rearAmount * 0.42f); // 1.0 (front) to 0.58 (back)

            // 3. Distance & Air Absorption Filter:
            final float airAlpha = (float) Math.exp(-2.0 * Math.PI * (18000.0 - curDistance * 14500.0) / sampleRate);
            final float distGain = 1.0f - (curDistance * 0.22f); // subtle distance attenuation

            // Early room reflection tap delays (scaled to sample rate)
            final int tap1 = Math.round(0.013f * sampleRate) % REVERB_BUFFER_SIZE; // 13ms
            final int tap2 = Math.round(0.021f * sampleRate) % REVERB_BUFFER_SIZE; // 21ms
            final int tap3 = Math.round(0.033f * sampleRate) % REVERB_BUFFER_SIZE; // 33ms
            final float reverbLevel = curDistance * 0.25f; // more reflections as distance increases

            // Process PCM samples frame by frame
            for (int f = 0; f < frameCount; f++) {
                float inL;
                float inR;
                if (is16Bit) {
                    short rawL = inputBuffer.getShort();
                    short rawR = (inChannelCount == 2) ? inputBuffer.getShort() : rawL;
                    inL = rawL / 32768.0f;
                    inR = rawR / 32768.0f;
                } else {
                    inL = inputBuffer.getFloat();
                    inR = (inChannelCount == 2) ? inputBuffer.getFloat() : inL;
                }

                // Step 0: Apply 3-Band Parametric Equalizer (Native PCM Biquad Chain)
                if (eqActive) {
                    inL = processBiquad(inL, eqCoeffs[0], eqState[0][0]);
                    inL = processBiquad(inL, eqCoeffs[1], eqState[1][0]);
                    inL = processBiquad(inL, eqCoeffs[2], eqState[2][0]);

                    inR = processBiquad(inR, eqCoeffs[0], eqState[0][1]);
                    inR = processBiquad(inR, eqCoeffs[1], eqState[1][1]);
                    inR = processBiquad(inR, eqCoeffs[2], eqState[2][1]);
                }

                if (!spatialActive) {
                    // Equalizer active without spatial processing
                    float outL = softClip(inL);
                    float outR = softClip(inR);

                    if (is16Bit) {
                        short finalShortL = (short) Math.max(-32768, Math.min(32767, Math.round(outL * 32767.0f)));
                        short finalShortR = (short) Math.max(-32768, Math.min(32767, Math.round(outR * 32767.0f)));
                        buffer.putShort(finalShortL);
                        buffer.putShort(finalShortR);
                    } else {
                        buffer.putFloat(outL);
                        buffer.putFloat(outR);
                    }
                    continue;
                }

                // Step A: Mid/Side Stereo Widening
                float mid = 0.5f * (inL + inR);
                float side = 0.5f * (inL - inR);
                float wL = mid + side * widthFactor;
                float wR = mid - side * widthFactor;

                // Step B: Write to ITD circular delay lines
                delayLineL[itdWriteIndex] = wL;
                delayLineR[itdWriteIndex] = wR;

                // Read delayed samples for ITD binaural time offset
                int readIdxL = (itdWriteIndex - itdDelayL + ITD_BUFFER_SIZE) % ITD_BUFFER_SIZE;
                int readIdxR = (itdWriteIndex - itdDelayR + ITD_BUFFER_SIZE) % ITD_BUFFER_SIZE;
                float timeL = delayLineL[readIdxL];
                float timeR = delayLineR[readIdxR];
                itdWriteIndex = (itdWriteIndex + 1) % ITD_BUFFER_SIZE;

                // Step C: Contralateral Head Shadow Low-Pass Filter
                if (x > 0.0f) {
                    // Sound on right: Left ear is shaded
                    shadowFilterL = shadowFilterL + shadowAlpha * (timeL - shadowFilterL);
                    timeL = shadowFilterL;
                } else if (x < 0.0f) {
                    // Sound on left: Right ear is shaded
                    shadowFilterR = shadowFilterR + shadowAlpha * (timeR - shadowFilterR);
                    timeR = shadowFilterR;
                }

                // Step D: Apply ILD (Interaural Level Difference)
                float panAppliedL = timeL * panL;
                float panAppliedR = timeR * panR;

                // Step E: Rear Pinna Shadow (when sound is behind the listener)
                if (rearAmount > 0.0f) {
                    rearFilterL = rearFilterL + rearAlpha * (panAppliedL - rearFilterL);
                    rearFilterR = rearFilterR + rearAlpha * (panAppliedR - rearFilterR);
                    panAppliedL = rearFilterL;
                    panAppliedR = rearFilterR;
                }

                // Step F: Distance Air Absorption Low-Pass Filter
                airFilterL = airFilterL + (1.0f - airAlpha) * (panAppliedL - airFilterL);
                airFilterR = airFilterR + (1.0f - airAlpha) * (panAppliedR - airFilterR);
                float distL = airFilterL * distGain;
                float distR = airFilterR * distGain;

                // Step G: Early Room Reflections
                roomDelayL[roomWriteIndex] = distL;
                roomDelayR[roomWriteIndex] = distR;

                int rIdx1 = (roomWriteIndex - tap1 + REVERB_BUFFER_SIZE) % REVERB_BUFFER_SIZE;
                int rIdx2 = (roomWriteIndex - tap2 + REVERB_BUFFER_SIZE) % REVERB_BUFFER_SIZE;
                int rIdx3 = (roomWriteIndex - tap3 + REVERB_BUFFER_SIZE) % REVERB_BUFFER_SIZE;

                float earlyRefL = (roomDelayL[rIdx1] * 0.45f + roomDelayR[rIdx2] * 0.35f + roomDelayL[rIdx3] * 0.20f) * reverbLevel;
                float earlyRefR = (roomDelayR[rIdx1] * 0.45f + roomDelayL[rIdx2] * 0.35f + roomDelayL[rIdx3] * 0.20f) * reverbLevel;
                roomWriteIndex = (roomWriteIndex + 1) % REVERB_BUFFER_SIZE;

                float spatialL = distL + earlyRefL;
                float spatialR = distR + earlyRefR;

                // Step H: Wet/Dry Intensity Crossfade
                float outL = (1.0f - curIntensity) * inL + curIntensity * spatialL;
                float outR = (1.0f - curIntensity) * inR + curIntensity * spatialR;

                // Step I: Polynomial Soft-Knee Anti-Clipping Limiter
                outL = softClip(outL);
                outR = softClip(outR);

                // Write back to output buffer matching input encoding format
                if (is16Bit) {
                    short finalShortL = (short) Math.max(-32768, Math.min(32767, Math.round(outL * 32767.0f)));
                    short finalShortR = (short) Math.max(-32768, Math.min(32767, Math.round(outR * 32767.0f)));
                    buffer.putShort(finalShortL);
                    buffer.putShort(finalShortR);
                } else {
                    buffer.putFloat(outL);
                    buffer.putFloat(outR);
                }
            }

            inputBuffer.position(position + frameCount * inBytesPerFrame);
            buffer.flip();
            outputBuffer = buffer;
            processedFramesTotal += frameCount;
        }

        private static float softClip(float x) {
            if (x > 0.82f) {
                return 0.82f + 0.18f * (float) Math.tanh((x - 0.82f) / 0.18f);
            } else if (x < -0.82f) {
                return -0.82f - 0.18f * (float) Math.tanh((-x - 0.82f) / 0.18f);
            }
            return x;
        }

        @Override
        public void queueEndOfStream() {
            inputEnded = true;
        }

        @Override
        public ByteBuffer getOutput() {
            ByteBuffer currentOutputBuffer = this.outputBuffer;
            this.outputBuffer = EMPTY_BUFFER;
            return currentOutputBuffer;
        }

        @Override
        public boolean isEnded() {
            return inputEnded && outputBuffer == EMPTY_BUFFER;
        }

        @Override
        public void flush() {
            outputBuffer = EMPTY_BUFFER;
            inputEnded = false;

            // Reset filter histories on track seek or flush
            shadowFilterL = 0.0f;
            shadowFilterR = 0.0f;
            rearFilterL = 0.0f;
            rearFilterR = 0.0f;
            airFilterL = 0.0f;
            airFilterR = 0.0f;

            // Reset biquad delay registers
            for (int b = 0; b < 3; b++) {
                eqState[b][0][0] = 0.0f; eqState[b][0][1] = 0.0f;
                eqState[b][1][0] = 0.0f; eqState[b][1][1] = 0.0f;
            }

            // Zero out ITD circular delay lines and reset write index
            Arrays.fill(delayLineL, 0.0f);
            Arrays.fill(delayLineR, 0.0f);
            itdWriteIndex = 0;

            // Zero out room reflection delay lines and reset write index
            Arrays.fill(roomDelayL, 0.0f);
            Arrays.fill(roomDelayR, 0.0f);
            roomWriteIndex = 0;
        }

        @Override
        public void reset() {
            flush();
            buffer = EMPTY_BUFFER;
            inputAudioFormat = AudioProcessor.AudioFormat.NOT_SET;
            outputAudioFormat = AudioProcessor.AudioFormat.NOT_SET;
            isAttachedToSink = false;
            processedFramesTotal = 0;
        }
    }
}
