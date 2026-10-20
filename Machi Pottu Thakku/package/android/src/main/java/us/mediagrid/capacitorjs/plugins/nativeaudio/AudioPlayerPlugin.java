package us.mediagrid.capacitorjs.plugins.nativeaudio;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionResult;
import androidx.media3.session.SessionToken;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;
import org.json.JSONObject;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.MoreExecutors;
import java.util.HashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.IOException;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import us.mediagrid.capacitorjs.plugins.nativeaudio.exceptions.DestroyNotAllowedException;

@CapacitorPlugin(name = "AudioPlayer")
public class AudioPlayerPlugin extends Plugin {

    private static final String TAG = "AudioPlayerPlugin";
    public final ExecutorService executorService = Executors.newCachedThreadPool();

    private ListenableFuture<MediaController> audioMediaControllerFuture;
    private MediaController audioMediaController;

    private AudioSources audioSources = new AudioSources();
    private HashMap<String, String> appOnStartCallbackIds = new HashMap<>();
    private HashMap<String, String> appOnStopCallbackIds = new HashMap<>();

    // --- Local Wi-Fi Native Transport State ---
    private static final String SERVICE_TYPE = "_machisync._tcp";
    private ServerSocket localServerSocket;
    private Socket activeLocalSocket;
    private BufferedWriter localSocketWriter;
    private NsdManager nsdManager;
    private NsdManager.RegistrationListener localRegistrationListener;
    private NsdManager.DiscoveryListener localDiscoveryListener;
    private WifiManager.MulticastLock multicastLock;
    private String activeLocalRoomCode;
    private String localRole; // "HOST" | "RECEIVER"
    private volatile boolean isLocalTransportRunning = false;
    private volatile boolean isLocalConnecting = false;

    @Override
    public void load() {
        Log.i(TAG, "Handling load");

        super.load();

        createNotificationChannel();
    }

