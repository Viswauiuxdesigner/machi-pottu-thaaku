package us.mediagrid.capacitorjs.plugins.nativeaudio;

import android.content.Context;
import android.net.Uri;
import android.os.Binder;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.os.PowerManager;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public class AudioSource extends Binder {

    private static final String TAG = "AudioSource";

    public String id;
    public String trackId;
    public String source;
    public AudioMetadata audioMetadata;
    public boolean useForNotification;
    public boolean isBackgroundMusic;
    public boolean loopAudio = false;

    public String onPlaybackStatusChangeCallbackId;
    public String onReadyCallbackId;
    public String onEndCallbackId;

    private AudioPlayerPlugin pluginOwner;

    private Player player;
    private PlayerEventListener playerEventListener;

    private boolean isPlaying = false;
    private boolean isStopped = true;

    private PowerManager.WakeLock transitionWakeLock;

    public String currentQueueItemUid = null;
    public static final int REPEAT_MODE_OFF = 0;
    public static final int REPEAT_MODE_ONE = 1;
    public static final int REPEAT_MODE_ALL = 2;
    private int masterRepeatMode = REPEAT_MODE_OFF;
    private final java.util.concurrent.atomic.AtomicInteger pendingPreviousRequests = new java.util.concurrent.atomic.AtomicInteger(0);

    private final List<QueueItem> masterPlaylist = Collections.synchronizedList(new ArrayList<>());
    private final Set<String> enqueuedTrackIds = Collections.synchronizedSet(new HashSet<>());
    private final ExecutorService backgroundQueueExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private String resolveEndpoint = "https://starlit-sable-83184f.netlify.app/.netlify/functions/music-play";
    private static final int LOOKAHEAD_WINDOW = 4;
    private boolean isReplenishing = false;
    private int consecutiveFailureCount = 0;
    private static final int MAX_CONSECUTIVE_FAILURES = 3;

    public static boolean isValidLocalFile(String uriStr) {
        if (uriStr == null || uriStr.trim().isEmpty()) return false;
        try {
            android.net.Uri uri = android.net.Uri.parse(uriStr);
            String scheme = uri.getScheme();
            if ("file".equalsIgnoreCase(scheme)) {
                java.io.File file = new java.io.File(uri.getPath());
                return file.exists() && file.length() > 0;
            }
            if ("content".equalsIgnoreCase(scheme)) {
                return true;
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    public static String extractTrackIdFromMediaId(String mediaId) {
        if (mediaId == null) return null;
        int sep = mediaId.indexOf("::");
        return (sep != -1) ? mediaId.substring(0, sep) : mediaId;
    }

    public static String extractQueueUidFromMediaId(String mediaId) {
        if (mediaId == null) return null;
        int sep = mediaId.indexOf("::");
        return (sep != -1) ? mediaId.substring(sep + 2) : null;
    }

    public AudioSource(
        AudioPlayerPlugin pluginOwner,
        String id,
        String source,
        AudioMetadata audioMetadata,
        boolean useForNotification,
        boolean isBackgroundMusic,
        boolean loopAudio
    ) {
        this.pluginOwner = pluginOwner;
        this.id = id;
        this.source = source;
        this.audioMetadata = audioMetadata;
        this.useForNotification = useForNotification;
        this.isBackgroundMusic = isBackgroundMusic;
        this.loopAudio = loopAudio;

        this.audioMetadata.setPluginOwner(pluginOwner).setUpdateCallBack(this::updateMetadata);
    }

    public void initialize(Context context) {
        if (useForNotification || player != null) {
            return;
        }

        setIsStopped();

        player = new ExoPlayer.Builder(context).setWakeMode(C.WAKE_MODE_NETWORK).build();
        setPlayerAttributes();

        player.prepare();
    }

    public void setPlayerAttributes() {
        player.setAudioAttributes(
            new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build(),
            useForNotification
        );

        player.setMediaItem(buildMediaItem());
        player.setRepeatMode(loopAudio ? ExoPlayer.REPEAT_MODE_ONE : ExoPlayer.REPEAT_MODE_OFF);
        player.setPlayWhenReady(false);
        player.addListener(new PlayerEventListener(pluginOwner, this));
    }

    public void changeAudioSource(String newSource) {
        changeAudioSource(newSource, null);
    }

    public void changeAudioSource(String newSource, String newTrackId) {
        releaseTransitionWakeLock();
        source = newSource;
        if (newTrackId != null && !newTrackId.isEmpty()) {
            trackId = newTrackId;
        } else {
            trackId = null;
        }
        consecutiveFailureCount = 0;

        synchronized (enqueuedTrackIds) {
            enqueuedTrackIds.clear();
            if (trackId != null) {
                enqueuedTrackIds.add(trackId);
            }
        }

        Player player = getPlayer();

        player.setMediaItem(buildMediaItem(), true);
        player.setPlayWhenReady(false);
        player.prepare();
    }

    public static class QueueItem {
        public final String queueItemUid;
        public String source;
        public String trackId;
        public String friendlyTitle;
        public String artistName;
        public String albumTitle;
        public String artworkSource;
        public String s3Key;
        public long urlFetchedAt;
        public boolean isOffline;
        public int retryCount;

        public QueueItem(
            String source,
            String trackId,
            String friendlyTitle,
            String artistName,
            String albumTitle,
            String artworkSource,
            String s3Key,
            long urlFetchedAt,
            boolean isOffline
        ) {
            this.queueItemUid = java.util.UUID.randomUUID().toString();
            this.source = source;
            this.trackId = trackId;
            this.friendlyTitle = friendlyTitle;
            this.artistName = artistName;
            this.albumTitle = albumTitle;
            this.artworkSource = artworkSource;
            this.s3Key = s3Key;
            this.urlFetchedAt = urlFetchedAt;
            this.isOffline = isOffline;
            this.retryCount = 0;
        }

        public QueueItem(
            String source,
            String trackId,
            String friendlyTitle,
            String artistName,
            String albumTitle,
            String artworkSource,
            String s3Key,
            long urlFetchedAt
        ) {
            this(source, trackId, friendlyTitle, artistName, albumTitle, artworkSource, s3Key, urlFetchedAt, false);
        }

        public QueueItem(
            String source,
            String trackId,
            String friendlyTitle,
            String artistName,
            String albumTitle,
            String artworkSource,
            String s3Key
        ) {
            this(source, trackId, friendlyTitle, artistName, albumTitle, artworkSource, s3Key, 0L, false);
        }

        public boolean isOfflineTrack() {
            if (isOffline) {
                return true;
            }
            if (source != null) {
                String lower = source.toLowerCase();
                if (lower.startsWith("file:") || lower.startsWith("content:")) {
                    return true;
                }
            }
            return false;
        }

        public boolean isUrlExpired() {
            if (isOfflineTrack()) return false;
            if (source == null || source.isEmpty()) return true;
            if (urlFetchedAt > 0 && (System.currentTimeMillis() - urlFetchedAt > 45 * 60 * 1000L)) {
                return true;
            }
            return false;
        }
    }

    public static String fetchSignedUrl(String endpoint, String s3Key) {
        if (s3Key == null || s3Key.trim().isEmpty()) {
            return null;
        }
        String trimmedKey = s3Key.trim();
        while (trimmedKey.startsWith("/")) {
            trimmedKey = trimmedKey.substring(1);
        }
        if (trimmedKey.isEmpty() || trimmedKey.contains("..")) {
            Log.w(TAG, "Invalid s3Key rejected before request: " + s3Key);
            return null;
        }

        HttpURLConnection conn = null;
        try {
            String base = (endpoint != null && !endpoint.trim().isEmpty())
                ? endpoint
                : "https://starlit-sable-83184f.netlify.app/.netlify/functions/music-play";
            String sep = base.contains("?") ? "&" : "?";
            URL url = new URL(base + sep + "key=" + URLEncoder.encode(trimmedKey, "UTF-8"));
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", "MachiPottuThaaku/1.0 (Android)");
            conn.setRequestProperty("Accept", "application/json");
            conn.connect();

            int code = conn.getResponseCode();
            if (code >= 200 && code < 300) {
                InputStream in = conn.getInputStream();
                BufferedReader reader = new BufferedReader(new InputStreamReader(in, "UTF-8"));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line);
                }
                reader.close();
                String responseBody = sb.toString().trim();
                if (!responseBody.isEmpty()) {
                    JSONObject json = new JSONObject(responseBody);
                    if (json.has("url")) {
                        String signedUrl = json.getString("url");
                        if (signedUrl != null && !signedUrl.trim().isEmpty()) {
                            return signedUrl.trim();
                        }
                    }
                }
            } else {
                Log.w(TAG, "fetchSignedUrl HTTP " + code + " for s3Key=" + trimmedKey);
            }
        } catch (Exception e) {
            Log.e(TAG, "fetchSignedUrl failed for s3Key=" + trimmedKey, e);
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignored) {}
            }
        }
        return null;
    }

    public MediaItem buildMediaItem(QueueItem item) {
        MediaMetadata.Builder metaBuilder = new MediaMetadata.Builder()
            .setTitle(item.friendlyTitle == null ? "" : item.friendlyTitle)
            .setArtist(item.artistName == null ? "" : item.artistName)
            .setAlbumTitle(item.albumTitle == null ? "" : item.albumTitle);

        if (useForNotification && item.artworkSource != null && !item.artworkSource.isEmpty()) {
            try {
                if (
                    item.artworkSource.startsWith("https:") ||
                    item.artworkSource.startsWith("http:")
                ) {
                    metaBuilder.setArtworkUri(Uri.parse(item.artworkSource));
                }
            } catch (Exception ex) {
                Log.w(TAG, "Could not parse artwork for queued track", ex);
            }
        }

        MediaItem.Builder builder = new MediaItem.Builder()
            .setUri(item.source)
            .setMediaMetadata(metaBuilder.build());

        String mediaId = (item.trackId != null ? item.trackId : "") + "::" + item.queueItemUid;
        builder.setMediaId(mediaId);

        return builder.build();
    }

    public void setQueue(java.util.List<QueueItem> items, int startIndex) {
        setQueue(items, startIndex, null);
    }

    public void setQueue(java.util.List<QueueItem> items, int startIndex, String endpoint) {
        Player player = getPlayer();
        if (player == null || items == null || items.isEmpty()) {
            return;
        }

        if (endpoint != null && !endpoint.trim().isEmpty()) {
            this.resolveEndpoint = endpoint;
        }

        releaseTransitionWakeLock();
        consecutiveFailureCount = 0;

        synchronized (masterPlaylist) {
            masterPlaylist.clear();
            masterPlaylist.addAll(items);
        }
        synchronized (enqueuedTrackIds) {
            enqueuedTrackIds.clear();
        }

        int safeIndex = Math.max(0, Math.min(startIndex, items.size() - 1));
        QueueItem current = items.get(safeIndex);
        this.currentQueueItemUid = current.queueItemUid;
        this.trackId = current.trackId;
        this.source = current.source;
        if (audioMetadata != null) {
            audioMetadata.songTitle = current.friendlyTitle;
            audioMetadata.artistName = current.artistName;
            audioMetadata.albumTitle = current.albumTitle;
            audioMetadata.artworkSource = current.artworkSource;
        }

        java.util.List<MediaItem> initialMediaItems = new java.util.ArrayList<>();
        if (current.source != null && !current.source.isEmpty()) {
            initialMediaItems.add(buildMediaItem(current));
            if (current.queueItemUid != null) {
                enqueuedTrackIds.add(current.queueItemUid);
            } else if (current.trackId != null) {
                enqueuedTrackIds.add(current.trackId);
            }
        }

        for (int i = safeIndex + 1; i < Math.min(items.size(), safeIndex + 1 + LOOKAHEAD_WINDOW); i++) {
            QueueItem nextItem = items.get(i);
            if (nextItem.source != null && !nextItem.source.isEmpty()) {
                initialMediaItems.add(buildMediaItem(nextItem));
                if (nextItem.queueItemUid != null) {
                    enqueuedTrackIds.add(nextItem.queueItemUid);
                } else if (nextItem.trackId != null) {
                    enqueuedTrackIds.add(nextItem.trackId);
                }
            }
        }

        if (!initialMediaItems.isEmpty()) {
            player.setMediaItems(initialMediaItems, 0, 0);
            player.setPlayWhenReady(false);
            player.prepare();
            Log.i(TAG, "setQueue: loaded " + initialMediaItems.size() + " initial items, total master=" + items.size());
        }

        replenishQueueLookahead();
    }

    public void replenishQueueLookahead() {
        backgroundQueueExecutor.execute(() -> {
            synchronized (this) {
                if (isReplenishing) return;
                isReplenishing = true;
            }
            try {
                Player player = getPlayer();
                if (player == null) return;

                String currentPlayingTrackId = this.trackId;
                String currentPlayingUid = this.currentQueueItemUid;
                int currentMasterIdx = -1;
                synchronized (masterPlaylist) {
                    for (int i = 0; i < masterPlaylist.size(); i++) {
                        QueueItem q = masterPlaylist.get(i);
                        if (currentPlayingUid != null && currentPlayingUid.equals(q.queueItemUid)) {
                            currentMasterIdx = i;
                            break;
                        }
                        if (currentMasterIdx == -1 && currentPlayingTrackId != null && currentPlayingTrackId.equals(q.trackId)) {
                            currentMasterIdx = i;
                        }
                    }
                }

                if (currentMasterIdx == -1) {
                    return;
                }

                int masterCount;
                synchronized (masterPlaylist) {
                    masterCount = masterPlaylist.size();
                }

                int lookaheadSteps = Math.min(LOOKAHEAD_WINDOW, masterCount > 0 ? masterCount - 1 : 0);
                for (int step = 1; step <= lookaheadSteps; step++) {
                    int i = currentMasterIdx + step;
                    if (masterRepeatMode == REPEAT_MODE_ALL && masterCount > 0) {
                        i = i % masterCount;
                    } else if (i >= masterCount) {
                        break;
                    }

                    QueueItem item;
                    synchronized (masterPlaylist) {
                        item = masterPlaylist.get(i);
                    }
                    if (item == null) continue;

                    String lookaheadKey = (item.queueItemUid != null) ? item.queueItemUid : item.trackId;
                    if (lookaheadKey != null && enqueuedTrackIds.contains(lookaheadKey)) {
                        continue;
                    }

                    if (item.isOfflineTrack()) {
                        if (item.source == null || !isValidLocalFile(item.source)) {
                            Log.w(TAG, "Offline track missing verified local source on disk: " + item.trackId);
                            continue;
                        }
                    } else if (item.source == null || item.source.isEmpty() || item.isUrlExpired()) {
                        if (item.s3Key != null && !item.s3Key.isEmpty()) {
                            Log.i(TAG, "Native autonomous URL fetch for track: " + item.trackId + " (s3Key=" + item.s3Key + ")");
                            String resolvedUrl = fetchSignedUrl(resolveEndpoint, item.s3Key);
                            if (resolvedUrl != null) {
                                item.source = resolvedUrl;
                                item.urlFetchedAt = System.currentTimeMillis();
                            } else {
                                Log.w(TAG, "Native URL fetch failed for track: " + item.trackId);
                                continue;
                            }
                        }
                    }

                    if (item.source != null && !item.source.isEmpty()) {
                        final QueueItem readyItem = item;
                        mainHandler.post(() -> {
                            Player p = getPlayer();
                            if (p != null) {
                                synchronized (enqueuedTrackIds) {
                                    boolean alreadyInPlayer = false;
                                    String itemKey = (readyItem.queueItemUid != null) ? readyItem.queueItemUid : readyItem.trackId;
                                    if (itemKey != null) {
                                        if (enqueuedTrackIds.contains(itemKey)) {
                                            alreadyInPlayer = true;
                                        } else {
                                            int pCount = p.getMediaItemCount();
                                            for (int pi = 0; pi < pCount; pi++) {
                                                MediaItem pItem = p.getMediaItemAt(pi);
                                                if (pItem.mediaId != null && (pItem.mediaId.endsWith("::" + readyItem.queueItemUid) || pItem.mediaId.equals(readyItem.trackId))) {
                                                    alreadyInPlayer = true;
                                                    enqueuedTrackIds.add(itemKey);
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                    if (!alreadyInPlayer) {
                                        p.addMediaItem(buildMediaItem(readyItem));
                                        if (itemKey != null) {
                                            enqueuedTrackIds.add(itemKey);
                                        }
                                        Log.i(TAG, "Autonomous native enqueue: added " + readyItem.trackId + " (uid=" + readyItem.queueItemUid + ", total player items=" + p.getMediaItemCount() + ")");
                                    }
                                }
                            }
                        });
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Error in replenishQueueLookahead", e);
            } finally {
                synchronized (this) {
                    isReplenishing = false;
                }
            }
        });
    }

    public void onAutoTransitioned(MediaItem mediaItem) {
        updateCurrentMedia(mediaItem);
        replenishQueueLookahead();
    }

    public void handlePlaybackError(androidx.media3.common.PlaybackException error) {
        Player player = getPlayer();
        if (player == null) return;

        int currentIdx = player.getCurrentMediaItemIndex();
        MediaItem currentItem = player.getCurrentMediaItem();
        String currentMediaId = currentItem != null ? currentItem.mediaId : null;

        Log.w(TAG, "handlePlaybackError for mediaId=" + currentMediaId + " at index=" + currentIdx + ": " + error.getMessage());

        QueueItem failedItem = null;
        if (currentMediaId != null) {
            String targetUid = extractQueueUidFromMediaId(currentMediaId);
            String targetTrackId = extractTrackIdFromMediaId(currentMediaId);
            synchronized (masterPlaylist) {
                for (QueueItem item : masterPlaylist) {
                    if (targetUid != null && targetUid.equals(item.queueItemUid)) {
                        failedItem = item;
                        break;
                    }
                    if (targetUid == null && targetTrackId != null && targetTrackId.equals(item.trackId)) {
                        failedItem = item;
                        break;
                    }
                }
            }
        }

        consecutiveFailureCount++;
        if (consecutiveFailureCount >= MAX_CONSECUTIVE_FAILURES) {
            Log.e(TAG, "Circuit breaker tripped: " + consecutiveFailureCount + " consecutive track failures. Halting auto-recovery.");
            haltPlaybackOnError("Playback stopped after multiple failures. Tap play to retry when connected.");
            return;
        }

        if (failedItem != null && failedItem.isOfflineTrack()) {
            Log.e(TAG, "Offline track failed to play (missing or corrupt file): " + failedItem.trackId);
            haltPlaybackOnError("Downloaded file missing or damaged. Please re-download.");
            return;
        }

        if (failedItem != null && !failedItem.isOfflineTrack() && failedItem.s3Key != null && !failedItem.s3Key.isEmpty()) {
            if (failedItem.retryCount < 1) {
                failedItem.retryCount++;
                acquireTransitionWakeLock();
                final QueueItem itemToRecover = failedItem;
                backgroundQueueExecutor.execute(() -> {
                    Log.i(TAG, "Attempting autonomous URL refresh on error (attempt " + itemToRecover.retryCount + ") for: " + itemToRecover.trackId);
                    String freshUrl = fetchSignedUrl(resolveEndpoint, itemToRecover.s3Key);
                    if (freshUrl != null) {
                        itemToRecover.source = freshUrl;
                        itemToRecover.urlFetchedAt = System.currentTimeMillis();
                        mainHandler.post(() -> {
                            Player p = getPlayer();
                            if (p != null) {
                                try {
                                    int idx = p.getCurrentMediaItemIndex();
                                    p.replaceMediaItem(idx, buildMediaItem(itemToRecover));
                                    p.prepare();
                                    p.play();
                                    Log.i(TAG, "Autonomous URL refresh successful! Resumed playback for: " + itemToRecover.trackId);
                                } catch (Exception ex) {
                                    Log.e(TAG, "Failed to resume playback after URL refresh", ex);
                                    autoRecoverToNextItem();
                                }
                            }
                        });
                    } else {
                        Log.w(TAG, "URL refresh returned null, advancing to next item");
                        mainHandler.post(this::autoRecoverToNextItem);
                    }
                });
                return;
            } else {
                Log.w(TAG, "Track " + failedItem.trackId + " has already exhausted retry limit (" + failedItem.retryCount + ")");
            }
        }

        autoRecoverToNextItem();
    }

    private void autoRecoverToNextItem() {
        Player player = getPlayer();
        if (player != null && player.getCurrentMediaItemIndex() < player.getMediaItemCount() - 1) {
            Log.i(TAG, "Auto-recovering to next media item in ExoPlayer");
            acquireTransitionWakeLock();
            try {
                player.seekToNextMediaItem();
                player.prepare();
                player.play();
                return;
            } catch (Exception e) {
                Log.e(TAG, "autoRecoverToNextItem failed", e);
            }
        }

        haltPlaybackOnError("Unable to play track. Tap play to retry.");
    }

    private void haltPlaybackOnError(String message) {
        releaseTransitionWakeLock();
        setIsStopped();
        if (audioMetadata != null) {
            audioMetadata.stopUpdater();
        }
        Player p = getPlayer();
        if (p != null) {
            try {
                p.pause();
            } catch (Exception ignored) {}
        }
        if (pluginOwner != null && onPlaybackStatusChangeCallbackId != null) {
            JSObject errObj = new JSObject()
                .put("status", "error")
                .put("errorMessage", message != null ? message : "Playback error");
            PluginCall call = pluginOwner.getBridge().getSavedCall(onPlaybackStatusChangeCallbackId);
            if (call != null) {
                call.resolve(errObj);
            }
        }
    }

    public boolean advanceNextInMaster() {
        return advanceNextInMaster(null);
    }

    public boolean advanceNextInMaster(Player targetPlayer) {
        Player player = (targetPlayer != null) ? targetPlayer : getPlayer();
        if (player == null) return false;

        int nextMasterIdx = -1;
        QueueItem nextItem = null;
        synchronized (masterPlaylist) {
            for (int i = 0; i < masterPlaylist.size(); i++) {
                QueueItem item = masterPlaylist.get(i);
                if (this.currentQueueItemUid != null && this.currentQueueItemUid.equals(item.queueItemUid)) {
                    if (i + 1 < masterPlaylist.size()) {
                        nextMasterIdx = i + 1;
                        nextItem = masterPlaylist.get(i + 1);
                    } else if (masterRepeatMode == REPEAT_MODE_ALL && masterPlaylist.size() > 0) {
                        nextMasterIdx = 0;
                        nextItem = masterPlaylist.get(0);
                    }
                    break;
                }
                if (nextMasterIdx == -1 && this.trackId != null && this.trackId.equals(item.trackId)) {
                    if (i + 1 < masterPlaylist.size()) {
                        nextMasterIdx = i + 1;
                        nextItem = masterPlaylist.get(i + 1);
                    } else if (masterRepeatMode == REPEAT_MODE_ALL && masterPlaylist.size() > 0) {
                        nextMasterIdx = 0;
                        nextItem = masterPlaylist.get(0);
                    }
                }
            }
        }

        if (nextItem != null) {
            final QueueItem itemToPlay = nextItem;
            acquireTransitionWakeLock();
            backgroundQueueExecutor.execute(() -> {
                boolean transitionDispatched = false;
                try {
                    if (itemToPlay.isOfflineTrack()) {
                        if (itemToPlay.source == null || !isValidLocalFile(itemToPlay.source)) {
                            Log.e(TAG, "advanceNextInMaster: Offline track missing or corrupt: " + itemToPlay.trackId);
                            mainHandler.post(() -> haltPlaybackOnError("Downloaded file missing or damaged. Please re-download."));
                            return;
                        }
                    } else if (itemToPlay.source == null || itemToPlay.source.isEmpty() || itemToPlay.isUrlExpired()) {
                        if (itemToPlay.s3Key != null) {
                            String url = fetchSignedUrl(resolveEndpoint, itemToPlay.s3Key);
                            if (url != null) {
                                itemToPlay.source = url;
                                itemToPlay.urlFetchedAt = System.currentTimeMillis();
                            }
                        }
                    }

                    if (itemToPlay.source != null && !itemToPlay.source.isEmpty()) {
                        transitionDispatched = true;
                        boolean posted = mainHandler.post(() -> {
                            Player p = (targetPlayer != null) ? targetPlayer : getPlayer();
                            if (p != null) {
                                try {
                                    this.currentQueueItemUid = itemToPlay.queueItemUid;
                                    this.trackId = itemToPlay.trackId;
                                    this.source = itemToPlay.source;

                                    int currentIdx = p.getCurrentMediaItemIndex();
                                    int count = p.getMediaItemCount();
                                    boolean alreadyAfterCurrent = false;
                                    int targetIndex = -1;

                                    for (int pi = currentIdx + 1; pi < count; pi++) {
                                        MediaItem pItem = p.getMediaItemAt(pi);
                                        if (pItem.mediaId != null && pItem.mediaId.endsWith("::" + itemToPlay.queueItemUid)) {
                                            alreadyAfterCurrent = true;
                                            targetIndex = pi;
                                            break;
                                        }
                                    }

                                    if (!alreadyAfterCurrent) {
                                        p.addMediaItem(buildMediaItem(itemToPlay));
                                        targetIndex = p.getMediaItemCount() - 1;
                                        synchronized (enqueuedTrackIds) {
                                            if (itemToPlay.queueItemUid != null) {
                                                enqueuedTrackIds.add(itemToPlay.queueItemUid);
                                            } else if (itemToPlay.trackId != null) {
                                                enqueuedTrackIds.add(itemToPlay.trackId);
                                            }
                                        }
                                    }

                                    if (targetIndex != -1) {
                                        p.seekToDefaultPosition(targetIndex);
                                        p.prepare();
                                        p.play();
                                        replenishQueueLookahead();
                                    } else {
                                        releaseTransitionWakeLock();
                                    }
                                } catch (Exception ex) {
                                    Log.e(TAG, "Error playing next master item in ExoPlayer", ex);
                                    releaseTransitionWakeLock();
                                }
                            } else {
                                releaseTransitionWakeLock();
                            }
                        });
                        if (!posted) {
                            transitionDispatched = false;
                        }
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error in advanceNextInMaster background task", e);
                } finally {
                    if (!transitionDispatched) {
                        releaseTransitionWakeLock();
                    }
                }
            });
            return true;
        }
        return false;
    }

    public boolean advancePreviousInMaster() {
        return advancePreviousInMaster(null);
    }

    public boolean advancePreviousInMaster(Player targetPlayer) {
        Player player = (targetPlayer != null) ? targetPlayer : getPlayer();
        if (player == null) return false;

        pendingPreviousRequests.incrementAndGet();

        mainHandler.post(() -> {
            int skipCount = pendingPreviousRequests.getAndSet(0);
            if (skipCount <= 0) return;

            Player p = (targetPlayer != null) ? targetPlayer : getPlayer();
            if (p == null) return;

            int currentExoIdx = p.getCurrentMediaItemIndex();
            if (currentExoIdx >= skipCount) {
                p.seekToDefaultPosition(currentExoIdx - skipCount);
                p.prepare();
                p.play();
                return;
            }

            int currentMasterIdx = -1;
            synchronized (masterPlaylist) {
                for (int i = 0; i < masterPlaylist.size(); i++) {
                    QueueItem item = masterPlaylist.get(i);
                    if (this.currentQueueItemUid != null && this.currentQueueItemUid.equals(item.queueItemUid)) {
                        currentMasterIdx = i;
                        break;
                    }
                    if (currentMasterIdx == -1 && this.trackId != null && this.trackId.equals(item.trackId)) {
                        currentMasterIdx = i;
                    }
                }
            }

            if (currentMasterIdx == -1) {
                p.seekTo(0);
                return;
            }

            int targetMasterIdx = currentMasterIdx - skipCount;
            int masterCount;
            synchronized (masterPlaylist) {
                masterCount = masterPlaylist.size();
            }

            if (targetMasterIdx < 0) {
                if (masterRepeatMode == REPEAT_MODE_ALL && masterCount > 0) {
                    targetMasterIdx = ((targetMasterIdx % masterCount) + masterCount) % masterCount;
                } else {
                    Log.i(TAG, "advancePreviousInMaster: Start of playlist reached (Repeat Off). Seeking to 0:00.");
                    p.seekTo(0);
                    return;
                }
            }

            QueueItem itemToPlay;
            synchronized (masterPlaylist) {
                itemToPlay = masterPlaylist.get(targetMasterIdx);
            }

            if (itemToPlay == null) return;

            acquireTransitionWakeLock();
            final QueueItem targetItem = itemToPlay;
            backgroundQueueExecutor.execute(() -> {
                boolean transitionDispatched = false;
                try {
                    if (targetItem.isOfflineTrack()) {
                        if (targetItem.source == null || !isValidLocalFile(targetItem.source)) {
                            Log.e(TAG, "advancePreviousInMaster: Offline track missing or corrupt: " + targetItem.trackId);
                            mainHandler.post(() -> haltPlaybackOnError("Downloaded file missing or damaged. Please re-download."));
                            return;
                        }
                    } else if (targetItem.source == null || targetItem.source.isEmpty() || targetItem.isUrlExpired()) {
                        if (targetItem.s3Key != null) {
                            String url = fetchSignedUrl(resolveEndpoint, targetItem.s3Key);
                            if (url != null) {
                                targetItem.source = url;
                                targetItem.urlFetchedAt = System.currentTimeMillis();
                            }
                        }
                    }

                    if (targetItem.source != null && !targetItem.source.isEmpty()) {
                        transitionDispatched = true;
                        mainHandler.post(() -> {
                            Player pl = (targetPlayer != null) ? targetPlayer : getPlayer();
                            if (pl != null) {
                                try {
                                    this.currentQueueItemUid = targetItem.queueItemUid;
                                    this.trackId = targetItem.trackId;
                                    this.source = targetItem.source;

                                    MediaItem mi = buildMediaItem(targetItem);
                                    pl.addMediaItem(0, mi);
                                    synchronized (enqueuedTrackIds) {
                                        if (targetItem.queueItemUid != null) {
                                            enqueuedTrackIds.add(targetItem.queueItemUid);
                                        } else if (targetItem.trackId != null) {
                                            enqueuedTrackIds.add(targetItem.trackId);
                                        }
                                    }
                                    pl.seekToDefaultPosition(0);
                                    pl.prepare();
                                    pl.play();
                                    replenishQueueLookahead();
                                } catch (Exception ex) {
                                    Log.e(TAG, "Error playing previous master item in ExoPlayer", ex);
                                    releaseTransitionWakeLock();
                                }
                            } else {
                                releaseTransitionWakeLock();
                            }
                        });
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error in advancePreviousInMaster background worker", e);
                } finally {
                    if (!transitionDispatched) {
                        releaseTransitionWakeLock();
                    }
                }
            });
        });

        return true;
    }

    public void playNext(QueueItem item) {
        if (item == null) return;
        Player player = getPlayer();
        if (player == null) return;

        mainHandler.post(() -> {
            int insertMasterIdx = 0;
            synchronized (masterPlaylist) {
                int currentIdx = -1;
                for (int i = 0; i < masterPlaylist.size(); i++) {
                    if (this.currentQueueItemUid != null && this.currentQueueItemUid.equals(masterPlaylist.get(i).queueItemUid)) {
                        currentIdx = i;
                        break;
                    }
                    if (currentIdx == -1 && this.trackId != null && this.trackId.equals(masterPlaylist.get(i).trackId)) {
                        currentIdx = i;
                    }
                }
                insertMasterIdx = (currentIdx != -1) ? currentIdx + 1 : masterPlaylist.size();
                masterPlaylist.add(insertMasterIdx, item);
            }

            int currentExoIdx = player.getCurrentMediaItemIndex();
            int insertExoIdx = currentExoIdx + 1;
            player.addMediaItem(insertExoIdx, buildMediaItem(item));
            synchronized (enqueuedTrackIds) {
                if (item.queueItemUid != null) {
                    enqueuedTrackIds.add(item.queueItemUid);
                } else if (item.trackId != null) {
                    enqueuedTrackIds.add(item.trackId);
                }
            }
            Log.i(TAG, "playNext: Inserted " + item.trackId + " at master index " + insertMasterIdx + ", exo index " + insertExoIdx);
        });
    }

    public void removeQueueItem(String queueItemUid) {
        if (queueItemUid == null) return;
        mainHandler.post(() -> {
            synchronized (masterPlaylist) {
                for (int i = masterPlaylist.size() - 1; i >= 0; i--) {
                    if (queueItemUid.equals(masterPlaylist.get(i).queueItemUid)) {
                        masterPlaylist.remove(i);
                        break;
                    }
                }
            }
            synchronized (enqueuedTrackIds) {
                enqueuedTrackIds.remove(queueItemUid);
            }
            Player player = getPlayer();
            if (player != null) {
                int currentIdx = player.getCurrentMediaItemIndex();
                for (int i = player.getMediaItemCount() - 1; i > currentIdx; i--) {
                    MediaItem mi = player.getMediaItemAt(i);
                    if (mi.mediaId != null && mi.mediaId.endsWith("::" + queueItemUid)) {
                        player.removeMediaItem(i);
                        break;
                    }
                }
            }
        });
    }

    public void setRepeatMode(int mode) {
        this.masterRepeatMode = mode;
        Player player = getPlayer();
        if (player != null) {
            mainHandler.post(() -> {
                if (mode == REPEAT_MODE_ONE) {
                    player.setRepeatMode(Player.REPEAT_MODE_ONE);
                } else {
                    player.setRepeatMode(Player.REPEAT_MODE_OFF);
                }
            });
        }
        replenishQueueLookahead();
    }

    public int getRepeatMode() {
        return masterRepeatMode;
    }

    public List<QueueItem> getMasterPlaylist() {
        return masterPlaylist;
    }

    public String getCurrentQueueItemUid() {
        return currentQueueItemUid;
    }

    public int getCurrentMasterIndex() {
        synchronized (masterPlaylist) {
            for (int i = 0; i < masterPlaylist.size(); i++) {
                QueueItem item = masterPlaylist.get(i);
                if (currentQueueItemUid != null && currentQueueItemUid.equals(item.queueItemUid)) {
                    return i;
                }
                if (trackId != null && trackId.equals(item.trackId)) {
                    return i;
                }
            }
        }
        return -1;
    }

    public void addQueueItems(java.util.List<QueueItem> items) {
        Player player = getPlayer();
        if (player == null || items == null || items.isEmpty()) {
            return;
        }

        synchronized (masterPlaylist) {
            masterPlaylist.addAll(items);
        }

        try {
            java.util.Set<String> existingIds = new java.util.HashSet<>();
            int count = player.getMediaItemCount();
            for (int i = 0; i < count; i++) {
                MediaItem item = player.getMediaItemAt(i);
                if (item.mediaId != null && !item.mediaId.isEmpty()) {
                    existingIds.add(item.mediaId);
                }
            }
            synchronized (enqueuedTrackIds) {
                existingIds.addAll(enqueuedTrackIds);
            }

            java.util.List<MediaItem> newMediaItems = new java.util.ArrayList<>();
            for (QueueItem qItem : items) {
                if (qItem.source != null && !qItem.source.isEmpty()) {
                    String qKey = (qItem.queueItemUid != null) ? qItem.queueItemUid : qItem.trackId;
                    if (qKey == null || !existingIds.contains(qKey)) {
                        newMediaItems.add(buildMediaItem(qItem));
                        if (qKey != null) {
                            existingIds.add(qKey);
                            synchronized (enqueuedTrackIds) {
                                enqueuedTrackIds.add(qKey);
                            }
                        }
                    }
                }
            }

            if (!newMediaItems.isEmpty()) {
                player.addMediaItems(newMediaItems);
                Log.i(TAG, "addQueueItems: added " + newMediaItems.size() + " items (total=" + player.getMediaItemCount() + ")");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error adding items to ExoPlayer queue", e);
        }
    }

    public void queueNext(String nextSource, AudioMetadata nextMetadata) {
        queueNext(nextSource, nextMetadata, null, null, false);
    }

    public void queueNext(
        String nextSource,
        AudioMetadata nextMetadata,
        String nextTrackId,
        String expectedCurrentTrackId
    ) {
        queueNext(nextSource, nextMetadata, nextTrackId, expectedCurrentTrackId, false);
    }

    public void queueNext(
        String nextSource,
        AudioMetadata nextMetadata,
        String nextTrackId,
        String expectedCurrentTrackId,
        boolean isOffline
    ) {
        Player player = getPlayer();
        if (player == null || nextSource == null || nextSource.isEmpty()) {
            return;
        }

        // Stale Guard: Check if player has moved away from the track this prefetch was generated for
        if (expectedCurrentTrackId != null && !expectedCurrentTrackId.isEmpty()) {
            MediaItem currentItem = player.getCurrentMediaItem();
            if (currentItem != null && currentItem.mediaId != null && !currentItem.mediaId.isEmpty()) {
                String currentTrackId = extractTrackIdFromMediaId(currentItem.mediaId);
                if (!currentItem.mediaId.equals(expectedCurrentTrackId) && !currentTrackId.equals(expectedCurrentTrackId)) {
                    Log.w(
                        TAG,
                        "Ignoring stale queueNext: player current mediaId=" +
                        currentItem.mediaId +
                        " != expected=" +
                        expectedCurrentTrackId
                    );
                    return;
                }
            }
        }

        try {
            int count = player.getMediaItemCount();
            for (int i = 0; i < count; i++) {
                MediaItem item = player.getMediaItemAt(i);
                if (nextTrackId != null && (nextTrackId.equals(item.mediaId) || nextTrackId.equals(extractTrackIdFromMediaId(item.mediaId)))) {
                    Log.i(TAG, "Track already in ExoPlayer queue at index " + i + ": " + nextTrackId);
                    synchronized (enqueuedTrackIds) {
                        enqueuedTrackIds.add(nextTrackId);
                    }
                    return;
                }
            }

            synchronized (enqueuedTrackIds) {
                if (nextTrackId != null && enqueuedTrackIds.contains(nextTrackId)) {
                    Log.i(TAG, "Track already in enqueuedTrackIds: " + nextTrackId);
                    return;
                }
            }

            QueueItem qItem = new QueueItem(
                nextSource,
                nextTrackId,
                nextMetadata != null ? nextMetadata.songTitle : "",
                nextMetadata != null ? nextMetadata.artistName : "",
                nextMetadata != null ? nextMetadata.albumTitle : "",
                nextMetadata != null ? nextMetadata.artworkSource : "",
                null,
                0L,
                isOffline
            );

            player.addMediaItem(buildMediaItem(qItem));
            synchronized (enqueuedTrackIds) {
                if (nextTrackId != null) {
                    enqueuedTrackIds.add(nextTrackId);
                }
            }
            Log.i(
                TAG,
                "Queued next track in ExoPlayer natively: id=" +
                nextTrackId +
                " (itemCount=" +
                player.getMediaItemCount() +
                ")"
            );
        } catch (Exception e) {
            Log.e(TAG, "Error queuing next track in ExoPlayer", e);
        }
    }

    public void updateCurrentMedia(MediaItem currentItem) {
        if (currentItem != null) {
            if (currentItem.mediaId != null && !currentItem.mediaId.isEmpty()) {
                String fullId = currentItem.mediaId;
                int sep = fullId.indexOf("::");
                if (sep != -1) {
                    this.trackId = fullId.substring(0, sep);
                    this.currentQueueItemUid = fullId.substring(sep + 2);
                } else {
                    this.trackId = fullId;
                }
            }
            if (
                currentItem.localConfiguration != null &&
                currentItem.localConfiguration.uri != null
            ) {
                this.source = currentItem.localConfiguration.uri.toString();
            }

            if (currentItem.mediaMetadata != null) {
                if (currentItem.mediaMetadata.title != null) {
                    audioMetadata.songTitle = currentItem.mediaMetadata.title.toString();
                }
                if (currentItem.mediaMetadata.artist != null) {
                    audioMetadata.artistName = currentItem.mediaMetadata.artist.toString();
                }
                if (currentItem.mediaMetadata.albumTitle != null) {
                    audioMetadata.albumTitle = currentItem.mediaMetadata.albumTitle.toString();
                }
            }
        }

        if (useForNotification) {
            audioMetadata.startUpdater();
        }
    }

    public void changeMetadata(AudioMetadata metadata) {
        audioMetadata.update(metadata);
        updateMetadata();
    }

    public float getDuration() {
        long duration = getPlayer().getDuration();

        if (duration == C.TIME_UNSET) {
            return -1;
        }

        return duration / 1000.0f;
    }

    public float getCurrentTime() {
        return getPlayer().getCurrentPosition() / 1000.0f;
    }

    public void play() {
        Player player = getPlayer();

        if (player.getPlaybackState() == Player.STATE_IDLE) {
            player.prepare();
        } else if (player.getPlaybackState() == Player.STATE_ENDED) {
            Log.i(TAG, "Player is in STATE_ENDED, seeking to default position and preparing");
            player.seekToDefaultPosition();
            player.prepare();
        }

        player.play();

        if (useForNotification) {
            audioMetadata.startUpdater();
        }
    }

    public void pause() {
        releaseTransitionWakeLock();
        setIsPaused();
        getPlayer().pause();
        audioMetadata.stopUpdater();
    }

    public void seek(long timeInSeconds) {
        getPlayer().seekTo(timeInSeconds * 1000);
    }

    public void seek(double timeInSeconds) {
        getPlayer().seekTo((long) (timeInSeconds * 1000.0));
    }

    public void stop() {
        releaseTransitionWakeLock();
        setIsStopped();

        Player player = getPlayer();
        player.pause();
        player.seekToDefaultPosition();
        audioMetadata.stopUpdater();
    }

    public void setVolume(float volume) {
        getPlayer().setVolume(volume);
    }

    public void setRate(float rate) {
        getPlayer().setPlaybackSpeed(rate);
    }

    public void setOnReady(String callbackId) {
        onReadyCallbackId = callbackId;
    }

    public void setOnEnd(String callbackId) {
        onEndCallbackId = callbackId;
    }

    public void setOnPlaybackStatusChange(String callbackId) {
        onPlaybackStatusChangeCallbackId = callbackId;
    }

    public boolean isPlaying() {
        if (getPlayer() == null) {
            return false;
        }

        return isPlaying;
    }

    public boolean isPaused() {
        return !isPlaying && !isStopped;
    }

    public boolean isStopped() {
        return isStopped;
    }

    public void setIsPlaying() {
        this.isStopped = false;
        this.isPlaying = true;
        this.consecutiveFailureCount = 0;
        if (this.trackId != null) {
            synchronized (masterPlaylist) {
                for (QueueItem item : masterPlaylist) {
                    if (this.trackId.equals(item.trackId)) {
                        item.retryCount = 0;
                        break;
                    }
                }
            }
        }
    }

    public void setIsPaused() {
        this.isStopped = false;
        this.isPlaying = false;
    }

    public void setIsStopped() {
        this.isStopped = true;
        this.isPlaying = false;
    }

    public Player getPlayer() {
        return player;
    }

    public void setPlayer(Player player) {
        this.player = player;
    }

    public void releasePlayer() {
        if (player != null) {
            player.release();
            player = null;
            playerEventListener = null;
        }
    }

    public void setEventListener(PlayerEventListener listener) {
        playerEventListener = listener;
    }

    public PlayerEventListener getEventListener() {
        return playerEventListener;
    }

    public boolean isInitialized() {
        return getPlayer() != null;
    }

    public MediaItem buildMediaItem() {
        MediaItem.Builder builder = new MediaItem.Builder()
            .setMediaMetadata(getMediaMetadata())
            .setUri(source);
        if (trackId != null && !trackId.isEmpty()) {
            builder.setMediaId(trackId);
        }
        return builder.build();
    }

    public void destroy() {
        releaseTransitionWakeLock();
        audioMetadata.stopUpdater();

        try {
            backgroundQueueExecutor.shutdownNow();
        } catch (Exception ignored) {}

        synchronized (masterPlaylist) {
            masterPlaylist.clear();
        }
        synchronized (enqueuedTrackIds) {
            enqueuedTrackIds.clear();
        }

        if (!useForNotification) {
            releasePlayer();
        }
    }

    private void updateMetadata() {
        var currentMediaItem = getPlayer().getCurrentMediaItem();
        var newMediaItem = currentMediaItem
            .buildUpon()
            .setMediaMetadata(getMediaMetadata())
            .build();

        getPlayer().replaceMediaItem(0, newMediaItem);
    }

    private MediaMetadata getMediaMetadata() {
        MediaMetadata.Builder builder = new MediaMetadata.Builder()
            .setAlbumTitle(audioMetadata.albumTitle == null ? "" : audioMetadata.albumTitle)
            .setArtist(audioMetadata.artistName == null ? "" : audioMetadata.artistName)
            .setTitle(audioMetadata.songTitle == null ? "" : audioMetadata.songTitle);

        if (useForNotification && audioMetadata.artworkSource != null) {
            try {
                if (audioMetadata.artworkSource.startsWith("https:") || audioMetadata.artworkSource.startsWith("http:")) {
                    builder.setArtworkUri(Uri.parse(audioMetadata.artworkSource));
                } else if (!audioMetadata.artworkSource.trim().isEmpty()) {
                    int bufferLength = 4 * 0x400; // 4KB
                    byte[] buffer = new byte[bufferLength];
                    int readLength;
                    ByteArrayOutputStream outputStream = new ByteArrayOutputStream();

                    String assetPath = audioMetadata.artworkSource.startsWith("/")
                        ? "public" + audioMetadata.artworkSource
                        : "public/" + audioMetadata.artworkSource;

                    InputStream inputStream = pluginOwner
                        .getContext()
                        .getAssets()
                        .open(assetPath);

                    while ((readLength = inputStream.read(buffer, 0, bufferLength)) != -1) {
                        outputStream.write(buffer, 0, readLength);
                    }

                    inputStream.close();

                    builder.maybeSetArtworkData(
                        outputStream.toByteArray(),
                        MediaMetadata.PICTURE_TYPE_OTHER
                    );
                }
            } catch (Exception ex) {
                Log.w(TAG, "Could not load the artwork source.", ex);
            }
        }

        return builder.build();
    }

    public void emitNext() {
        acquireTransitionWakeLock();
        if (pluginOwner != null) {
            pluginOwner.emitNextEvent();
        }
    }

    public void emitPrevious() {
        acquireTransitionWakeLock();
        if (pluginOwner != null) {
            pluginOwner.emitPreviousEvent();
        }
    }

    public synchronized void acquireTransitionWakeLock() {
        try {
            if (pluginOwner != null && pluginOwner.getContext() != null) {
                if (transitionWakeLock == null) {
                    PowerManager pm = (PowerManager) pluginOwner
                        .getContext()
                        .getSystemService(Context.POWER_SERVICE);
                    if (pm != null) {
                        transitionWakeLock = pm.newWakeLock(
                            PowerManager.PARTIAL_WAKE_LOCK,
                            "MachiPottuThaaku:TransitionWakeLock"
                        );
                        transitionWakeLock.setReferenceCounted(false);
                    }
                }
                if (transitionWakeLock != null && !transitionWakeLock.isHeld()) {
                    Log.i(TAG, "Acquiring transition WakeLock (max 30s)");
                    transitionWakeLock.acquire(30000);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error acquiring transition WakeLock", e);
        }
    }

    public synchronized void releaseTransitionWakeLock() {
        try {
            if (transitionWakeLock != null && transitionWakeLock.isHeld()) {
                Log.i(TAG, "Releasing transition WakeLock");
                transitionWakeLock.release();
            }
        } catch (Exception e) {
            Log.e(TAG, "Error releasing transition WakeLock", e);
        }
    }

    public synchronized boolean isTransitioning() {
        return transitionWakeLock != null && transitionWakeLock.isHeld();
    }
}
