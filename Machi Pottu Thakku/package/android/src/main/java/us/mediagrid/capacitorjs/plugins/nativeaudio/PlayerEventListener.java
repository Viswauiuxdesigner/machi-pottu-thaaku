package us.mediagrid.capacitorjs.plugins.nativeaudio;

import android.util.Log;
import static androidx.media3.common.Player.*;
import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

public class PlayerEventListener implements Listener {

    private static final String TAG = "PlayerEventListener";

    private AudioPlayerPlugin plugin;
    private AudioSource audioSource;

    public PlayerEventListener(AudioPlayerPlugin plugin, AudioSource audioSource) {
        this.plugin = plugin;
        this.audioSource = audioSource;
        if (this.audioSource != null) {
            this.audioSource.setEventListener(this);
        }
    }

    @Override
    public void onIsPlayingChanged(boolean isPlaying) {
        String status = "stopped";

        if (audioSource != null && audioSource.isInitialized()) {
            if (isPlaying) {
                status = "playing";
                audioSource.setIsPlaying();
                audioSource.releaseTransitionWakeLock();
                if (audioSource.audioMetadata != null) {
                    audioSource.audioMetadata.startUpdater();
                }
            } else if (
                audioSource.getPlayer() != null &&
                audioSource.getPlayer().getPlaybackState() == STATE_READY &&
                !audioSource.getPlayer().getPlayWhenReady() &&
                !audioSource.isStopped()
            ) {
                status = "paused";
                audioSource.setIsPaused();
                if (audioSource.audioMetadata != null) {
                    audioSource.audioMetadata.stopUpdater();
                }
            } else if (audioSource.getPlayer() != null && audioSource.getPlayer().getPlaybackState() == STATE_ENDED) {
                status = "stopped";
                audioSource.setIsStopped();
                if (audioSource.audioMetadata != null) {
                    audioSource.audioMetadata.stopUpdater();
                }
            } else if (
                audioSource.getPlayer() != null &&
                audioSource.getPlayer().getPlaybackState() == STATE_BUFFERING &&
                audioSource.getPlayer().getPlayWhenReady()
            ) {
                status = "buffering";
            }
        }

        Log.d(TAG, "onIsPlayingChanged: isPlaying=" + isPlaying + " -> status=" + status);

        if (audioSource != null) {
            makeCall(
                audioSource.onPlaybackStatusChangeCallbackId,
                new JSObject().put("status", status)
            );
        }
    }

    @Override
    public void onPlaybackStateChanged(@State int playbackState) {
        Log.d(TAG, "onPlaybackStateChanged: state=" + playbackState);

        if (audioSource != null && playbackState == STATE_READY) {
            makeCall(audioSource.onReadyCallbackId);
        }

        if (playbackState == STATE_ENDED) {
            if (audioSource != null) {
                audioSource.acquireTransitionWakeLock();
                audioSource.setIsStopped();
                if (audioSource.audioMetadata != null) {
                    audioSource.audioMetadata.stopUpdater();
                }
                makeCall(audioSource.onEndCallbackId);
            }
            if (plugin != null) {
                plugin.emitAudioEndEvent();
            }
        }
    }

    @Override
    public void onMediaItemTransition(
        @Nullable MediaItem mediaItem,
        @MediaItemTransitionReason int reason
    ) {
        Log.i(TAG, "onMediaItemTransition: reason=" + reason);

        if ((reason == MEDIA_ITEM_TRANSITION_REASON_AUTO || reason == MEDIA_ITEM_TRANSITION_REASON_SEEK) && mediaItem != null) {
            String fromTrackId = audioSource != null ? audioSource.trackId : null;
            String transitionedTrackId = mediaItem.mediaId;
            String transitionedSource = null;
            if (mediaItem.localConfiguration != null && mediaItem.localConfiguration.uri != null) {
                transitionedSource = mediaItem.localConfiguration.uri.toString();
            }

            Log.i(
                TAG,
                "Native track transition occurred: reason=" +
                reason +
                ", from=" +
                fromTrackId +
                ", to=" +
                transitionedTrackId +
                ", uri=" +
                transitionedSource
            );
            if (audioSource != null) {
                audioSource.acquireTransitionWakeLock();
                audioSource.onAutoTransitioned(mediaItem);
            }

            if (plugin != null) {
                JSObject data = new JSObject();
                data.put("reason", reason == MEDIA_ITEM_TRANSITION_REASON_AUTO ? "auto" : "seek");
                data.put("fromTrackId", fromTrackId != null ? fromTrackId : "");
                data.put("trackId", transitionedTrackId != null ? transitionedTrackId : "");
                data.put("source", transitionedSource != null ? transitionedSource : "");
                int currentIdx = (audioSource != null && audioSource.getPlayer() != null) ? audioSource.getPlayer().getCurrentMediaItemIndex() : -1;
                data.put("queueIndex", currentIdx);
                plugin.emitTrackTransitionEvent(data);
            }
        }
    }

    @Override
    public void onPlayerError(androidx.media3.common.PlaybackException error) {
        Log.e(TAG, "onPlayerError: " + (error != null ? error.getMessage() : "null"), error);

        if (audioSource != null) {
            audioSource.handlePlaybackError(error);
            return;
        }

        if (plugin != null) {
            JSObject errObj = new JSObject();
            errObj.put("status", "error");
            errObj.put("errorMessage", error != null ? error.getMessage() : "Playback error");
            plugin.emitPlaybackStatusChangeEvent(errObj);
        }
    }

    private void makeCall(String callbackId) {
        makeCall(callbackId, new JSObject());
    }

    private void makeCall(String callbackId, JSObject data) {
        if (callbackId == null) {
            return;
        }

        PluginCall call = plugin.getBridge().getSavedCall(callbackId);

        if (call == null) {
            return;
        }

        if (data.length() == 0) {
            call.resolve();
        } else {
            call.resolve(data);
        }
    }
}
