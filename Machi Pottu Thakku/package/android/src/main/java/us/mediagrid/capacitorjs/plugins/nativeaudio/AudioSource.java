package us.mediagrid.capacitorjs.plugins.nativeaudio;

import android.content.Context;
import android.net.Uri;
import android.os.Binder;
import android.util.Log;
import android.os.PowerManager;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

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
                .setContentType(
                    useForNotification ? C.AUDIO_CONTENT_TYPE_SPEECH : C.AUDIO_CONTENT_TYPE_MUSIC
                )
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

        Player player = getPlayer();

        player.setMediaItem(buildMediaItem(), true);
        player.setPlayWhenReady(false);
        player.prepare();
    }

    public void queueNext(String nextSource, AudioMetadata nextMetadata) {
        queueNext(nextSource, nextMetadata, null, null);
    }

    public void queueNext(
        String nextSource,
        AudioMetadata nextMetadata,
        String nextTrackId,
        String expectedCurrentTrackId
    ) {
        Player player = getPlayer();
        if (player == null || nextSource == null || nextSource.isEmpty()) {
            return;
        }

        // Stale Guard: Check if player has moved away from the track this prefetch was generated for
        if (expectedCurrentTrackId != null && !expectedCurrentTrackId.isEmpty()) {
            MediaItem currentItem = player.getCurrentMediaItem();
            if (currentItem != null && currentItem.mediaId != null && !currentItem.mediaId.isEmpty()) {
                if (!currentItem.mediaId.equals(expectedCurrentTrackId)) {
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
            int currentIndex = player.getCurrentMediaItemIndex();
            // Prune completed items before current index outside of listener callback
            if (currentIndex > 0) {
                player.removeMediaItems(0, currentIndex);
            }

            // Remove any previously queued item at index 1+
            while (player.getMediaItemCount() > 1) {
                player.removeMediaItem(1);
            }

            MediaMetadata.Builder metaBuilder = new MediaMetadata.Builder();
            if (nextMetadata != null) {
                metaBuilder
                    .setTitle(nextMetadata.songTitle == null ? "" : nextMetadata.songTitle)
                    .setArtist(nextMetadata.artistName == null ? "" : nextMetadata.artistName)
                    .setAlbumTitle(nextMetadata.albumTitle == null ? "" : nextMetadata.albumTitle);

                if (useForNotification && nextMetadata.artworkSource != null) {
                    try {
                        if (
                            nextMetadata.artworkSource.startsWith("https:") ||
                            nextMetadata.artworkSource.startsWith("http:")
                        ) {
                            metaBuilder.setArtworkUri(Uri.parse(nextMetadata.artworkSource));
                        }
                    } catch (Exception ex) {
                        Log.w(TAG, "Could not parse artwork for queued track", ex);
                    }
                }
            }

            MediaItem.Builder nextBuilder = new MediaItem.Builder()
                .setUri(nextSource)
                .setMediaMetadata(metaBuilder.build());

            if (nextTrackId != null && !nextTrackId.isEmpty()) {
                nextBuilder.setMediaId(nextTrackId);
            }

            player.addMediaItem(nextBuilder.build());
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
                this.trackId = currentItem.mediaId;
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
                if (audioMetadata.artworkSource.startsWith("https:")) {
                    builder.setArtworkUri(Uri.parse(audioMetadata.artworkSource));
                } else {
                    int bufferLength = 4 * 0x400; // 4KB
                    byte[] buffer = new byte[bufferLength];
                    int readLength;
                    ByteArrayOutputStream outputStream = new ByteArrayOutputStream();

                    InputStream inputStream = pluginOwner
                        .getContext()
                        .getAssets()
                        .open("public/" + audioMetadata.artworkSource);

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
