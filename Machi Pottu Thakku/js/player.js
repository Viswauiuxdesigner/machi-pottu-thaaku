/**
 * js/player.js
 * Handles audio playback, queue, and UI synchronization using native HTML5 Audio
 */

import { Capacitor } from '@capacitor/core';
import { AudioPlayer as NativeAudio } from '@mediagrid/capacitor-native-audio';

class AudioPlayer {
    constructor() {
        this.currentTrack = null;
        this.queue = [];
        this.queueIndex = -1;
        
        this.audio = document.getElementById('main-audio');
        if (!this.audio) {
            console.error("Audio element not found!");
            return;
        }
        
        // Native Audio State Machine
        this.nativeInitialized = false;
        this.nativeReady = false;
        this.playRequestId = 0;
        this.currentNativeSource = null;
        this.currentNativeTrackId = null;
        this.hasPlaybackError = false;
        this.isDraggingNpProgress = false;
        this.isTransitioning = false;
        this.duration = 0;
        this.playbackGeneration = 0;

        this.setupListeners();
        this.setupAudioEvents();
    }

    getTrackDuration() {
        if (this.duration > 0 && isFinite(this.duration) && !isNaN(this.duration)) {
            return this.duration;
        }
        if (this.currentTrack?.duration && Number(this.currentTrack.duration) > 0) {
            return Number(this.currentTrack.duration);
        }
        if (this.audio && this.audio.duration > 0 && isFinite(this.audio.duration)) {
            return this.audio.duration;
        }
        return 0;
    }

    setupListeners() {
        // UI Controls
        const btnPlay = document.getElementById('btn-play-pause');
        if (btnPlay) btnPlay.addEventListener('click', () => this.togglePlay());
        
        const btnPrev = document.getElementById('btn-prev');
        if (btnPrev) btnPrev.addEventListener('click', () => this.playPrev());
        
        const btnNext = document.getElementById('btn-next');
        if (btnNext) btnNext.addEventListener('click', () => this.playNext());
        
        const btnMute = document.getElementById('btn-mute');
        if (btnMute) btnMute.addEventListener('click', () => this.toggleMute());
        
        // Progress Bar Seeking
        const progressContainer = document.getElementById('progress-container');
        if (progressContainer) {
            progressContainer.addEventListener('click', (e) => {
                this.seekFromClick(e, progressContainer);
            });
        }
        
        // Volume Bar
        const volumeContainer = document.getElementById('volume-container');
        if (volumeContainer) {
            volumeContainer.addEventListener('click', (e) => {
                const rect = volumeContainer.getBoundingClientRect();
                const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                this.setVolume(pos);
            });
        }
        
        // Now Playing Overlay Controls
        const npPlay = document.getElementById('np-play-pause');
        if (npPlay) npPlay.addEventListener('click', () => this.togglePlay());
        
        const npPrev = document.getElementById('np-prev');
        if (npPrev) npPrev.addEventListener('click', () => this.playPrev());
        
        const npNext = document.getElementById('np-next');
        if (npNext) npNext.addEventListener('click', () => this.playNext());
        
        const npProgressContainer = document.getElementById('np-progress-container');
        if (npProgressContainer) {
            let isSeeking = false;
            let seekRatio = 0;
            let dragDuration = 0;

            const updateDragPosition = (clientX) => {
                const rect = npProgressContainer.getBoundingClientRect();
                if (!rect.width) return;
                seekRatio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

                const npPb = document.getElementById('np-progress-bar');
                if (npPb) npPb.style.width = `${seekRatio * 100}%`;

                const duration = dragDuration > 0 ? dragDuration : this.getTrackDuration();
                if (duration > 0) {
                    const npTc = document.getElementById('np-time-current');
                    if (npTc) npTc.textContent = this.formatTime(seekRatio * duration);
                }
            };

            npProgressContainer.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                isSeeking = true;
                this.isDraggingNpProgress = true;
                try {
                    npProgressContainer.setPointerCapture(e.pointerId);
                } catch(err) {}

                dragDuration = this.getTrackDuration();
                updateDragPosition(e.clientX);
            });

            npProgressContainer.addEventListener('pointermove', (e) => {
                if (!isSeeking) return;
                e.preventDefault();
                e.stopPropagation();
                updateDragPosition(e.clientX);
            });

            const finishSeek = async (e) => {
                if (!isSeeking) return;
                isSeeking = false;

                try {
                    if (npProgressContainer.hasPointerCapture(e.pointerId)) {
                        npProgressContainer.releasePointerCapture(e.pointerId);
                    }
                } catch(err) {}

                const duration = dragDuration > 0 ? dragDuration : this.getTrackDuration();
                if (duration > 0) {
                    const clampedRatio = Math.max(0, Math.min(1, seekRatio));
                    const targetTime = Math.round(clampedRatio * duration);
                    if (Capacitor.isNativePlatform() && this.nativeInitialized) {
                        try {
                            await NativeAudio.seek({ audioId: 'main', timeInSeconds: targetTime });
                        } catch(err) {
                            console.error("Native seek error", err);
                        }
                    } else if (this.audio) {
                        this.audio.currentTime = targetTime;
                    }
                }

                setTimeout(() => {
                    this.isDraggingNpProgress = false;
                }, 150);
            };