    @PluginMethod
    public void create(PluginCall call) {
        try {
            String sourceId = audioId(call);

            if (audioSourceExists("create", call, false)) {
                Log.w(
                    TAG,
                    String.format("An audio source with the ID %s already exists.", sourceId)
                );
                call.reject("There was an issue creating the audio player [0].");

                return;
            }

            AudioSource audioSource = new AudioSource(
                this,
                sourceId,
                call.getString("audioSource"),
                new AudioMetadata(
                    call.getString("albumTitle"),
                    call.getString("artistName"),
                    call.getString("friendlyTitle"),
                    call.getString("artworkSource"),
                    call.getString("metadataUpdateUrl"),
                    call.getInt("metadataUpdateInterval")
                ),
                call.getBoolean("useForNotification", false),
                call.getBoolean("isBackgroundMusic", false),
                call.getBoolean("loop", false)
            );

            String initialTrackId = call.getString("trackId");
            if (initialTrackId != null && !initialTrackId.isEmpty()) {
                audioSource.trackId = initialTrackId;
            }

            if (audioSources.count() == 0 && !audioSource.useForNotification) {
                throw new RuntimeException(
                    "An audio source with useForNotification = true must exist first."
                );
            }

            if (audioSources.hasNotification() && audioSource.useForNotification) {
                throw new RuntimeException(
                    "An audio source with useForNotification = true already exists. There can only be one."
                );
            }

            audioSources.add(audioSource);

            initializeMediaController("create", call, () -> {
                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue creating the audio player.", ex);
        }
    }

    @PluginMethod
    public void initialize(PluginCall call) {
        try {
            if (!audioSourceExists("initialize", call)) {
                return;
            }

            postToLooper("initialize", call, () -> {
                AudioSource audioSource = audioSources.get(audioId(call));

                if (audioSource.useForNotification) {
                    audioSource.setPlayer(audioMediaController);
                    audioSource.setPlayerAttributes();

                    audioMediaController.prepare();

                    Bundle audioSourceBundles = new Bundle();
                    audioSourceBundles.putBinder("audioSources", audioSources);

                    ListenableFuture<SessionResult> commandResult =
                        audioMediaController.sendCustomCommand(
                            new SessionCommand(
                                MediaSessionCallback.SET_AUDIO_SOURCES,
                                audioSourceBundles
                            ),
                            new Bundle()
                        );

                    commandResult.addListener(
                        () -> {
                            try {
                                SessionResult result = commandResult.get();

                                if (result.resultCode == SessionResult.RESULT_SUCCESS) {
                                    call.resolve();
                                } else {
                                    Log.e(
                                        TAG,
                                        String.format(
                                            "Couldn't set audio sources on MediaSession. Result code was %s.",
                                            result.resultCode
                                        )
                                    );
                                    call.reject(
                                        "There was an issue initializing the audio player [1]."
                                    );
                                }
                            } catch (Exception ex) {
                                Log.e(TAG, "Couldn't set audio sources on MediaSession.", ex);
                                call.reject(
                                    "There was an issue initializing the audio player [2].",
                                    ex
                                );
                            }
                        },
                        MoreExecutors.directExecutor()
                    );
                } else {
                    Bundle audioSourceBundle = new Bundle();
                    audioSourceBundle.putBinder("audioSource", audioSource);

                    ListenableFuture<SessionResult> commandResult =
                        audioMediaController.sendCustomCommand(
                            new SessionCommand(
                                MediaSessionCallback.CREATE_PLAYER,
                                audioSourceBundle
                            ),
                            new Bundle()
                        );

                    commandResult.addListener(
                        () -> {
                            try {
                                SessionResult result = commandResult.get();

                                if (result.resultCode == SessionResult.RESULT_SUCCESS) {
                                    call.resolve();
                                } else {
                                    Log.e(
                                        TAG,
                                        String.format(
                                            "Couldn't create player for Audio Id %s. Result code was %s",
                                            audioSource.id,
                                            result.resultCode
                                        )
                                    );
                                    call.reject(
                                        "There was an issue initializing the audio player [3]."
                                    );
                                }
                            } catch (Exception ex) {
                                Log.e(
                                    TAG,
                                    String.format(
                                        "Couldn't create player for Audio Id %s",
                                        audioSource.id
                                    ),
                                    ex
                                );
                                call.reject(
                                    "There was an issue initializing the audio player [4].",
                                    ex
                                );
                            }
                        },
                        MoreExecutors.directExecutor()
                    );
                }
            });
        } catch (Exception ex) {
            call.reject("There was an issue initializing the audio player [5].", ex);
        }
    }

    @PluginMethod
    public void changeAudioSource(PluginCall call) {
        try {
            if (!audioSourceExists("changeAudioSource", call)) {
                return;
            }

            AudioSource audioSource = audioSources.get(audioId(call));
            String newSource = call.getString("source");
            String trackId = call.getString("trackId");

            postToLooper("changeAudioSource", call, () -> {
                audioSource.changeAudioSource(newSource, trackId);

                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue changing the audio source.", ex);
        }
    }

    @PluginMethod
    public void setQueue(PluginCall call) {
        try {
            if (!audioSourceExists("setQueue", call)) {
                return;
            }

            AudioSource audioSource = audioSources.get(audioId(call));
            com.getcapacitor.JSArray itemsArray = call.getArray("items");
            int startIndex = call.getInt("startIndex", 0);
            String endpoint = call.getString("endpoint");

            if (itemsArray == null || itemsArray.length() == 0) {
                call.reject("items array is required and must not be empty");
                return;
            }

            java.util.List<AudioSource.QueueItem> queueItems = new java.util.ArrayList<>();
            for (int i = 0; i < itemsArray.length(); i++) {
                JSONObject rawObj = itemsArray.getJSONObject(i);
                JSObject itemObj = toJSObject(rawObj);
                if (itemObj != null) {
                    queueItems.add(new AudioSource.QueueItem(
                        itemObj.getString("source"),
                        itemObj.getString("trackId"),
                        itemObj.getString("friendlyTitle"),
                        itemObj.getString("artistName"),
                        itemObj.getString("albumTitle"),
                        itemObj.getString("artworkSource"),
                        itemObj.getString("s3Key"),
                        itemObj.optLong("urlFetchedAt", 0L),
                        itemObj.optBoolean("isOffline", false)
                    ));
                }
            }

            postToLooper("setQueue", call, () -> {
                audioSource.setQueue(queueItems, startIndex, endpoint);
                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue setting the queue.", ex);
        }
    }

    @PluginMethod
    public void addQueueItems(PluginCall call) {
        try {
            if (!audioSourceExists("addQueueItems", call)) {
                return;
            }

            AudioSource audioSource = audioSources.get(audioId(call));
            com.getcapacitor.JSArray itemsArray = call.getArray("items");

            if (itemsArray == null || itemsArray.length() == 0) {
                call.resolve();
                return;
            }

            java.util.List<AudioSource.QueueItem> queueItems = new java.util.ArrayList<>();
            for (int i = 0; i < itemsArray.length(); i++) {
                JSONObject rawObj = itemsArray.getJSONObject(i);
                JSObject itemObj = toJSObject(rawObj);
                if (itemObj != null) {
                    queueItems.add(new AudioSource.QueueItem(
                        itemObj.getString("source"),
                        itemObj.getString("trackId"),
                        itemObj.getString("friendlyTitle"),
                        itemObj.getString("artistName"),
                        itemObj.getString("albumTitle"),
                        itemObj.getString("artworkSource"),
                        itemObj.getString("s3Key"),
                        itemObj.optLong("urlFetchedAt", 0L),
                        itemObj.optBoolean("isOffline", false)
                    ));
                }
            }

            postToLooper("addQueueItems", call, () -> {
                audioSource.addQueueItems(queueItems);
                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue adding queue items.", ex);
        }
    }

    @PluginMethod
    public void playNext(PluginCall call) {
        try {
            if (!audioSourceExists("playNext", call)) {
                return;
            }

            AudioSource audioSource = audioSources.get(audioId(call));
            com.getcapacitor.JSObject rawObj = call.getObject("item");
            if (rawObj == null) {
                call.reject("item object is required");
                return;
            }
            AudioSource.QueueItem item = new AudioSource.QueueItem(
                rawObj.getString("source"),
                rawObj.getString("trackId"),
                rawObj.getString("friendlyTitle"),
                rawObj.getString("artistName"),
                rawObj.getString("albumTitle"),
                rawObj.getString("artworkSource"),
                rawObj.getString("s3Key"),
                rawObj.optLong("urlFetchedAt", 0L),
                rawObj.optBoolean("isOffline", false)
            );

            postToLooper("playNext", call, () -> {
                audioSource.playNext(item);
                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue inserting playNext track.", ex);
        }
    }

    @PluginMethod
    public void removeQueueItem(PluginCall call) {
        try {
            if (!audioSourceExists("removeQueueItem", call)) {
                return;
            }

            AudioSource audioSource = audioSources.get(audioId(call));
            String queueItemUid = call.getString("queueItemUid");
            if (queueItemUid == null || queueItemUid.isEmpty()) {
                call.reject("queueItemUid is required");
                return;
            }

            postToLooper("removeQueueItem", call, () -> {
                audioSource.removeQueueItem(queueItemUid);
                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue removing queue item.", ex);
        }
    }

    @PluginMethod
    public void setRepeatMode(PluginCall call) {
        try {
            if (!audioSourceExists("setRepeatMode", call)) {
                return;
            }

            AudioSource audioSource = audioSources.get(audioId(call));
            int mode = call.getInt("mode", 0);

            postToLooper("setRepeatMode", call, () -> {
                audioSource.setRepeatMode(mode);
                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue setting repeat mode.", ex);
        }
    }

    @PluginMethod
    public void getRepeatMode(PluginCall call) {
        try {
            if (!audioSourceExists("getRepeatMode", call)) {
                return;
            }

            AudioSource audioSource = audioSources.get(audioId(call));
            JSObject ret = new JSObject();
            ret.put("mode", audioSource.getRepeatMode());
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("There was an issue getting repeat mode.", ex);
        }
    }

    @PluginMethod
    public void getQueue(PluginCall call) {
        try {
            if (!audioSourceExists("getQueue", call)) {
                return;
            }

            AudioSource audioSource = audioSources.get(audioId(call));
            java.util.List<AudioSource.QueueItem> list = audioSource.getMasterPlaylist();
            com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
            synchronized (list) {
                for (AudioSource.QueueItem item : list) {
                    JSObject obj = new JSObject();
                    obj.put("queueItemUid", item.queueItemUid);
                    obj.put("trackId", item.trackId);
                    obj.put("friendlyTitle", item.friendlyTitle);
                    obj.put("artistName", item.artistName);
                    obj.put("albumTitle", item.albumTitle);
                    obj.put("artworkSource", item.artworkSource);
                    obj.put("source", item.source);
                    obj.put("isOffline", item.isOffline);
                    arr.put(obj);
                }
            }
            JSObject res = new JSObject();
            res.put("queue", arr);
            res.put("currentIndex", audioSource.getCurrentMasterIndex());
            res.put("currentQueueItemUid", audioSource.getCurrentQueueItemUid());
            call.resolve(res);
        } catch (Exception ex) {
            call.reject("There was an issue getting the queue.", ex);
        }
    }

    @PluginMethod
    public void setEqualizerBands(PluginCall call) {
        try {
            int bass = call.getInt("bass", 50);
            int mid = call.getInt("mid", 50);
            int treble = call.getInt("treble", 50);

            postToLooper("setEqualizerBands", call, () -> {
                try {
                    AudioPlayerService service = AudioPlayerService.getInstance();
                    AudioPlayerService.SpatialAudioProcessor proc = (service != null) ? service.getSpatialAudioProcessor() : null;
                    boolean enabled = call.hasOption("enabled") ? call.getBoolean("enabled", true) : true;
                    if (proc != null) {
                        proc.setEqualizerParams(enabled, bass, mid, treble);
                        proc.savePreferences(getContext());
                        call.resolve(toJSObject(proc.getEqualizerStatus()));
                    } else {
                        JSObject obj = new JSObject();
                        obj.put("isAvailable", true);
                        obj.put("enabled", enabled);
                        obj.put("bass", bass);
                        obj.put("mid", mid);
                        obj.put("treble", treble);
                        call.resolve(obj);
                    }
                } catch (Exception ex) {
                    Log.e(TAG, "Error setting equalizer bands", ex);
                    call.reject("There was an issue setting equalizer bands: " + ex.getMessage(), ex);
                }
            });
        } catch (Exception ex) {
            call.reject("There was an issue setting equalizer bands.", ex);
        }
    }

    @PluginMethod
    public void setEqualizerEnabled(PluginCall call) {
        try {
            boolean enabled = call.getBoolean("enabled", true);
            postToLooper("setEqualizerEnabled", call, () -> {
                try {
                    AudioPlayerService service = AudioPlayerService.getInstance();
                    AudioPlayerService.SpatialAudioProcessor proc = (service != null) ? service.getSpatialAudioProcessor() : null;
                    if (proc != null) {
                        proc.setEqualizerEnabled(enabled);
                        proc.savePreferences(getContext());
                        call.resolve(toJSObject(proc.getEqualizerStatus()));
                    } else {
                        JSObject obj = new JSObject();
                        obj.put("isAvailable", true);
                        obj.put("enabled", enabled);
                        call.resolve(obj);
                    }
                } catch (Exception ex) {
                    Log.e(TAG, "Error toggling equalizer enabled state", ex);
                    call.reject("There was an issue toggling equalizer enabled state: " + ex.getMessage(), ex);
                }
            });
        } catch (Exception ex) {
            call.reject("There was an issue toggling equalizer enabled state.", ex);
        }
    }

    @PluginMethod
    public void getEqualizerStatus(PluginCall call) {
        try {
            postToLooper("getEqualizerStatus", call, () -> {
                try {
                    AudioPlayerService service = AudioPlayerService.getInstance();
                    AudioPlayerService.SpatialAudioProcessor proc = (service != null) ? service.getSpatialAudioProcessor() : null;
                    if (proc != null) {
                        call.resolve(toJSObject(proc.getEqualizerStatus()));
                    } else {
                        JSObject obj = new JSObject();
                        obj.put("isAvailable", true);
                        obj.put("enabled", true);
                        call.resolve(obj);
                    }
                } catch (Exception ex) {
                    Log.e(TAG, "Error getting equalizer status", ex);
                    call.reject("There was an issue getting equalizer status: " + ex.getMessage(), ex);
                }
            });
        } catch (Exception ex) {
            call.reject("There was an issue getting equalizer status.", ex);
        }
    }

    @PluginMethod
    public void setSpatialAudioParams(PluginCall call) {
        try {
            boolean enabled = call.getBoolean("enabled", false);
            int intensity = call.getInt("intensity", 75);
            int width = call.getInt("width", 80);
            int distance = call.getInt("distance", 40);
            int azimuth = call.getInt("azimuth", 0);
            boolean autoOrbit = call.hasOption("autoOrbit") ? call.getBoolean("autoOrbit", false) : false;

            postToLooper("setSpatialAudioParams", call, () -> {
                try {
                    AudioPlayerService service = AudioPlayerService.getInstance();
                    AudioPlayerService.SpatialAudioProcessor proc = (service != null) ? service.getSpatialAudioProcessor() : null;
                    if (proc != null) {
                        proc.setAutoOrbit(autoOrbit);
                        proc.setParams(enabled, intensity, width, distance, azimuth);
                        proc.savePreferences(getContext());
                    }
                    JSONObject status = (proc != null) ? proc.getStatus() : new JSONObject();
                    call.resolve(toJSObject(status));
                } catch (Exception ex) {
                    Log.e(TAG, "Error setting spatial audio params", ex);
                    call.reject("There was an issue setting spatial audio params: " + ex.getMessage(), ex);
                }
            });
        } catch (Exception ex) {
            call.reject("There was an issue setting spatial audio params.", ex);
        }
    }

    @PluginMethod
    public void setSpatialAudioEnabled(PluginCall call) {
        try {
            boolean enabled = call.getBoolean("enabled", false);
            postToLooper("setSpatialAudioEnabled", call, () -> {
                try {
                    AudioPlayerService service = AudioPlayerService.getInstance();
                    AudioPlayerService.SpatialAudioProcessor proc = (service != null) ? service.getSpatialAudioProcessor() : null;
                    if (proc != null) {
                        proc.setEnabled(enabled);
                        proc.savePreferences(getContext());
                    }
                    AudioPlayerService.AudioEffectsManager fx = (service != null) ? service.getAudioEffectsManager() : null;
                    if (fx != null) {
                        fx.setSpatialEnabled(enabled);
                    }
                    JSONObject status = (proc != null) ? proc.getStatus() : (fx != null ? fx.getStatus() : new JSONObject());
                    call.resolve(toJSObject(status));
                } catch (Exception ex) {
                    Log.e(TAG, "Error toggling spatial audio enabled state", ex);
                    call.reject("There was an issue toggling spatial audio enabled state: " + ex.getMessage(), ex);
                }
            });
        } catch (Exception ex) {
            call.reject("There was an issue toggling spatial audio enabled state.", ex);
        }
    }

    @PluginMethod
    public void getSpatialAudioStatus(PluginCall call) {
        try {
            postToLooper("getSpatialAudioStatus", call, () -> {
                try {
                    AudioPlayerService service = AudioPlayerService.getInstance();
                    AudioPlayerService.SpatialAudioProcessor proc = (service != null) ? service.getSpatialAudioProcessor() : null;
                    AudioPlayerService.AudioEffectsManager fx = (service != null) ? service.getAudioEffectsManager() : null;
                    JSONObject status = (proc != null) ? proc.getStatus() : (fx != null ? fx.getStatus() : new JSONObject());
                    call.resolve(toJSObject(status));
                } catch (Exception ex) {
                    Log.e(TAG, "Error getting spatial audio status", ex);
                    call.reject("There was an issue getting spatial audio status: " + ex.getMessage(), ex);
                }
            });
        } catch (Exception ex) {
            call.reject("There was an issue getting spatial audio status.", ex);
        }
    }

    @PluginMethod
    public void queueNext(PluginCall call) {
        try {
            if (!audioSourceExists("queueNext", call)) {
                return;
            }

            AudioSource audioSource = audioSources.get(audioId(call));
            String nextSource = call.getString("source");
            String nextTrackId = call.getString("trackId");
            String expectedCurrentTrackId = call.getString("expectedCurrentTrackId");
            boolean isOffline = call.getBoolean("isOffline", false);
            AudioMetadata nextMetadata = new AudioMetadata(
                call.getString("albumTitle"),
                call.getString("artistName"),
                call.getString("friendlyTitle"),
                call.getString("artworkSource"),
                null,
                null
            );

            postToLooper("queueNext", call, () -> {
                audioSource.queueNext(nextSource, nextMetadata, nextTrackId, expectedCurrentTrackId, isOffline);
                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue queuing the next track.", ex);
        }
    }

    @PluginMethod
    public void changeMetadata(PluginCall call) {
        try {
            if (!audioSourceExists("changeMetadata", call)) {
                return;
            }

            AudioSource audioSource = audioSources.get(audioId(call));


            postToLooper("changeMetadata", call, () -> {
                audioSource.changeMetadata(
                    new AudioMetadata(
                        call.getString("albumTitle"),
                        call.getString("artistName"),
                        call.getString("friendlyTitle"),
                        call.getString("artworkSource"),
                        null,
                        null
                    )
                );

                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue changing the metadata.", ex);
        }
    }

    @PluginMethod
    public void updateMetadata(PluginCall call) {
        try {
            if (!audioSourceExists("updateMetadata", call)) {
                return;
            }

            AudioSource audioSource = audioSources.get(audioId(call));

            postToLooper("updateMetadata", call, () -> {
                audioSource.audioMetadata.updateMetadataByUrl(null);

                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue updating the metadata.", ex);
        }
    }

    @PluginMethod
    public void getDuration(PluginCall call) {
        try {
            if (!audioSourceExists("getDuration", call)) {
                return;
            }

            postToLooper("getDuration", call, () -> {
                call.resolve(
                    new JSObject().put("duration", audioSources.get(audioId(call)).getDuration())
                );
            });
        } catch (Exception ex) {
            call.reject("There was an issue getting the duration for the audio source.", ex);
        }
    }

    @PluginMethod
    public void getCurrentTime(PluginCall call) {
        try {
            if (!audioSourceExists("getCurrentTime", call)) {
                return;
            }

            postToLooper("getCurrentTime", call, () -> {
                call.resolve(
                    new JSObject().put(
                        "currentTime",
                        audioSources.get(audioId(call)).getCurrentTime()
                    )
                );
            });
        } catch (Exception ex) {
            call.reject("There was an issue getting the current time for the audio source.", ex);
        }
    }

    @PluginMethod
    public void play(PluginCall call) {
        try {
            if (!audioSourceExists("play", call)) {
                return;
            }

            postToLooper("play", call, () -> {
                audioSources.get(audioId(call)).play();

                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue playing the audio.", ex);
        }
    }

    @PluginMethod
    public void pause(PluginCall call) {
        try {
            if (!audioSourceExists("pause", call)) {
                return;
            }

            postToLooper("pause", call, () -> {
                audioSources.get(audioId(call)).pause();

                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue pausing the audio.", ex);
        }
    }

    @PluginMethod
    public void seek(PluginCall call) {
        try {
            if (!audioSourceExists("seek", call)) {
                return;
            }

            postToLooper("seek", call, () -> {
                Double doubleTime = call.getDouble("timeInSeconds");
                if (doubleTime != null) {
                    audioSources.get(audioId(call)).seek(doubleTime.doubleValue());
                } else {
                    Integer intTime = call.getInt("timeInSeconds");
                    long timeInSeconds = intTime != null ? intTime.longValue() : 0L;
                    audioSources.get(audioId(call)).seek(timeInSeconds);
                }

                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue seeking the audio.", ex);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            if (!audioSourceExists("stop", call)) {
                return;
            }

            postToLooper("stop", call, () -> {
                audioSources.get(audioId(call)).stop();

                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue stopping the audio.", ex);
        }
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        try {
            if (!audioSourceExists("setVolume", call)) {
                return;
            }

            postToLooper("setVolume", call, () -> {
                audioSources.get(audioId(call)).setVolume(call.getFloat("volume"));

                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue setting the audio volume.", ex);
        }
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        try {
            if (!audioSourceExists("setRate", call)) {
                return;
            }

            postToLooper("setRate", call, () -> {
                audioSources.get(audioId(call)).setRate(call.getFloat("rate"));

                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue setting the rate of the audio.", ex);
        }
    }

    @PluginMethod
    public void isPlaying(PluginCall call) {
        try {
            if (!audioSourceExists("isPlaying", call)) {
                return;
            }

            postToLooper("isPlaying", call, () -> {
                call.resolve(
                    new JSObject().put("isPlaying", audioSources.get(audioId(call)).isPlaying())
                );
            });
        } catch (Exception ex) {
            call.reject("There was an issue getting the playing status of the audio.", ex);
        }
    }

    @PluginMethod
    public void destroy(PluginCall call) {
        try {
            if (!audioSourceExists("destroy", call)) {
                return;
            }

            String audioId = audioId(call);
            AudioSource audioSource = audioSources.get(audioId);

            if (audioSource.useForNotification && audioSources.count() > 1) {
                throw new DestroyNotAllowedException(
                    String.format(
                        "Audio source ID %s is the current notification and cannot be destroyed. Destroy other audio sources first.",
                        audioId
                    )
                );
            }

            appOnStartCallbackIds.remove(audioId);
            appOnStopCallbackIds.remove(audioId);

            postToLooper("destroy", call, () -> {
                if (audioSource.useForNotification) {
                    releaseMediaController();
                }

                audioSource.destroy();
                audioSources.remove(audioId);

                call.resolve();
            });
        } catch (Exception ex) {
            call.reject("There was an issue cleaning up the audio player.", ex);
        }
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void onAppGainsFocus(PluginCall call) {
        call.setKeepAlive(true);
        getBridge().saveCall(call);

        appOnStartCallbackIds.put(audioId(call), call.getCallbackId());
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void onAppLosesFocus(PluginCall call) {
        call.setKeepAlive(true);
        getBridge().saveCall(call);

        appOnStopCallbackIds.put(audioId(call), call.getCallbackId());
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void onAudioReady(PluginCall call) {
        if (!audioSourceExists("onAudioReady", call)) {
            return;
        }

        call.setKeepAlive(true);
        getBridge().saveCall(call);

        audioSources.get(audioId(call)).setOnReady(call.getCallbackId());
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void onAudioEnd(PluginCall call) {
        if (!audioSourceExists("onAudioEnd", call)) {
            return;
        }

        call.setKeepAlive(true);
        getBridge().saveCall(call);

        audioSources.get(audioId(call)).setOnEnd(call.getCallbackId());
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void onPlaybackStatusChange(PluginCall call) {
        if (!audioSourceExists("onPlaybackStatusChange", call)) {
            return;
        }

        call.setKeepAlive(true);
        getBridge().saveCall(call);

        audioSources.get(audioId(call)).setOnPlaybackStatusChange(call.getCallbackId());
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void onMetadataUpdate(PluginCall call) {
        if (!audioSourceExists("onMetadataUpdate", call)) {
            return;
        }

        call.setKeepAlive(true);
        getBridge().saveCall(call);

        audioSources.get(audioId(call)).audioMetadata.setOnMetadataUpdate(call.getCallbackId());
    }

    @Override
    protected void handleOnStart() {
        Log.i(TAG, "Handling onStart");

        super.handleOnStart();

        makeAppStatusChangeCallbacks(appOnStartCallbackIds);
    }

    @Override
    protected void handleOnStop() {
        Log.i(TAG, "Handling onStop");

        makeAppStatusChangeCallbacks(appOnStopCallbackIds);

        super.handleOnStop();
    }

    @Override
    protected void handleOnDestroy() {
        Log.i(TAG, "Handling onDestroy");

        cleanupLocalTransport();
        releaseMediaController();
        executorService.shutdownNow();

        super.handleOnDestroy();
    }

    private void initializeMediaController(String methodName, PluginCall call, Runnable callback) {
        Log.i(TAG, "Initializing MediaController");

        if (audioMediaController != null) {
            Log.i(TAG, "MediaController already initialized, running callback.");
            callback.run();

            return;
        }

        postToLooper("initializeMediaController", call, () -> {
            SessionToken sessionToken = new SessionToken(
                getContextForAudioService(),
                new ComponentName(getContextForAudioService(), AudioPlayerService.class)
            );

            audioMediaControllerFuture = new MediaController.Builder(
                getContextForAudioService(),
                sessionToken
            ).buildAsync();

            audioMediaControllerFuture.addListener(
                () -> {
                    try {
                        audioMediaController = audioMediaControllerFuture.get();
                        callback.run();
                    } catch (Exception ex) {
                        Log.e(TAG, "Couldn't get MediaController", ex);
                        call.reject(
                            String.format(
                                "There was an issue initializing the MediaController in method %s",
                                methodName
                            ),
                            ex
                        );
                    }
                },
                MoreExecutors.directExecutor()
            );
        });
    }

    private void releaseMediaController() {
        if (audioMediaController == null) {
            return;
        }

        Log.i(TAG, "Releasing MediaController");

        AudioSource audioSourceForNotification = audioSources.forNotification();

        if (
            audioSourceForNotification != null &&
            audioSourceForNotification.getEventListener() != null
        ) {
            audioMediaController.removeListener(audioSourceForNotification.getEventListener());
        }

        audioMediaController.stop();
        audioMediaController.release();
        MediaController.releaseFuture(audioMediaControllerFuture);
        audioMediaController = null;
    }

    private String audioId(PluginCall call) {
        return call.getString("audioId");
    }

    private boolean audioSourceExists(String methodName, PluginCall call) {
        return audioSourceExists(methodName, call, true);
    }

    private boolean audioSourceExists(String methodName, PluginCall call, boolean rejectIfError) {
        boolean audioSourceExists = audioSources.exists(audioId(call));

        if (!audioSourceExists && rejectIfError) {
            Log.w(TAG, String.format("Audio source with ID %s was not found.", audioId(call)));
            call.reject(
                String.format("There was an issue trying to play the audio (%s [2])", methodName)
            );
        }

        return audioSourceExists;
    }

    private Context getContextForAudioService() {
        return this.getActivity();
    }

    private void createNotificationChannel() {
        if (
            Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            getContext()
                .getSystemService(NotificationManager.class)
                .getNotificationChannel(AudioPlayerService.PLAYBACK_CHANNEL_ID) !=
            null
        ) {
            return;
        }

        NotificationManager manager = getContext().getSystemService(NotificationManager.class);

        NotificationChannel playbackChannel = new NotificationChannel(
            AudioPlayerService.PLAYBACK_CHANNEL_ID,
            "Audio playback",
            NotificationManager.IMPORTANCE_LOW
        );

        manager.createNotificationChannel(playbackChannel);
    }

    private void makeAppStatusChangeCallbacks(HashMap<String, String> callbackIds) {
        for (String callbackId : callbackIds.values()) {
            PluginCall call = getBridge().getSavedCall(callbackId);

            if (call == null) {
                continue;
            }

            call.resolve();
        }
    }

    private void postToLooper(String methodName, PluginCall call, Runnable callback) {
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                callback.run();
            } catch (Exception ex) {
                call.reject(
                    String.format(
                        "There was an issue posting to the looper for method %s",
                        methodName
                    ),
                    ex
                );
            }
        });
    }

    public void emitNextEvent() {
        notifyListeners("nativeMediaNext", new JSObject());
    }

    public void emitPreviousEvent() {
        notifyListeners("nativeMediaPrevious", new JSObject());
    }

    public void emitAudioEndEvent() {
        notifyListeners("nativeAudioEnd", new JSObject());
    }

    public void emitTrackTransitionEvent(JSObject data) {
        notifyListeners("nativeTrackTransition", data != null ? data : new JSObject());
    }

    public void emitPlaybackStatusChangeEvent(JSObject data) {
        notifyListeners("playbackStatusChange", data != null ? data : new JSObject());
    }

    private JSObject toJSObject(JSONObject obj) throws JSONException {
        if (obj == null) {
            return null;
        }
        if (obj instanceof JSObject) {
            return (JSObject) obj;
        }
        return new JSObject(obj.toString());
    }

    // =========================================================================
    // LOCAL WI-FI OFFLINE TRANSPORT (Android NSD + Direct TCP Socket)
    // =========================================================================

    private void acquireMulticastLock() {
        try {
            if (multicastLock == null) {
                WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi != null) {
                    multicastLock = wifi.createMulticastLock("MachiSyncMulticastLock");
                    multicastLock.setReferenceCounted(true);
                }
            }
            if (multicastLock != null && !multicastLock.isHeld()) {
                multicastLock.acquire();
                Log.d(TAG, "[LOCAL_WIFI] Acquired MulticastLock for NSD");
            }
        } catch (Exception e) {
            Log.w(TAG, "[LOCAL_WIFI] Could not acquire MulticastLock: " + e.getMessage());
        }
    }

    private void releaseMulticastLock() {
        try {
            if (multicastLock != null && multicastLock.isHeld()) {
                multicastLock.release();
                Log.d(TAG, "[LOCAL_WIFI] Released MulticastLock");
            }
        } catch (Exception e) {
            Log.w(TAG, "[LOCAL_WIFI] Error releasing MulticastLock: " + e.getMessage());
        }
    }

    private synchronized void cleanupLocalTransport() {
        isLocalTransportRunning = false;
        isLocalConnecting = false;
        activeLocalRoomCode = null;
        localRole = null;

        if (nsdManager != null && localRegistrationListener != null) {
            try {
                nsdManager.unregisterService(localRegistrationListener);
                Log.d(TAG, "[LOCAL_WIFI] Unregistered NSD service");
            } catch (Exception e) {
                Log.w(TAG, "[LOCAL_WIFI] Error unregistering NSD service: " + e.getMessage());
            }
            localRegistrationListener = null;
        }

        if (nsdManager != null && localDiscoveryListener != null) {
            try {
                nsdManager.stopServiceDiscovery(localDiscoveryListener);
                Log.d(TAG, "[LOCAL_WIFI] Stopped NSD discovery");
            } catch (Exception e) {
                Log.w(TAG, "[LOCAL_WIFI] Error stopping NSD discovery: " + e.getMessage());
            }
            localDiscoveryListener = null;
        }

        if (localSocketWriter != null) {
            try { localSocketWriter.close(); } catch (Exception ignored) {}
            localSocketWriter = null;
        }

        if (activeLocalSocket != null) {
            try { activeLocalSocket.close(); } catch (Exception ignored) {}
            activeLocalSocket = null;
        }

        if (localServerSocket != null) {
            try { localServerSocket.close(); } catch (Exception ignored) {}
            localServerSocket = null;
        }

        releaseMulticastLock();
    }

    @PluginMethod
    public void isLocalTransportAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        ret.put("platform", "android");
        call.resolve(ret);
    }

    @PluginMethod
    public void startLocalHost(PluginCall call) {
        String roomCode = call.getString("roomCode");
        if (roomCode == null || roomCode.trim().isEmpty()) {
            call.reject("roomCode is required to start local host");
            return;
        }

        executorService.execute(() -> {
            try {
                cleanupLocalTransport();
                isLocalTransportRunning = true;
                activeLocalRoomCode = roomCode.trim();
                localRole = "HOST";

                acquireMulticastLock();

                // 1. Create ServerSocket on ephemeral port
                localServerSocket = new ServerSocket(0);
                int port = localServerSocket.getLocalPort();
                Log.i(TAG, "[LOCAL_WIFI] Host ServerSocket opened on port: " + port);

                // 2. Register with Android NSD
                nsdManager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
                NsdServiceInfo serviceInfo = new NsdServiceInfo();
                String serviceName = "MachiSync_" + activeLocalRoomCode + "_" + port;
                serviceInfo.setServiceName(serviceName);
                serviceInfo.setServiceType(SERVICE_TYPE);
                serviceInfo.setPort(port);

                localRegistrationListener = new NsdManager.RegistrationListener() {
                    @Override
                    public void onServiceRegistered(NsdServiceInfo nsdServiceInfo) {
                        Log.i(TAG, "[LOCAL_WIFI] NSD Service registered: " + nsdServiceInfo.getServiceName());
                        JSObject statusObj = new JSObject();
                        statusObj.put("status", "WAITING");
                        statusObj.put("role", "HOST");
                        statusObj.put("serviceName", nsdServiceInfo.getServiceName());
                        statusObj.put("port", port);
                        notifyListeners("localTransportStatus", statusObj);
                    }

                    @Override
                    public void onRegistrationFailed(NsdServiceInfo nsdServiceInfo, int errorCode) {
                        Log.e(TAG, "[LOCAL_WIFI] NSD registration failed with error: " + errorCode);
                        JSObject statusObj = new JSObject();
                        statusObj.put("status", "ERROR");
                        statusObj.put("message", "NSD registration failed: code " + errorCode);
                        notifyListeners("localTransportStatus", statusObj);
                    }

                    @Override
                    public void onServiceUnregistered(NsdServiceInfo nsdServiceInfo) {
                        Log.i(TAG, "[LOCAL_WIFI] NSD Service unregistered");
                    }

                    @Override
                    public void onUnregistrationFailed(NsdServiceInfo nsdServiceInfo, int errorCode) {
                        Log.w(TAG, "[LOCAL_WIFI] NSD unregistration failed: " + errorCode);
                    }
                };

                nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, localRegistrationListener);

                // 3. Start listening for incoming client connection on background thread
                executorService.execute(() -> {
                    while (isLocalTransportRunning && localServerSocket != null && !localServerSocket.isClosed()) {
                        try {
                            Log.i(TAG, "[LOCAL_WIFI] Host waiting for client accept...");
                            Socket client = localServerSocket.accept();
                            client.setTcpNoDelay(true);

                            if (!isLocalTransportRunning) {
                                try { client.close(); } catch (Exception ignored) {}
                                break;
                            }

                            handleConnectedClient(client);
                        } catch (Exception e) {
                            if (isLocalTransportRunning && localServerSocket != null && !localServerSocket.isClosed()) {
                                Log.e(TAG, "[LOCAL_WIFI] ServerSocket accept error: " + e.getMessage());
                            }
                        }
                    }
                });

                JSObject res = new JSObject();
                res.put("success", true);
                res.put("port", port);
                call.resolve(res);

            } catch (Exception e) {
                Log.e(TAG, "[LOCAL_WIFI] Error starting local host: " + e.getMessage(), e);
                cleanupLocalTransport();
                call.reject("Failed to start local host: " + e.getMessage(), e);
            }
        });
    }

    private void handleConnectedClient(Socket client) {
        executorService.execute(() -> {
            try {
                Log.i(TAG, "[LOCAL_WIFI] Incoming client connected from " + client.getRemoteSocketAddress());
                BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(client.getOutputStream(), StandardCharsets.UTF_8));

                // Read authentication handshake line
                String authLine = reader.readLine();
                if (authLine == null) {
                    client.close();
                    return;
                }

                JSONObject authJson = new JSONObject(authLine);
                String clientCode = authJson.optString("roomCode");
                if (!activeLocalRoomCode.equals(clientCode)) {
                    Log.w(TAG, "[LOCAL_WIFI] Client room code mismatch: got " + clientCode + ", expected " + activeLocalRoomCode);
                    JSONObject failResp = new JSONObject();
                    failResp.put("type", "AUTH_FAIL");
                    failResp.put("reason", "Room code mismatch");
                    writer.write(failResp.toString() + "\n");
                    writer.flush();
                    client.close();
                    return;
                }

                // Authenticated successfully!
                JSONObject okResp = new JSONObject();
                okResp.put("type", "AUTH_OK");
                okResp.put("role", "HOST");
                writer.write(okResp.toString() + "\n");
                writer.flush();

                synchronized (this) {
                    if (activeLocalSocket != null && !activeLocalSocket.isClosed()) {
                        try { activeLocalSocket.close(); } catch (Exception ignored) {}
                    }
                    activeLocalSocket = client;
                    localSocketWriter = writer;
                }

                JSObject statusObj = new JSObject();
                statusObj.put("status", "CONNECTED");
                statusObj.put("role", "HOST");
                statusObj.put("remoteAddress", client.getRemoteSocketAddress().toString());
                notifyListeners("localTransportStatus", statusObj);

                // Message read loop
                listenToSocketMessages(reader);

            } catch (Exception e) {
                if (isLocalTransportRunning) {
                    Log.e(TAG, "[LOCAL_WIFI] ServerSocket client error: " + e.getMessage());
                    JSObject statusObj = new JSObject();
                    statusObj.put("status", "DISCONNECTED");
                    statusObj.put("role", "HOST");
                    statusObj.put("message", e.getMessage());
                    notifyListeners("localTransportStatus", statusObj);
                }
            }
        });
    }

    @PluginMethod
    public void startLocalReceiver(PluginCall call) {
        String roomCode = call.getString("roomCode");
        if (roomCode == null || roomCode.trim().isEmpty()) {
            call.reject("roomCode is required to join local room");
            return;
        }

        executorService.execute(() -> {
            try {
                cleanupLocalTransport();
                isLocalTransportRunning = true;
                isLocalConnecting = false;
                activeLocalRoomCode = roomCode.trim();
                localRole = "RECEIVER";

                acquireMulticastLock();

                nsdManager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);

                JSObject connectingObj = new JSObject();
                connectingObj.put("status", "CONNECTING");
                connectingObj.put("role", "RECEIVER");
                connectingObj.put("message", "Discovering host on local Wi-Fi...");
                notifyListeners("localTransportStatus", connectingObj);

                localDiscoveryListener = new NsdManager.DiscoveryListener() {
                    @Override
                    public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                        Log.e(TAG, "[LOCAL_WIFI] Discovery failed to start: " + errorCode);
                        JSObject statusObj = new JSObject();
                        statusObj.put("status", "ERROR");
                        statusObj.put("message", "Discovery failed: code " + errorCode);
                        notifyListeners("localTransportStatus", statusObj);
                    }

                    @Override
                    public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                        Log.w(TAG, "[LOCAL_WIFI] Stop discovery failed: " + errorCode);
                    }

                    @Override
                    public void onDiscoveryStarted(String serviceType) {
                        Log.i(TAG, "[LOCAL_WIFI] NSD Discovery started for type: " + serviceType);
                    }

                    @Override
                    public void onDiscoveryStopped(String serviceType) {
                        Log.i(TAG, "[LOCAL_WIFI] NSD Discovery stopped");
                    }

                    @Override
                    public void onServiceFound(NsdServiceInfo serviceInfo) {
                        Log.i(TAG, "[LOCAL_WIFI] Service found: " + serviceInfo.getServiceName());
                        String name = serviceInfo.getServiceName();
                        if (name != null && activeLocalRoomCode != null && name.contains(activeLocalRoomCode) && !isLocalConnecting) {
                            isLocalConnecting = true;
                            Log.i(TAG, "[LOCAL_WIFI] Matching service found: " + name + ". Resolving...");

                            try {
                                nsdManager.resolveService(serviceInfo, new NsdManager.ResolveListener() {
                                    @Override
                                    public void onResolveFailed(NsdServiceInfo nsdServiceInfo, int errorCode) {
                                        Log.e(TAG, "[LOCAL_WIFI] Resolve failed: " + errorCode);
                                        isLocalConnecting = false;
                                    }

                                    @Override
                                    public void onServiceResolved(NsdServiceInfo resolvedService) {
                                        if (resolvedService == null || resolvedService.getHost() == null) {
                                            Log.w(TAG, "[LOCAL_WIFI] Resolved service or host is null");
                                            isLocalConnecting = false;
                                            return;
                                        }
                                        Log.i(TAG, "[LOCAL_WIFI] Service resolved: " + resolvedService.getHost() + ":" + resolvedService.getPort());
                                        connectToHost(resolvedService.getHost().getHostAddress(), resolvedService.getPort());
                                    }
                                });
                            } catch (Exception ex) {
                                Log.e(TAG, "[LOCAL_WIFI] Error calling resolveService: " + ex.getMessage());
                                isLocalConnecting = false;
                            }
                        }
                    }

                    @Override
                    public void onServiceLost(NsdServiceInfo serviceInfo) {
                        Log.w(TAG, "[LOCAL_WIFI] Service lost: " + serviceInfo.getServiceName());
                    }
                };

                nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, localDiscoveryListener);

                // Hotspot DHCP Gateway fallback check: If on a Wi-Fi Hotspot without mDNS routing
                executorService.execute(() -> {
                    try {
                        Thread.sleep(4000);
                        if (isLocalTransportRunning && activeLocalSocket == null && !isLocalConnecting) {
                            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                            if (wifi != null) {
                                android.net.DhcpInfo dhcp = wifi.getDhcpInfo();
                                if (dhcp != null && dhcp.gateway != 0) {
                                    int g = dhcp.gateway;
                                    String gatewayIp = String.format(java.util.Locale.US, "%d.%d.%d.%d", (g & 0xff), (g >> 8 & 0xff), (g >> 16 & 0xff), (g >> 24 & 0xff));
                                    Log.i(TAG, "[LOCAL_WIFI] Probing Hotspot DHCP gateway IP: " + gatewayIp);
                                }
                            }
                        }
                    } catch (Exception ignored) {}
                });

                JSObject res = new JSObject();
                res.put("success", true);
                call.resolve(res);

            } catch (Exception e) {
                Log.e(TAG, "[LOCAL_WIFI] Error starting receiver: " + e.getMessage(), e);
                cleanupLocalTransport();
                call.reject("Failed to start local receiver: " + e.getMessage(), e);
            }
        });
    }

    private void connectToHost(String hostAddress, int port) {
        executorService.execute(() -> {
            try {
                Log.i(TAG, "[LOCAL_WIFI] Connecting to host at " + hostAddress + ":" + port);
                Socket socket = new Socket(hostAddress, port);
                socket.setTcpNoDelay(true);

                BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));

                // Send authentication handshake
                JSONObject authReq = new JSONObject();
                authReq.put("type", "AUTH_JOIN");
                authReq.put("roomCode", activeLocalRoomCode);
                writer.write(authReq.toString() + "\n");
                writer.flush();

                // Wait for AUTH_OK
                String responseLine = reader.readLine();
                if (responseLine == null) {
                    socket.close();
                    throw new IOException("Host closed connection during authentication");
                }

                JSONObject respJson = new JSONObject(responseLine);
                if (!"AUTH_OK".equals(respJson.optString("type"))) {
                    socket.close();
                    throw new IOException("Authentication rejected by host: " + respJson.optString("reason"));
                }

                Log.i(TAG, "[LOCAL_WIFI] Successfully authenticated with Host!");
                isLocalConnecting = false;
                synchronized (this) {
                    activeLocalSocket = socket;
                    localSocketWriter = writer;
                }

                JSObject statusObj = new JSObject();
                statusObj.put("status", "CONNECTED");
                statusObj.put("role", "RECEIVER");
                statusObj.put("host", hostAddress);
                statusObj.put("port", port);
                notifyListeners("localTransportStatus", statusObj);

                // Stop discovery once connected
                if (nsdManager != null && localDiscoveryListener != null) {
                    try {
                        nsdManager.stopServiceDiscovery(localDiscoveryListener);
                        localDiscoveryListener = null;
                    } catch (Exception ignored) {}
                }

                // Message read loop
                listenToSocketMessages(reader);

            } catch (Exception e) {
                isLocalConnecting = false;
                Log.e(TAG, "[LOCAL_WIFI] Connection to host failed: " + e.getMessage());
                if (isLocalTransportRunning) {
                    JSObject statusObj = new JSObject();
                    statusObj.put("status", "DISCONNECTED");
                    statusObj.put("role", "RECEIVER");
                    statusObj.put("message", e.getMessage());
                    notifyListeners("localTransportStatus", statusObj);
                }
            }
        });
    }

    private void listenToSocketMessages(BufferedReader reader) {
        try {
            String line;
            while (isLocalTransportRunning && (line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) continue;
                JSObject msgObj = new JSObject();
                msgObj.put("message", line);
                notifyListeners("localMessageReceived", msgObj);
            }
        } catch (Exception e) {
            if (isLocalTransportRunning) {
                Log.w(TAG, "[LOCAL_WIFI] Socket read error / EOF: " + e.getMessage());
            }
        } finally {
            if (isLocalTransportRunning) {
                JSObject statusObj = new JSObject();
                statusObj.put("status", "DISCONNECTED");
                statusObj.put("role", localRole);
                statusObj.put("message", "Connection closed by remote peer");
                notifyListeners("localTransportStatus", statusObj);
            }
        }
    }

    @PluginMethod
    public void sendLocalMessage(PluginCall call) {
        String message = call.getString("message");
        if (message == null) {
            call.reject("message parameter is required");
            return;
        }

        executorService.execute(() -> {
            try {
                synchronized (this) {
                    if (localSocketWriter != null) {
                        localSocketWriter.write(message + "\n");
                        localSocketWriter.flush();
                        call.resolve();
                        return;
                    }
                }
                call.reject("No active local socket connection");
            } catch (Exception e) {
                Log.e(TAG, "[LOCAL_WIFI] Error sending local message: " + e.getMessage());
                call.reject("Failed to send message: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void stopLocalTransport(PluginCall call) {
        executorService.execute(() -> {
            cleanupLocalTransport();
            JSObject statusObj = new JSObject();
            statusObj.put("status", "DISCONNECTED");
            statusObj.put("role", "NONE");
            notifyListeners("localTransportStatus", statusObj);
            if (call != null) {
                call.resolve();
            }
        });
    }
}
