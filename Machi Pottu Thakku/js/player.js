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

        this.setupListeners();
        this.setupAudioEvents();
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
            npProgressContainer.addEventListener('click', (e) => {
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
        let duration = 0;
        if (Capacitor.isNativePlatform() && this.nativeInitialized) {
            try {
                const dur = await NativeAudio.getDuration({ audioId: 'main' });
                duration = dur.duration;
            } catch(e) {}
        } else if (this.audio) {
            duration = this.audio.duration;
        }
        
        if (!duration || isNaN(duration) || duration <= 0) return;
        
        const rect = container.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        const targetTime = pos * duration;
        
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
        console.log("[RUNTIME TRACE] playTrack called with track:", track);
        console.log("[FILEBASE PLAYBACK] Track object:", track);
        console.log("[FILEBASE PLAYBACK] s3Key:", track ? track.s3Key : undefined);

        if (!track?.s3Key) {
            console.error("[FILEBASE PLAYBACK] Missing s3Key", track);
            window.uiManager.showNotification("Unable to play this song. File key is missing.", "error");
            return;
        }

        this.currentTrack = track;
        this.trackLoadTime = Date.now();
        
        // Anti-race mechanism
        this.playRequestId++;
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
            // Check Offline First
            let isOfflineTrack = false;
            let localUrls = null;
            if (window.OfflineManager) {
                isOfflineTrack = await window.OfflineManager.isDownloaded(track.id);
            }
            
            let finalUrl = null;
            let isNativeUri = false;
            
            if (isOfflineTrack) {
                console.log("[PLAYBACK] Playing local downloaded track");
                localUrls = await window.OfflineManager.getLocalUrls(track.id);
                if (localUrls) {
                    if (Capacitor.isNativePlatform()) {
                        finalUrl = localUrls.nativeUrl;
                        isNativeUri = true;
                    } else {
                        finalUrl = localUrls.webViewUrl;
                    }
                }
            } else if (track._prefetchedUrl) {
                console.log("[FILEBASE PLAYBACK] Using prefetched signed URL");
                finalUrl = track._prefetchedUrl;
                track._prefetchedUrl = null; // Clear it so it doesn't get stale if played again later
            }
            
            if (!finalUrl) {
                // Check if user is completely offline and track is not downloaded
                if (!navigator.onLine) {
                    console.warn("[PLAYBACK] Offline and track not downloaded");
                    window.uiManager.showNotification("Cannot play this song while offline", "error");
                    this.syncUIState(false);
                    return;
                }

                console.log("[FILEBASE PLAYBACK] Requesting signed URL");
                const requestUrl = window.getApiUrl(`/.netlify/functions/music-play?key=${encodeURIComponent(track.s3Key)}`);
                console.log(`[FILEBASE PLAYBACK] Request URL: ${requestUrl}`);
                
                const response = await fetch(requestUrl);
                if (!response.ok) {
                    throw new Error("Failed to generate signed URL.");
                }
                const data = await response.json();
                
                if (data.error) throw new Error(data.error);
                if (!data.url) throw new Error("No URL returned from server.");
                
                console.log("[FILEBASE PLAYBACK] Signed URL generated");
                finalUrl = data.url;
            }
            
            if (currentReqId !== this.playRequestId) return; // Stale request
            
            if (Capacitor.isNativePlatform()) {
                if (!this.nativeInitialized) {
                    console.log("[NATIVE AUDIO] create player");
                    const res = await NativeAudio.create({
                        audioId: 'main',
                        audioSource: finalUrl,
                        friendlyTitle: track.title,
                        artistName: track.artist,
                        artworkSource: track.thumbnail || '',
                        useForNotification: true
                    });
                    
                    if (res && res.success === false) throw new Error("Failed to create NativeAudio");
                    this.nativeInitialized = true;
                    this.currentNativeSource = finalUrl;
                    
                    if (!this.nativeCallbacksRegistered) {
                        console.log("[NATIVE AUDIO] Registering lifecycle callbacks for 'main' source");
                        NativeAudio.onPlaybackStatusChange({ audioId: 'main' }, (result) => {
                            if (result.status === 'playing') this.syncUIState(true);
                            else this.syncUIState(false);
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
                } else if (this.currentNativeSource !== finalUrl) {
                    console.log("[NATIVE AUDIO] changeAudioSource");
                    await NativeAudio.changeAudioSource({
                        audioId: 'main',
                        source: finalUrl
                    });
                    console.log("[NATIVE AUDIO] changeMetadata");
                    await NativeAudio.changeMetadata({
                        audioId: 'main',
                        friendlyTitle: track.title,
                        artistName: track.artist,
                        artworkSource: track.thumbnail || ''
                    });
                    this.currentNativeSource = finalUrl;
                }
                
                if (currentReqId !== this.playRequestId) return; // Stale request

                console.log("[NATIVE AUDIO] play");
                await NativeAudio.play({ audioId: 'main' });
                this.syncUIState(true);
            } else {
                this.audio.src = finalUrl;
                this.audio.play().catch(err => {
                    console.error("Autoplay prevented:", err);
                });
            }
            
            // Prefetch next track to avoid gap
            this.prefetchNextTrack();
            
        } catch (error) {
            console.error("[FILEBASE PLAYBACK] Error fetching presigned URL or creating player:", error);
            window.uiManager.showNotification("Playback failed: " + error.message, "error");
            this.syncUIState(false);
            // DO NOT auto-skip to the next track here
        }
    }

    togglePlay() {
        if (!this.currentTrack) return;
        
        if (Capacitor.isNativePlatform()) {
            NativeAudio.isPlaying({ audioId: 'main' }).then(({ isPlaying }) => {
                if (isPlaying) {
                    NativeAudio.pause({ audioId: 'main' });
                    this.syncUIState(false);
                } else {
                    NativeAudio.play({ audioId: 'main' });
                    this.syncUIState(true);
                }
            }).catch(e => console.error(e));
        } else {
            if (!this.audio.src) return;
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
            console.log("[PLAYER] Debouncing duplicate ended event");
            return;
        }
        this.lastEndEventTime = now;

        // Prevent stale events from previous track or broken tracks that end immediately
        if (this.trackLoadTime && now - this.trackLoadTime < 1000) {
            console.log("[PLAYER] Ignoring stale/immediate end event");
            return;
        }

        console.log("[PLAYER] Track genuinely ended, auto-skipping to next");
        
        if (this.queueIndex >= 0 && this.queueIndex < this.queue.length - 1) {
            this.queueIndex++;
            this.playTrack(this.queue[this.queueIndex], this.queue, this.queueIndex);
        } else {
            // End of queue
            if (!Capacitor.isNativePlatform() && this.audio) {
                this.audio.pause();
                this.audio.currentTime = 0;
            }
            this.syncUIState(false);
        }
    }

    playNext() {
        if (this.queueIndex >= 0 && this.queueIndex < this.queue.length - 1) {
            this.queueIndex++;
            this.playTrack(this.queue[this.queueIndex], this.queue, this.queueIndex);
        } else {
            console.log("[PLAYER] End of queue reached, safely doing nothing");
        }
    }

    async prefetchNextTrack() {
        if (this.queueIndex >= 0 && this.queueIndex < this.queue.length - 1) {
            const nextTrack = this.queue[this.queueIndex + 1];
            if (!nextTrack) return;
            
            let isOfflineTrack = false;
            if (window.OfflineManager) {
                isOfflineTrack = await window.OfflineManager.isDownloaded(nextTrack.id);
            }
            
            if (!isOfflineTrack && navigator.onLine && !nextTrack._prefetchedUrl) {
                try {
                    const requestUrl = window.getApiUrl(`/.netlify/functions/music-play?key=${encodeURIComponent(nextTrack.s3Key)}`);
                    const response = await fetch(requestUrl);
                    if (response.ok) {
                        const data = await response.json();
                        if (data.url) {
                            nextTrack._prefetchedUrl = data.url;
                            console.log(`[PREFETCH] Prefetched URL for next track: ${nextTrack.title}`);
                        }
                    }
                } catch (e) {
                    console.error("[PREFETCH] Failed to prefetch next track", e);
                }
            }
        }
    }

    async playPrev() {
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
                this.queueIndex--;
                this.playTrack(this.queue[this.queueIndex], this.queue, this.queueIndex);
            }
        } else {
            if (!this.audio) return;
            
            if (this.audio.currentTime > 5) {
                this.audio.currentTime = 0;
                this.audio.play();
            } else if (this.queueIndex > 0) {
                this.queueIndex--;
                this.playTrack(this.queue[this.queueIndex], this.queue, this.queueIndex);
            }
        }
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
    
    updateDuration(total) {
        if (total > 0 && isFinite(total) && !isNaN(total)) {
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
        
        // Set Media Session API for OS integration
        if ('mediaSession' in navigator) {
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