            npProgressContainer.addEventListener('pointerup', finishSeek);
            npProgressContainer.addEventListener('pointercancel', finishSeek);

            npProgressContainer.addEventListener('click', (e) => {
                if (this.isDraggingNpProgress) return;
                this.seekFromClick(e, npProgressContainer);
            });
        }

        const npFav = document.getElementById('np-fav');
        if (npFav) {
            npFav.addEventListener('click', () => {
                if (!this.currentTrack || !window.storageManager) return;
                const added = window.storageManager.toggleFavorite(this.currentTrack);
                npFav.classList.toggle('active', added);
                const icon = npFav.querySelector('i');
                if (icon) {
                    if (added) icon.setAttribute('fill', 'currentColor');
                    else icon.removeAttribute('fill');
                }
                
                // Keep the favourites page synced if we're on it
                if (document.getElementById('page-favorites')?.classList.contains('active') && window.app && window.app.loadFavorites) {
                    window.app.loadFavorites();
                }
            });
        }
        
        // Set default volume
        this.setVolume(1);
    }

    async seekFromClick(e, container) {
        const duration = this.getTrackDuration();
        if (!duration || isNaN(duration) || duration <= 0) return;
        
        const rect = container.getBoundingClientRect();
        if (!rect.width) return;
        const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const targetTime = Math.round(pos * duration);
        
        if (Capacitor.isNativePlatform() && this.nativeInitialized) {
            try {
                await NativeAudio.seek({ audioId: 'main', timeInSeconds: targetTime });
            } catch(err) {
                console.error("Native seek error", err);
            }
        } else if (this.audio) {
            this.audio.currentTime = targetTime;
        }
    }

    setupAudioEvents() {
        this.audio.addEventListener('play', () => this.syncUIState(true));
        this.audio.addEventListener('pause', () => this.syncUIState(false));
        this.audio.addEventListener('ended', () => this.handleTrackEnded());
        
        this.audio.addEventListener('timeupdate', () => {
            this.updateProgress(this.audio.currentTime, this.audio.duration);
        });
        
        this.audio.addEventListener('loadedmetadata', () => {
            this.updateDuration(this.audio.duration);
        });
        
        this.audio.addEventListener('error', (e) => {
            console.error("Audio error:", e);
            window.uiManager.showNotification("Unable to play this song.", "error");
            this.syncUIState(false);
        });
        
        // Setup NativeAudio Listener if running natively
        if (Capacitor.isNativePlatform()) {
            // Register exactly once before initialize
            NativeAudio.addListener('nativeMediaNext', () => {
                console.log("[NATIVE AUDIO] Lock-screen Next clicked");
                this.playNext();
            });
            NativeAudio.addListener('nativeMediaPrevious', () => {
                console.log("[NATIVE AUDIO] Lock-screen Previous clicked");
                this.playPrev();
            });
            NativeAudio.addListener('nativeAudioEnd', () => {
                console.log("[NATIVE AUDIO] Lock-screen / Native track ended event received");
                this.handleTrackEnded();
            });
            NativeAudio.addListener('nativeTrackTransition', (data) => {
                console.log("[NATIVE AUDIO] Lock-screen / Native track transition received", data);
                this.handleNativeTrackTransition(data);
            });
            
            // Periodically sync progress from native audio
            setInterval(async () => {
                if (this.currentTrack && Capacitor.isNativePlatform() && this.nativeInitialized) {
                    try {
                        const { currentTime } = await NativeAudio.getCurrentTime({ audioId: 'main' });
                        let duration = 0;
                        try {
                            const dur = await NativeAudio.getDuration({ audioId: 'main' });
                            duration = dur.duration;
                        } catch(e) {}

                        this.updateProgress(currentTime, duration);
                    } catch(e) {}
                }
            }, 1000);
        }
    }

    syncUIState(isPlaying) {
        if (!this.currentTrack) return;
        
        const btnIcon = document.getElementById('btn-play-pause');
        if (btnIcon) {
            btnIcon.innerHTML = `<i data-lucide="${isPlaying ? 'pause' : 'play'}" style="width: 24px; height: 24px; margin-left: ${isPlaying ? '0' : '2px'};" fill="currentColor"></i>`;
        }
        
        const npPlay = document.getElementById('np-play-pause');
        if (npPlay) {
            npPlay.innerHTML = `<i data-lucide="${isPlaying ? 'pause' : 'play'}" style="width: 40px; height: 40px; fill: white; margin-left: ${isPlaying ? '0' : '4px'};"></i>`;
        }
        
        // Update row icons based on state
        document.querySelectorAll('.action-play').forEach(btn => {
            const row = btn.closest('.track-row');
            if (row && this.currentTrack && row.dataset.id === this.currentTrack.id) {
                btn.innerHTML = `<i data-lucide="${isPlaying ? 'pause' : 'play'}"></i>`;
                if (isPlaying) btn.classList.add('active');
                else btn.classList.remove('active');
            } else {
                btn.innerHTML = `<i data-lucide="play"></i>`;
                btn.classList.remove('active');
            }
        });
        
        if (window.lucide) lucide.createIcons();
    }

    async playTrack(track, queueList = [], index = 0) {
        if (!track?.s3Key && track?.id) {
            let canonical = null;
            if (window.app?.musicLibrary && window.app.musicLibrary.length > 0) {
                canonical = window.app.musicLibrary.find(t => String(t.id) === String(track.id));
            }
            if (!canonical && window.OfflineManager && typeof window.OfflineManager.getLocalTrack === 'function') {
                canonical = window.OfflineManager.getLocalTrack(track.id);
            }
            if (canonical && canonical.s3Key) {
                track = { ...canonical, ...track, s3Key: canonical.s3Key };
            }
        }

        console.log("[RUNTIME TRACE] playTrack called with track:", track);
        console.log("[FILEBASE PLAYBACK] Track object:", track);
        console.log("[FILEBASE PLAYBACK] s3Key:", track ? track.s3Key : undefined);

        if (!track?.s3Key) {
            console.error("[FILEBASE PLAYBACK] Missing s3Key", track);
            window.uiManager.showNotification("Unable to play this song. File key is missing.", "error");
            this.isTransitioning = false;
            return false;
        }

        this.currentTrack = track;
        this.trackLoadTime = Date.now();
        
        // Anti-race mechanism
        this.playRequestId++;
        this.playbackGeneration++;
        this.hasPlaybackError = false;
        const currentReqId = this.playRequestId;
        
        // Stop current loading/playback if switching
        if (Capacitor.isNativePlatform() && this.nativeInitialized) {
            try { await NativeAudio.pause({ audioId: 'main' }); } catch(e) {}
        } else {
            this.audio.pause();
        }
        
        // Update Queue
        if (queueList && queueList.length > 0) {
            this.queue = queueList;
            this.queueIndex = index;
        } else {
            const existingIdx = this.queue.findIndex(t => t.id === track.id);
            if (existingIdx !== -1) {
                this.queueIndex = existingIdx;
            } else {
                this.queue = [track];
                this.queueIndex = 0;
            }
        }

        this.updateUI();
        
        try {
            // Determine if track is intended for offline local playback
            let isOfflineTrack = false;
            let localUrls = null;

            if (window.OfflineManager) {
                const isVerified = (track.s3Key && await window.OfflineManager.isDownloaded(track.s3Key)) ||
                                   (await window.OfflineManager.isDownloaded(track.id));

                if (isVerified) {
                    isOfflineTrack = true;
                } else if (track._fromDownloads) {
                    // Explicitly selected from Downloads view, but local file is missing/corrupt
                    isOfflineTrack = true;
                }
            }

            let finalUrl = null;

            if (isOfflineTrack) {
                console.log("[PLAYBACK] Resolving local downloaded track:", track.title);
                localUrls = (track.s3Key && await window.OfflineManager.getLocalUrls(track.s3Key)) ||
                            (await window.OfflineManager.getLocalUrls(track.id));

                if (localUrls && (Capacitor.isNativePlatform() ? localUrls.nativeUrl : localUrls.webViewUrl)) {
                    finalUrl = Capacitor.isNativePlatform() ? localUrls.nativeUrl : localUrls.webViewUrl;
                    console.log("[PLAYBACK] Playing local verified audio:", finalUrl);
                } else {
                    // Critical Requirement 2: Do NOT silently fall back to online playback if local file is missing from Downloads
                    console.error("[PLAYBACK] Downloaded audio file is missing or corrupt for track:", track.id);
                    window.uiManager.showNotification("Downloaded audio file is missing or corrupted.", "error");
                    this.syncUIState(false);
                    return false;
                }
            } else {
                // Online streaming path: validate cached signed URL freshness (< 45 minutes)
                const isUrlExpired = track._prefetchedAt && (Date.now() - track._prefetchedAt > 45 * 60 * 1000);
                if (track._prefetchedUrl && !isUrlExpired) {
                    console.log("[MPT_DIAG] Using prefetched signed URL for track ID:", track.id);
                    finalUrl = track._prefetchedUrl;
                    track._prefetchedUrl = null;
                    track._prefetchedAt = null;
                } else {
                    if (isUrlExpired) {
                        console.log("[MPT_DIAG] Prefetched URL expired (>45m), refreshing for track ID:", track.id);
                        track._prefetchedUrl = null;
                        track._prefetchedAt = null;
                    }
                    if (!navigator.onLine) {
                        console.warn("[PLAYBACK] Offline and track is not downloaded");
                        window.uiManager.showNotification("Cannot play this song while offline. Download it first to listen offline.", "warning");
                        this.syncUIState(false);
                        return false;
                    }

                    console.log("[MPT_DIAG] Requesting signed URL for track ID:", track.id);
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 8000);
                    try {
                        const requestUrl = window.getApiUrl(`/.netlify/functions/music-play?key=${encodeURIComponent(track.s3Key)}`);
                        const response = await fetch(requestUrl, { signal: controller.signal });
                        clearTimeout(timeoutId);
                        if (!response.ok) {
                            throw new Error("Failed to generate signed URL (HTTP " + response.status + ")");
                        }
                        const data = await response.json();
                        if (data.error) throw new Error(data.error);
                        if (!data.url) throw new Error("No URL returned from server.");

                        console.log("[MPT_DIAG] Signed URL generated successfully for track ID:", track.id);
                        finalUrl = data.url;
                    } catch (fetchErr) {
                        clearTimeout(timeoutId);
                        throw fetchErr;
                    }
                }
            }
            
            if (currentReqId !== this.playRequestId) return false; // Stale request
            
            if (Capacitor.isNativePlatform()) {
                if (!this.nativeInitialized) {
                    console.log("[NATIVE AUDIO] create player");
                    const res = await NativeAudio.create({
                        audioId: 'main',
                        audioSource: finalUrl,
                        trackId: String(track.id),
                        friendlyTitle: track.title,
                        artistName: track.artist,
                        artworkSource: track.thumbnail || '',
                        useForNotification: true
                    });
                    
                    if (res && res.success === false) throw new Error("Failed to create NativeAudio");
                    this.nativeInitialized = true;
                    this.currentNativeSource = finalUrl;
                    this.currentNativeTrackId = String(track.id);
                    
                    if (!this.nativeCallbacksRegistered) {
                        console.log("[NATIVE AUDIO] Registering lifecycle callbacks for 'main' source");
                        NativeAudio.onPlaybackStatusChange({ audioId: 'main' }, (result) => {
                            if (result.status === 'playing') {
                                this.syncUIState(true);
                            } else if (result.status === 'paused' || result.status === 'stopped' || result.status === 'error') {
                                this.syncUIState(false);
                                if (result.status === 'error') {
                                    this.hasPlaybackError = true;
                                    if (this.currentTrack) {
                                        this.currentTrack._prefetchedUrl = null;
                                        this.currentTrack._prefetchedAt = null;
                                    }
                                    window.uiManager.showNotification("Audio playback error. Tap play to retry.", "error");
                                }
                            }
                        });
                        NativeAudio.onAudioEnd({ audioId: 'main' }, () => {
                            this.handleTrackEnded();
                        });
                        NativeAudio.onAudioReady({ audioId: 'main' }, () => {
                            this.nativeReady = true;
                        });
                        this.nativeCallbacksRegistered = true;
                    }
                    
                    console.log("[NATIVE AUDIO] initialize player");
                    await NativeAudio.initialize({ audioId: 'main' });
                } else {
                    const sourceChanged = this.currentNativeSource !== finalUrl;
                    const trackChanged = this.currentNativeTrackId !== String(track.id);

                    if (sourceChanged || trackChanged) {
                        console.log(`[NATIVE AUDIO] changeAudioSource: sourceChanged=${sourceChanged}, trackChanged=${trackChanged}`);
                        await NativeAudio.changeAudioSource({
                            audioId: 'main',
                            source: finalUrl,
                            trackId: String(track.id)
                        });
                        console.log("[NATIVE AUDIO] changeMetadata");
                        await NativeAudio.changeMetadata({
                            audioId: 'main',
                            friendlyTitle: track.title,
                            artistName: track.artist,
                            artworkSource: track.thumbnail || ''
                        });
                        this.currentNativeSource = finalUrl;
                        this.currentNativeTrackId = String(track.id);
                    } else {
                        // Same track and same URL: avoid rebuilding MediaItem, ensure metadata is current and seek to 0
                        console.log("[NATIVE AUDIO] Same-source replay: updating metadata and seeking to start");
                        await NativeAudio.changeMetadata({
                            audioId: 'main',
                            friendlyTitle: track.title,
                            artistName: track.artist,
                            artworkSource: track.thumbnail || ''
                        });
                        await NativeAudio.seek({ audioId: 'main', timeInSeconds: 0 });
                    }
                }
                
                if (currentReqId !== this.playRequestId) return false; // Stale request

                console.log("[NATIVE AUDIO] play");
                await NativeAudio.play({ audioId: 'main' });
                this.saveLastPlayedTrack(track);
            } else {
                this.audio.src = finalUrl;
                await this.audio.play();
                this.saveLastPlayedTrack(track);
            }
            
            // Prefetch next track to avoid gap
            this.prefetchNextTrack();
            return true;
            
        } catch (error) {
            console.error("[MPT_DIAG] Playback failed for track ID:", track?.id, error?.message || error);
            if (track) {
                track._prefetchedUrl = null;
                track._prefetchedAt = null;
            }
            window.uiManager.showNotification("Playback failed: " + (error?.message || "Unknown error"), "error");
            this.syncUIState(false);
            if (Capacitor.isNativePlatform() && this.nativeInitialized) {
                try {
                    await NativeAudio.stop({ audioId: 'main' });
                } catch(e) {}
            }
            return false;
        } finally {
            this.isTransitioning = false;
        }
    }

    togglePlay() {
        if (!this.currentTrack) return;

        console.log("[MPT_DIAG] togglePlay clicked for track ID:", this.currentTrack.id);
        
        if (Capacitor.isNativePlatform()) {
            if (!this.nativeInitialized || !this.currentNativeSource || this.hasPlaybackError) {
                console.log("[MPT_DIAG] Native player uninitialized, source missing, or recovering from error; re-attempting playTrack");
                this.hasPlaybackError = false;
                this.playTrack(this.currentTrack, this.queue, this.queueIndex);
                return;
            }

            NativeAudio.isPlaying({ audioId: 'main' }).then(({ isPlaying }) => {
                if (isPlaying) {
                    NativeAudio.pause({ audioId: 'main' });
                    this.syncUIState(false);
                } else {
                    NativeAudio.play({ audioId: 'main' });
                    this.syncUIState(true);
                }
            }).catch(e => {
                console.error("[MPT_DIAG] togglePlay isPlaying check error:", e);
                this.playTrack(this.currentTrack, this.queue, this.queueIndex);
            });
        } else {
            if (!this.audio.src) {
                this.playTrack(this.currentTrack, this.queue, this.queueIndex);
                return;
            }
            if (this.audio.paused) {
                this.audio.play();
            } else {
                this.audio.pause();
            }
        }
    }

    handleTrackEnded() {
        const now = Date.now();
        
        // Prevent duplicate events within 1 second of each other
        if (this.lastEndEventTime && now - this.lastEndEventTime < 1000) {
            console.log("[MPT_DIAG] Debouncing duplicate ended event");
            return;
        }
        this.lastEndEventTime = now;

        // Prevent stale events from previous track or broken tracks that end immediately
        if (this.trackLoadTime && now - this.trackLoadTime < 1000) {
            console.log("[MPT_DIAG] Ignoring stale/immediate end event");
            return;
        }

        if (this.isTransitioning) {
            console.log("[MPT_DIAG] Transition already in progress, ignoring duplicate end event");
            return;
        }

        console.log("[MPT_DIAG] Track genuinely ended, auto-skipping to next. Queue index:", this.queueIndex, "Queue length:", this.queue.length);
        
        if (this.queueIndex >= 0 && this.queueIndex < this.queue.length - 1) {
            const nextIdx = this.queueIndex + 1;
            this.isTransitioning = true;
            this.playTrack(this.queue[nextIdx], this.queue, nextIdx)
                .finally(() => {
                    this.isTransitioning = false;
                });
        } else {
            // End of queue
            if (!Capacitor.isNativePlatform() && this.audio) {
                this.audio.pause();
                this.audio.currentTime = 0;
            }
            this.syncUIState(false);
        }
    }

    handleNativeTrackTransition(data) {
        console.log("[MPT_DIAG] Native track transition detected:", data);
        if (!data || !this.queue || this.queue.length === 0) return;

        const fromTrackId = data.fromTrackId ? String(data.fromTrackId) : null;
        const transitionedId = data.trackId ? String(data.trackId) : null;
        const transitionedSource = data.source || null;

        // Stale Guard 1: Verify transition originated from the current playing track
        if (fromTrackId && this.currentTrack && String(this.currentTrack.id) !== fromTrackId) {
            console.warn(`[MPT_DIAG] Ignoring stale transition: fromTrackId (${fromTrackId}) does not match currentTrack (${this.currentTrack?.id})`);
            return;
        }

        // Reconcile identity against current queue
        let matchIndex = -1;
        if (transitionedId) {
            matchIndex = this.queue.findIndex(t => String(t.id) === transitionedId || t.s3Key === transitionedId);
        }
        if (matchIndex === -1 && transitionedSource) {
            matchIndex = this.queue.findIndex(t => t._prefetchedUrl && t._prefetchedUrl === transitionedSource);
        }

        // Strict identity validation: Reject unexpected transitions without matching track identity
        if (matchIndex === -1) {
            console.warn("[MPT_DIAG] Ignoring unexpected transition event: neither trackId ('" + transitionedId + "') nor source matched current queue.");
            return;
        }

        // Stale Guard 2: In a 1-track lookahead queue, transition must strictly advance to queueIndex + 1
        if (matchIndex !== this.queueIndex + 1) {
            console.warn(`[MPT_DIAG] Ignoring out-of-order transition: matchIndex (${matchIndex}) !== expected next (${this.queueIndex + 1})`);
            return;
        }

        console.log("[MPT_DIAG] Reconciled native transition from", this.queueIndex, "to", matchIndex, "track ID:", this.queue[matchIndex].id);
        this.queueIndex = matchIndex;
        this.currentTrack = this.queue[this.queueIndex];
        this.currentNativeTrackId = String(this.currentTrack.id);
        this.currentNativeSource = this.currentTrack._prefetchedUrl || data.source || null;
        this.trackLoadTime = Date.now();
        this.playbackGeneration++;
        this.updateUI();
        this.saveLastPlayedTrack(this.currentTrack);

        // Now prefetch and queue next subsequent track ahead into ExoPlayer
        this.prefetchNextTrack();
    }

    playNext() {
        if (this.isTransitioning) {
            console.log("[MPT_DIAG] playNext ignored: transition already in progress");
            return;
        }
        if (this.queueIndex >= 0 && this.queueIndex < this.queue.length - 1) {
            const nextIdx = this.queueIndex + 1;
            console.log("[MPT_DIAG] playNext advancing from", this.queueIndex, "to", nextIdx);
            this.isTransitioning = true;
            this.playTrack(this.queue[nextIdx], this.queue, nextIdx)
                .finally(() => {
                    this.isTransitioning = false;
                });
        } else {
            console.log("[MPT_DIAG] End of queue reached, safely doing nothing");
        }
    }

    async prefetchSingleTrack(track) {
        if (!track || !track.s3Key) return;

        let isOfflineTrack = false;
        if (window.OfflineManager) {
            isOfflineTrack = (await window.OfflineManager.isDownloaded(track.s3Key)) ||
                             (await window.OfflineManager.isDownloaded(track.id));
            if (!isOfflineTrack && track._fromDownloads) {
                isOfflineTrack = true;
            }
        }

        if (isOfflineTrack) {
            // Never reuse an existing signed HTTP(S) URL for a downloaded/Downloads-tab track
            if (typeof track._prefetchedUrl === 'string' && (track._prefetchedUrl.startsWith('http://') || track._prefetchedUrl.startsWith('https://'))) {
                track._prefetchedUrl = null;
                track._prefetchedAt = null;
            }

            try {
                const localUrls = (await window.OfflineManager.getLocalUrls(track.s3Key)) ||
                                  (await window.OfflineManager.getLocalUrls(track.id));
                if (localUrls && (Capacitor.isNativePlatform() ? localUrls.nativeUrl : localUrls.webViewUrl)) {
                    track._prefetchedUrl = Capacitor.isNativePlatform() ? localUrls.nativeUrl : localUrls.webViewUrl;
                    track._prefetchedAt = null;
                    console.log(`[MPT_DIAG] Prepared verified local file URL for track: ${track.id}`);
                } else {
                    // Local file is missing or corrupt - clear stale URL so it is NEVER queued
                    console.warn(`[MPT_DIAG] Downloaded file missing or corrupt for track: ${track.id}`);
                    track._prefetchedUrl = null;
                    track._prefetchedAt = null;
                }
            } catch (e) {
                console.warn("[MPT_DIAG] Failed to prepare local URL for track:", track.id, e?.message);
                track._prefetchedUrl = null;
                track._prefetchedAt = null;
            }
            return; // ALWAYS exit here so an offline track never falls into the online streaming block
        } else if (navigator.onLine) {
            // Check if existing prefetched signed URL is still valid (< 45 minutes of 60m backend expiry)
            if (track._prefetchedUrl && track._prefetchedAt && (Date.now() - track._prefetchedAt < 45 * 60 * 1000)) {
                return;
            }
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            try {
                const requestUrl = window.getApiUrl(`/.netlify/functions/music-play?key=${encodeURIComponent(track.s3Key)}`);
                const response = await fetch(requestUrl, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.url) {
                        track._prefetchedUrl = data.url;
                        track._prefetchedAt = Date.now();
                        console.log(`[MPT_DIAG] Prefetched signed URL for track ID: ${track.id}`);
                    }
                }
            } catch (e) {
                clearTimeout(timeoutId);
                console.warn("[MPT_DIAG] Failed to prefetch track ID:", track.id, e?.message);
            }
        }
    }

    async prefetchNextTrack() {
        if (this.queueIndex >= 0 && this.queueIndex < this.queue.length - 1) {
            const nextTrack = this.queue[this.queueIndex + 1];
            const genAtStart = this.playbackGeneration;
            const expectedCurrentId = this.currentTrack?.id ? String(this.currentTrack.id) : null;

            await this.prefetchSingleTrack(nextTrack);

            // Stale Guard: Ensure track or playback generation did not switch during prefetch
            if (this.playbackGeneration !== genAtStart || !this.currentTrack || String(this.currentTrack.id) !== expectedCurrentId) {
                console.log("[MPT_DIAG] Aborting queueNext: playback generation changed during prefetch");
                return;
            }

            // Queue prefetched track natively into ExoPlayer playlist for seamless screen-off playback
            const candidateUrl = nextTrack?._prefetchedUrl;
            if (
                Capacitor.isNativePlatform() &&
                this.nativeInitialized &&
                nextTrack &&
                typeof candidateUrl === 'string' &&
                candidateUrl.trim().length > 0
            ) {
                const trimmedUrl = candidateUrl.trim();
                // Critical Offline Guard: Never queue HTTP(S) streaming URL for an offline/Downloads track
                let isNextOffline = false;
                if (window.OfflineManager) {
                    isNextOffline = (await window.OfflineManager.isDownloaded(nextTrack.s3Key)) ||
                                    (await window.OfflineManager.isDownloaded(nextTrack.id)) ||
                                    Boolean(nextTrack._fromDownloads);
                }
                if (isNextOffline && (trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://'))) {
                    console.warn(`[MPT_DIAG] Refusing to natively queue HTTP URL for offline track: ${nextTrack.id}`);
                    nextTrack._prefetchedUrl = null;
                    return;
                }

                try {
                    await NativeAudio.queueNext({
                        audioId: 'main',
                        source: trimmedUrl,
                        trackId: String(nextTrack.id),
                        expectedCurrentTrackId: expectedCurrentId,
                        friendlyTitle: nextTrack.title || '',
                        artistName: nextTrack.artist || '',
                        albumTitle: nextTrack.album || '',
                        artworkSource: nextTrack.thumbnail || ''
                    });
                    console.log("[MPT_DIAG] Queued next track natively in ExoPlayer for track ID:", nextTrack.id);
                } catch (qErr) {
                    console.warn("[MPT_DIAG] Native queueNext failed for track ID:", nextTrack.id, qErr?.message || qErr);
                }
            }

            // Also prefetch subsequent track ahead if queue allows
            if (this.queueIndex + 2 < this.queue.length) {
                const subsequentTrack = this.queue[this.queueIndex + 2];
                this.prefetchSingleTrack(subsequentTrack).catch(() => {});
            }
        }
    }

    async playPrev() {
        if (this.isTransitioning) {
            console.log("[MPT_DIAG] playPrev ignored: transition already in progress");
            return;
        }
        if (Capacitor.isNativePlatform()) {
            let currentSec = 0;
            try {
                if (this.nativeInitialized) {
                    const { currentTime } = await NativeAudio.getCurrentTime({ audioId: 'main' });
                    currentSec = currentTime;
                }
            } catch(e) {}
            
            if (currentSec > 5) {
                await NativeAudio.seek({ audioId: 'main', timeInSeconds: 0 });
            } else if (this.queueIndex > 0) {
                const prevIdx = this.queueIndex - 1;
                console.log("[MPT_DIAG] playPrev navigating from", this.queueIndex, "to", prevIdx);
                this.isTransitioning = true;
                this.playTrack(this.queue[prevIdx], this.queue, prevIdx)
                    .finally(() => {
                        this.isTransitioning = false;
                    });
            }
        } else {
            if (!this.audio) return;
            
            if (this.audio.currentTime > 5) {
                this.audio.currentTime = 0;
                this.audio.play();
            } else if (this.queueIndex > 0) {
                const prevIdx = this.queueIndex - 1;
                console.log("[MPT_DIAG] Web playPrev navigating from", this.queueIndex, "to", prevIdx);
                this.isTransitioning = true;
                this.playTrack(this.queue[prevIdx], this.queue, prevIdx)
                    .finally(() => {
                        this.isTransitioning = false;
                    });
            }
        }
    }

    playPrevious() {
        return this.playPrev();
    }

    setVolume(level) {
        if (this.audio) {
            this.audio.volume = level;
        }

        const volumeBar = document.getElementById('volume-bar');
        if (volumeBar) volumeBar.style.width = `${level * 100}%`;
        
        const btnMute = document.getElementById('btn-mute');
        if (btnMute) {
            let iconStr = 'volume-2';
            if (level === 0) iconStr = 'volume-x';
            else if (level < 0.5) iconStr = 'volume-1';
            
            btnMute.innerHTML = `<i data-lucide="${iconStr}"></i>`;
            if (window.lucide) lucide.createIcons();
        }
    }

    toggleMute() {
        if (!this.audio) return;
        
        if (this.audio.volume > 0) {
            this.lastVolume = this.audio.volume;
            this.setVolume(0);
        } else {
            this.setVolume(this.lastVolume || 1);
        }
    }

    updateProgress(current, total) {
        if (total > 0 && isFinite(total) && !isNaN(total)) {
            this.duration = total;
        }
        if (this.isDraggingNpProgress) return;
        if (total > 0 && isFinite(total) && !isNaN(total)) {
            const percent = (current / total) * 100;
            const pb = document.getElementById('progress-bar');
            if (pb) pb.style.width = `${percent}%`;
            const tc = document.getElementById('time-current');
            if (tc) tc.textContent = this.formatTime(current);
            const tt = document.getElementById('time-total');
            if (tt) tt.textContent = this.formatTime(total);
            
            const npPb = document.getElementById('np-progress-bar');
            if (npPb) npPb.style.width = `${percent}%`;
            const npTc = document.getElementById('np-time-current');
            if (npTc) npTc.textContent = this.formatTime(current);
            const npTt = document.getElementById('np-time-total');
            if (npTt) npTt.textContent = this.formatTime(total);
        }
    }

    saveLastPlayedTrack(track) {
        if (!track || !track.id) return;
        try {
            localStorage.setItem('mpt_last_played_track', track.id);
            this.updateLastPlayedHighlight(track.id);
            if (window.app && typeof window.app.renderLastPlayedCard === 'function') {
                window.app.renderLastPlayedCard();
            }
        } catch(e) {
            console.error("[PLAYER] Error saving last played track ID:", e);
        }
    }

    getLastPlayedTrackId() {
        if (this.currentTrack && this.currentTrack.id) {
            return this.currentTrack.id;
        }
        try {
            return localStorage.getItem('mpt_last_played_track');
        } catch(e) {
            return null;
        }
    }

    updateLastPlayedHighlight(activeTrackId) {
        const idToHighlight = activeTrackId || this.getLastPlayedTrackId();
        document.querySelectorAll('.last-played-highlight').forEach(el => {
            el.classList.remove('last-played-highlight');
        });
        if (idToHighlight) {
            const escapedId = String(idToHighlight).replace(/"/g, '\\"');
            document.querySelectorAll(`[data-id="${escapedId}"]`).forEach(el => {
                el.classList.add('last-played-highlight');
            });
        }
    }
    
    updateDuration(total) {
        if (total > 0 && isFinite(total) && !isNaN(total)) {
            this.duration = total;
            const tt = document.getElementById('time-total');
            if (tt) tt.textContent = this.formatTime(total);
            const npTt = document.getElementById('np-time-total');
            if (npTt) npTt.textContent = this.formatTime(total);
        }
    }

    formatTime(seconds) {
        const num = Number(seconds);
        if (!isFinite(num) || isNaN(num)) return "0:00";
        const m = Math.floor(num / 60);
        const s = Math.floor(num % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    updateUI() {
        if (!this.currentTrack) return;
        
        const track = this.currentTrack;
        const pt = document.getElementById('player-title');
        if (pt) pt.textContent = track.title;
        const pa = document.getElementById('player-artist');
        if (pa) pa.textContent = track.artist;
        
        const npPt = document.getElementById('np-title');
        if (npPt) npPt.textContent = track.title;
        const npPa = document.getElementById('np-artist');
        if (npPa) npPa.textContent = track.artist;
        
        const npFav = document.getElementById('np-fav');
        if (npFav && window.storageManager) {
            const isFav = window.storageManager.isFavorite(track.id);
            npFav.classList.toggle('active', isFav);
            const icon = npFav.querySelector('i');
            if (icon) {
                if (isFav) icon.setAttribute('fill', 'currentColor');
                else icon.removeAttribute('fill');
            }
        }
        
        const artworkContainer = document.getElementById('player-artwork');
        if (artworkContainer) {
            if (track.thumbnail) {
                artworkContainer.innerHTML = `<img src="${track.thumbnail}" alt="Artwork">`;
            } else {
                artworkContainer.innerHTML = `<i data-lucide="music"></i>`;
                if (window.lucide) lucide.createIcons();
            }
        }
        
        const npArtworkContainer = document.getElementById('np-artwork');
        if (npArtworkContainer) {
            if (track.thumbnail) {
                npArtworkContainer.innerHTML = `<img src="${track.thumbnail}" alt="Artwork">`;
            } else {
                npArtworkContainer.innerHTML = `<i data-lucide="music" style="width: 64px; height: 64px;"></i>`;
                if (window.lucide) lucide.createIcons();
            }
        }
        
        // Set Media Session API for Web/PWA browsers (Native Android MediaSession is managed by Media3 AudioPlayerService)
        if (!Capacitor.isNativePlatform() && 'mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: track.title,
                artist: track.artist,
                artwork: track.thumbnail ? [{ src: track.thumbnail, sizes: '500x500', type: 'image/jpeg' }] : []
            });
            
            navigator.mediaSession.setActionHandler('play', () => this.togglePlay());
            navigator.mediaSession.setActionHandler('pause', () => this.togglePlay());
            navigator.mediaSession.setActionHandler('previoustrack', () => this.playPrev());
            navigator.mediaSession.setActionHandler('nexttrack', () => this.playNext());
        }
        
        // NativeAudio handles foreground notification automatically via playUrl on Android
        
        // NativeAudio handles foreground notification automatically via playUrl on Android
        
        // Reset progress visually
        const pb = document.getElementById('progress-bar');
        if (pb) pb.style.width = `0%`;
        const tc = document.getElementById('time-current');
        if (tc) tc.textContent = "0:00";
        
        const npPb = document.getElementById('np-progress-bar');
        if (npPb) npPb.style.width = `0%`;
        const npTc = document.getElementById('np-time-current');
        if (npTc) npTc.textContent = "0:00";
    }
}

window.player = new AudioPlayer();
