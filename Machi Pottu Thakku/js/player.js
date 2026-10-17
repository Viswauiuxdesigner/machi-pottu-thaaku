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
        this.queuedTrackIds = new Set();

        // Repeat mode state ('off' | 'all' | 'one')
        this.repeatMode = localStorage.getItem('mpt_repeat_mode') || 'off';

        // Equalizer state (Bass, Mid, Treble 0..100) & Enabled flag
        this.eqSettings = { bass: 50, mid: 50, treble: 50 };
        this.eqEnabled = true;
        try {
            const savedEq = localStorage.getItem('mpt_eq_settings');
            if (savedEq) {
                const parsed = JSON.parse(savedEq);
                if (parsed && typeof parsed.bass === 'number') {
                    this.eqSettings = parsed;
                }
            }
            const savedEnabled = localStorage.getItem('mpt_eq_enabled');
            if (savedEnabled !== null) {
                this.eqEnabled = (savedEnabled === 'true');
            }
        } catch (e) {}

        // 360 Spatial Audio state
        this.spatialSettings = {
            enabled: false,
            intensity: 75,
            width: 80,
            distance: 40,
            azimuth: 0,
            autoOrbit: false
        };
        try {
            const savedSpatial = localStorage.getItem('mpt_spatial_settings');
            if (savedSpatial) {
                const parsed = JSON.parse(savedSpatial);
                if (parsed && typeof parsed.intensity === 'number') {
                    this.spatialSettings = { ...this.spatialSettings, ...parsed };
                }
            }
        } catch (e) {}

        this.initWebAudioEq();
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

        // Repeat mode toggle button
        const npRepeatBtn = document.getElementById('np-repeat-btn');
        if (npRepeatBtn) {
            npRepeatBtn.addEventListener('click', () => this.toggleRepeatMode());
        }

        // Up Next Drawer Buttons
        const npQueueBtn = document.getElementById('np-btn-queue');
        if (npQueueBtn) {
            npQueueBtn.addEventListener('click', () => this.openUpNextDrawer());
        }
        const npUpNextBtn = document.getElementById('np-up-next-btn');
        if (npUpNextBtn) {
            npUpNextBtn.addEventListener('click', () => this.openUpNextDrawer());
        }

        // Equalizer Drawer Button
        const npEqBtn = document.getElementById('np-btn-eq');
        if (npEqBtn) {
            npEqBtn.addEventListener('click', () => this.openEqDrawer());
        }

        // Equalizer Sliders
        const sliderBass = document.getElementById('eq-slider-bass');
        const sliderMid = document.getElementById('eq-slider-mid');
        const sliderTreble = document.getElementById('eq-slider-treble');
        let eqThrottleTimer = null;
        const onSliderChange = (isFinal = false) => {
            const b = parseInt(sliderBass?.value || 50, 10);
            const m = parseInt(sliderMid?.value || 50, 10);
            const t = parseInt(sliderTreble?.value || 50, 10);
            // Clear active preset buttons to indicate custom EQ curve
            document.querySelectorAll('.eq-preset-btn').forEach(btn => btn.classList.remove('active'));
            this.eqSettings = { bass: b, mid: m, treble: t };
            this.updateEqSlidersUI();

            if (isFinal) {
                if (eqThrottleTimer) { clearTimeout(eqThrottleTimer); eqThrottleTimer = null; }
                this.setEqualizerBands(b, m, t);
            } else {
                if (!eqThrottleTimer) {
                    eqThrottleTimer = setTimeout(() => {
                        eqThrottleTimer = null;
                        this.setEqualizerBands(this.eqSettings.bass, this.eqSettings.mid, this.eqSettings.treble);
                    }, 40);
                }
            }
        };
        [sliderBass, sliderMid, sliderTreble].forEach(sl => {
            if (sl) {
                sl.addEventListener('input', () => onSliderChange(false));
                sl.addEventListener('change', () => onSliderChange(true));
            }
        });

        // EQ Preset Buttons
        document.querySelectorAll('.eq-preset-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const preset = e.currentTarget.getAttribute('data-preset');
                this.applyEqualizerPreset(preset);
            });
        });

        // Initialize UI states
        this.updateRepeatUI();
        this.updateEqSlidersUI();
        this.updateEqUI();

        // 360 Spatial Audio Drawer Button
        const npSpatialBtn = document.getElementById('np-btn-spatial');
        if (npSpatialBtn) {
            npSpatialBtn.addEventListener('click', () => this.openSpatialDrawer());
        }

        // Spatial Audio Sliders
        const sliderIntensity = document.getElementById('spatial-slider-intensity');
        const sliderWidth = document.getElementById('spatial-slider-width');
        const sliderDistance = document.getElementById('spatial-slider-distance');

        let spatialThrottleTimer = null;
        const onSpatialSliderChange = (isFinal = false) => {
            const intensity = parseInt(sliderIntensity?.value || 75, 10);
            const width = parseInt(sliderWidth?.value || 80, 10);
            const distance = parseInt(sliderDistance?.value || 40, 10);

            this.spatialSettings.intensity = intensity;
            this.spatialSettings.width = width;
            this.spatialSettings.distance = distance;
            this.updateSpatialSlidersUI();
            this.updateSpatialRadarUI();

            if (isFinal) {
                if (spatialThrottleTimer) { clearTimeout(spatialThrottleTimer); spatialThrottleTimer = null; }
                this.setSpatialParams(intensity, width, distance, this.spatialSettings.azimuth);
            } else {
                if (!spatialThrottleTimer) {
                    spatialThrottleTimer = setTimeout(() => {
                        spatialThrottleTimer = null;
                        this.setSpatialParams(this.spatialSettings.intensity, this.spatialSettings.width, this.spatialSettings.distance, this.spatialSettings.azimuth);
                    }, 40);
                }
            }
        };

        [sliderIntensity, sliderWidth, sliderDistance].forEach(sl => {
            if (sl) {
                sl.addEventListener('input', () => onSpatialSliderChange(false));
                sl.addEventListener('change', () => onSpatialSliderChange(true));
            }
        });

        this.setupSpatialRadar();
        this.updateSpatialSlidersUI();
        this.updateSpatialRadarUI();
        this.updateSpatialUI();
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
            const playSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';
            const pauseSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="4" height="16" x="6" y="4"></rect><rect width="4" height="16" x="14" y="4"></rect></svg>';
            btnIcon.innerHTML = `<i data-lucide="${isPlaying ? 'pause' : 'play'}" style="width: 24px; height: 24px; margin-left: ${isPlaying ? '0' : '2px'};" fill="currentColor">${isPlaying ? pauseSvg : playSvg}</i>`;
        }

        const npPlay = document.getElementById('np-play-pause');
        if (npPlay) {
            const npPlaySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';
            const npPauseSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="4" height="16" x="6" y="4"></rect><rect width="4" height="16" x="14" y="4"></rect></svg>';
            npPlay.innerHTML = `<i data-lucide="${isPlaying ? 'pause' : 'play'}" style="width: 40px; height: 40px; fill: white; margin-left: ${isPlaying ? '0' : '4px'};">${isPlaying ? npPauseSvg : npPlaySvg}</i>`;
        }

        const lpBtn = document.querySelector('.last-played-play-btn');
        if (lpBtn) {
            const lpPlaySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';
            const lpPauseSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="4" height="16" x="6" y="4"></rect><rect width="4" height="16" x="14" y="4"></rect></svg>';
            lpBtn.innerHTML = `<i data-lucide="${isPlaying ? 'pause' : 'play'}" style="width: 20px; height: 20px; margin-left: ${isPlaying ? '0' : '2px'};" fill="currentColor">${isPlaying ? lpPauseSvg : lpPlaySvg}</i>`;
        }

        // Update row icons based on state
        const rowPlaySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';
        const rowPauseSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="4" height="16" x="6" y="4"></rect><rect width="4" height="16" x="14" y="4"></rect></svg>';
        document.querySelectorAll('.action-play').forEach(btn => {
            const row = btn.closest('.track-row') || btn.closest('.track-item');
            if (row && this.currentTrack && String(row.dataset.id) === String(this.currentTrack.id)) {
                btn.innerHTML = `<i data-lucide="${isPlaying ? 'pause' : 'play'}">${isPlaying ? rowPauseSvg : rowPlaySvg}</i>`;
                if (isPlaying) btn.classList.add('active');
                else btn.classList.remove('active');
            } else {
                btn.innerHTML = `<i data-lucide="play">${rowPlaySvg}</i>`;
                btn.classList.remove('active');
            }
        });

        if (window.lucide) lucide.createIcons();
    }

    async resolveTrackPlayableUrl(track) {
        if (!track) return null;

        if (!track.s3Key && track.id) {
            let canonical = null;
            if (window.app?.musicLibrary && window.app.musicLibrary.length > 0) {
                canonical = window.app.musicLibrary.find(t => String(t.id) === String(track.id));
            }
            if (!canonical && window.OfflineManager && typeof window.OfflineManager.getLocalTrack === 'function') {
                canonical = window.OfflineManager.getLocalTrack(track.id);
            }
            if (canonical && canonical.s3Key) {
                track.s3Key = canonical.s3Key;
            }
        }

        let isOfflineTrack = false;
        if (window.OfflineManager) {
            isOfflineTrack = (track.s3Key && await window.OfflineManager.isDownloaded(track.s3Key)) ||
                             (await window.OfflineManager.isDownloaded(track.id));
            if (!isOfflineTrack && track._fromDownloads) {
                isOfflineTrack = true;
            }
        }

        if (isOfflineTrack) {
            if (typeof track._prefetchedUrl === 'string' && (track._prefetchedUrl.startsWith('http://') || track._prefetchedUrl.startsWith('https://'))) {
                track._prefetchedUrl = null;
                track._prefetchedAt = null;
            }

            try {
                const localUrls = (track.s3Key && await window.OfflineManager.getLocalUrls(track.s3Key)) ||
                                  (await window.OfflineManager.getLocalUrls(track.id));
                if (localUrls && (Capacitor.isNativePlatform() ? localUrls.nativeUrl : localUrls.webViewUrl)) {
                    track._prefetchedUrl = Capacitor.isNativePlatform() ? localUrls.nativeUrl : localUrls.webViewUrl;
                    track._prefetchedAt = null;
                    return track._prefetchedUrl;
                } else {
                    track._prefetchedUrl = null;
                    track._prefetchedAt = null;
                    return null;
                }
            } catch (e) {
                track._prefetchedUrl = null;
                track._prefetchedAt = null;
                return null;
            }
        } else {
            const isUrlExpired = track._prefetchedAt && (Date.now() - track._prefetchedAt > 45 * 60 * 1000);
            if (track._prefetchedUrl && !isUrlExpired && typeof track._prefetchedUrl === 'string' && track._prefetchedUrl.trim().length > 0) {
                return track._prefetchedUrl;
            }
            if (!navigator.onLine || !track.s3Key) {
                return null;
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
                        return data.url;
                    }
                }
            } catch (e) {
                clearTimeout(timeoutId);
            }
            return null;
        }
    }

    buildNativeQueueItem(track, url, isOffline = false) {
        let offline = Boolean(isOffline || track._fromDownloads || track.isOffline);
        if (!offline && window.OfflineManager && typeof window.OfflineManager.findTrackEntry === 'function') {
            const entry = window.OfflineManager.findTrackEntry(track.s3Key || track.id);
            if (entry && entry.localPath) {
                offline = true;
            }
        }
        if (!offline && url) {
            const lower = String(url).toLowerCase();
            if (lower.startsWith('file:') || lower.startsWith('content:')) {
                offline = true;
            }
        }

        let nativeArtwork = '';
        if (track.thumbnail && typeof track.thumbnail === 'string' && track.thumbnail.startsWith('http')) {
            nativeArtwork = track.thumbnail;
        } else if (typeof window.getReliableArtwork === 'function') {
            const resolved = window.getReliableArtwork(track);
            if (resolved && typeof resolved === 'string' && resolved.startsWith('http')) {
                nativeArtwork = resolved;
            }
        }

        return {
            source: url || '',
            trackId: String(track.id),
            queueItemUid: track._queueUid || ('q_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)),
            friendlyTitle: track.title || '',
            artistName: track.artist || '',
            albumTitle: track.album || '',
            artworkSource: nativeArtwork,
            s3Key: track.s3Key || '',
            urlFetchedAt: track._prefetchedAt || 0,
            isOffline: offline
        };
    }

    async playTrack(track, queueList = [], index = 0) {
        if (this.isDemoRunning) {
            this.stop3DMotorcycleDemo();
            this.wasPlayingBeforeDemo = false;
        }

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
            const finalUrl = await this.resolveTrackPlayableUrl(track);
            if (!finalUrl) {
                const isOfflineTrack = Boolean(track._fromDownloads || track.isOffline ||
                    (window.OfflineManager?.findTrackEntry && window.OfflineManager.findTrackEntry(track.s3Key || track.id)));
                if (isOfflineTrack) {
                    window.uiManager.showNotification("Downloaded audio file is missing or corrupted.", "error");
                } else if (!navigator.onLine) {
                    window.uiManager.showNotification("Cannot play this song while offline. Download it first to listen offline.", "warning");
                } else {
                    window.uiManager.showNotification("Failed to resolve audio for playback.", "error");
                }
                this.syncUIState(false);
                return false;
            }

            if (currentReqId !== this.playRequestId) return false; // Stale request

            if (Capacitor.isNativePlatform()) {
                // Concurrently resolve upcoming lookahead window, plus ALL downloaded/offline tracks across the entire queue
                const tracksToPreResolve = [];
                const seenToResolve = new Set();

                // 1. Upcoming window (up to 4 upcoming tracks for immediate lookahead)
                for (let i = this.queueIndex + 1; i < Math.min(this.queue.length, this.queueIndex + 5); i++) {
                    const qTrack = this.queue[i];
                    if (qTrack && !seenToResolve.has(String(qTrack.id))) {
                        seenToResolve.add(String(qTrack.id));
                        tracksToPreResolve.push(qTrack);
                    }
                }

                // 2. All downloaded/offline tracks anywhere in the queue so screen-off playback can play all offline tracks
                for (let i = 0; i < this.queue.length; i++) {
                    const qTrack = this.queue[i];
                    if (qTrack && !seenToResolve.has(String(qTrack.id)) && !qTrack._prefetchedUrl) {
                        const isOffline = Boolean(
                            qTrack._fromDownloads ||
                            qTrack.isOffline ||
                            (window.OfflineManager?.findTrackEntry && window.OfflineManager.findTrackEntry(qTrack.s3Key || qTrack.id))
                        );
                        if (isOffline) {
                            seenToResolve.add(String(qTrack.id));
                            tracksToPreResolve.push(qTrack);
                        }
                    }
                }

                if (tracksToPreResolve.length > 0) {
                    await Promise.allSettled(tracksToPreResolve.map(t => this.resolveTrackPlayableUrl(t)));
                }

                if (currentReqId !== this.playRequestId) return false; // Stale request

                // Build native items for the ENTIRE queue so native ExoPlayer can autonomously replenish screen-off
                const nativeItems = [];
                this.queuedTrackIds = new Set();

                for (let i = 0; i < this.queue.length; i++) {
                    const qTrack = this.queue[i];
                    let playableUrl = qTrack._prefetchedUrl || '';
                    if (i === this.queueIndex) {
                        playableUrl = finalUrl;
                    }
                    nativeItems.push(this.buildNativeQueueItem(qTrack, playableUrl));
                    if (playableUrl) {
                        this.queuedTrackIds.add(String(qTrack.id));
                    }
                }

                if (!this.nativeInitialized) {
                    console.log("[NATIVE AUDIO] create player");
                    const res = await NativeAudio.create({
                        audioId: 'main',
                        audioSource: finalUrl,
                        trackId: String(track.id),
                        friendlyTitle: track.title,
                        artistName: track.artist,
                        artworkSource: (track.thumbnail && typeof track.thumbnail === 'string' && track.thumbnail.startsWith('http')) ? track.thumbnail : '',
                        useForNotification: true
                    });

                    if (res && res.success === false) throw new Error("Failed to create NativeAudio");
                    this.nativeInitialized = true;
                    this.currentNativeSource = finalUrl;
                    this.currentNativeTrackId = String(track.id);

                    // Sync initial repeat mode and equalizer bands to native
                    let initialRepeatMode = 0;
                    if (this.repeatMode === 'one') initialRepeatMode = 1;
                    else if (this.repeatMode === 'all') initialRepeatMode = 2;
                    NativeAudio.setRepeatMode({ audioId: 'main', mode: initialRepeatMode }).catch(() => {});
                    if (this.eqSettings) {
                        NativeAudio.setEqualizerBands({ audioId: 'main', ...this.eqSettings, enabled: this.eqEnabled }).catch(() => {});
                        NativeAudio.setEqualizerEnabled({ enabled: this.eqEnabled }).catch(() => {});
                    }

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
                }

                console.log("[NATIVE AUDIO] setQueue with", nativeItems.length, "items, startIndex:", this.queueIndex);
                await NativeAudio.setQueue({
                    audioId: 'main',
                    items: nativeItems,
                    startIndex: this.queueIndex,
                    endpoint: typeof window.getApiUrl === 'function' ? window.getApiUrl('/.netlify/functions/music-play') : 'https://starlit-sable-83184f.netlify.app/.netlify/functions/music-play'
                });

                if (currentReqId !== this.playRequestId) return false; // Stale request

                console.log("[NATIVE AUDIO] play");
                await NativeAudio.play({ audioId: 'main' });
                this.currentNativeSource = finalUrl;
                this.currentNativeTrackId = String(track.id);
                this.saveLastPlayedTrack(track);

                // Maintain next tracks in native queue
                this.maintainNativeQueue();

                // Synchronize native audio DSP effects (Equalizer + 3D Spatial Audio)
                this.applyNativeAudioEq().catch(() => {});
                this.applyNativeSpatialAudio().catch(() => {});
            } else {
                this.audio.src = finalUrl;
                await this.audio.play();
                this.saveLastPlayedTrack(track);
                this.applyWebAudioEq();
                this.applyWebAudioSpatial();
            }

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
        if (this.isDemoRunning) {
            this.stop3DMotorcycleDemo();
            this.wasPlayingBeforeDemo = false;
        }

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

        console.log("[MPT_DIAG] Track genuinely ended. Repeat mode:", this.repeatMode, "Queue index:", this.queueIndex, "Queue length:", this.queue.length);

        // Handle Repeat One
        if (this.repeatMode === 'one' && this.currentTrack) {
            console.log("[MPT_DIAG] Repeat One active, restarting current track from 0");
            if (Capacitor.isNativePlatform() && this.nativeInitialized) {
                NativeAudio.seek({ audioId: 'main', timeInSeconds: 0 }).then(() => {
                    NativeAudio.play({ audioId: 'main' });
                }).catch(() => {});
            } else if (this.audio) {
                this.audio.currentTime = 0;
                this.audio.play().catch(() => {});
            }
            return;
        }

        let nextIdx = this.queueIndex + 1;
        if (this.repeatMode === 'all' && nextIdx >= this.queue.length && this.queue.length > 0) {
            nextIdx = 0;
        }

        if (nextIdx >= 0 && nextIdx < this.queue.length) {
            this.isTransitioning = true;
            this.playTrack(this.queue[nextIdx], this.queue, nextIdx)
                .finally(() => {
                    this.isTransitioning = false;
                });
        } else {
            // End of queue reached with Repeat Off
            console.log("[MPT_DIAG] End of queue reached with Repeat Off, stopping playback");
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

        const transitionedId = data.trackId ? String(data.trackId) : null;
        const targetTrackId = transitionedId && transitionedId.includes('::') ? transitionedId.split('::')[0] : transitionedId;
        const targetUid = data.queueItemUid || (transitionedId && transitionedId.includes('::') ? transitionedId.split('::')[1] : null);
        const transitionedSource = data.source || null;

        // Reconcile identity against current queue
        let matchIndex = -1;
        if (targetUid) {
            matchIndex = this.queue.findIndex(t => t._queueUid && t._queueUid === targetUid);
        }
        if (matchIndex === -1 && targetTrackId) {
            // Search forward from current queueIndex to find next occurrence (handles duplicates correctly)
            for (let i = this.queueIndex + 1; i < this.queue.length; i++) {
                if (String(this.queue[i].id) === String(targetTrackId) || (this.queue[i].s3Key && this.queue[i].s3Key === String(targetTrackId))) {
                    matchIndex = i;
                    break;
                }
            }
            if (matchIndex === -1) {
                matchIndex = this.queue.findIndex(t => String(t.id) === String(targetTrackId) || (t.s3Key && t.s3Key === String(targetTrackId)));
            }
        }
        if (matchIndex === -1 && transitionedSource) {
            matchIndex = this.queue.findIndex(t => (t._prefetchedUrl && t._prefetchedUrl === transitionedSource) || t.localPath === transitionedSource);
        }

        if (matchIndex === -1) {
            console.warn("[MPT_DIAG] Ignoring unexpected transition event: could not identify track in queue:", transitionedId);
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

        // Replenish native queue lookahead window & Up Next UI
        this.maintainNativeQueue();
        this.renderUpNextDrawer();

        // Re-apply equalizer settings to ensure effect session remains synchronized across transitions
        this.applyNativeAudioEq().catch(() => {});
        this.applyNativeSpatialAudio().catch(() => {});
    }

    async syncFromNative() {
        if (!Capacitor.isNativePlatform() || !this.nativeInitialized) return;
        try {
            const rep = await NativeAudio.getRepeatMode({ audioId: 'main' });
            if (rep && typeof rep.mode === 'number') {
                const modes = ['off', 'one', 'all'];
                if (modes[rep.mode] && modes[rep.mode] !== this.repeatMode) {
                    this.repeatMode = modes[rep.mode];
                    this.updateRepeatUI();
                }
            }
            this.updateUI();
            this.renderUpNextDrawer();
        } catch (e) {
            console.warn("[PLAYER] syncFromNative error:", e);
        }
    }

    playNext() {
        if (this.isTransitioning) {
            console.log("[MPT_DIAG] playNext ignored: transition already in progress");
            return;
        }

        let nextIdx = this.queueIndex + 1;
        if (this.repeatMode === 'all' && nextIdx >= this.queue.length && this.queue.length > 0) {
            nextIdx = 0;
        }

        if (nextIdx >= 0 && nextIdx < this.queue.length) {
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

    async maintainNativeQueue() {
        if (!Capacitor.isNativePlatform() || !this.nativeInitialized) return;
        const currentGen = this.playbackGeneration;
        const lookaheadCount = 5;
        const tracksToResolve = [];

        for (let i = this.queueIndex + 1; i < Math.min(this.queue.length, this.queueIndex + 1 + lookaheadCount); i++) {
            const t = this.queue[i];
            if (t && (!this.queuedTrackIds || !this.queuedTrackIds.has(String(t.id)))) {
                tracksToResolve.push(t);
            }
        }

        if (tracksToResolve.length === 0) return;

        await Promise.allSettled(tracksToResolve.map(t => this.resolveTrackPlayableUrl(t)));

        if (this.playbackGeneration !== currentGen) return; // Stale

        const newItems = [];
        for (const t of tracksToResolve) {
            if (t._prefetchedUrl) {
                newItems.push(this.buildNativeQueueItem(t, t._prefetchedUrl));
                if (this.queuedTrackIds) {
                    this.queuedTrackIds.add(String(t.id));
                }
            }
        }

        if (newItems.length > 0) {
            try {
                await NativeAudio.addQueueItems({ audioId: 'main', items: newItems });
                console.log("[MPT_DIAG] Appended", newItems.length, "items to native ExoPlayer queue");
            } catch (e) {
                console.warn("[MPT_DIAG] addQueueItems failed", e);
            }
        }
    }

    async prefetchSingleTrack(track) {
        return this.resolveTrackPlayableUrl(track);
    }

    async prefetchNextTrack() {
        return this.maintainNativeQueue();
    }

    async playPrev() {
        if (this.isTransitioning) {
            console.log("[MPT_DIAG] playPrev ignored: transition already in progress");
            return;
        }

        let prevIdx = this.queueIndex - 1;
        if (this.repeatMode === 'all' && prevIdx < 0 && this.queue.length > 0) {
            prevIdx = this.queue.length - 1;
        }

        if (prevIdx >= 0 && prevIdx < this.queue.length) {
            console.log("[MPT_DIAG] playPrev navigating directly from", this.queueIndex, "to", prevIdx);
            this.isTransitioning = true;
            this.playTrack(this.queue[prevIdx], this.queue, prevIdx)
                .finally(() => {
                    this.isTransitioning = false;
                });
        } else {
            // At start of queue with repeat off: seek to 0:00
            if (Capacitor.isNativePlatform() && this.nativeInitialized) {
                try {
                    await NativeAudio.seek({ audioId: 'main', timeInSeconds: 0 });
                } catch(e) {}
            } else if (this.audio) {
                this.audio.currentTime = 0;
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

        const artwork = (typeof window.getReliableArtwork === 'function')
            ? window.getReliableArtwork(track)
            : (track.thumbnail || '/assets/covers/default.svg');

        const artworkContainer = document.getElementById('player-artwork');
        if (artworkContainer) {
            artworkContainer.innerHTML = `<img src="${artwork}" alt="Artwork" onerror="this.src='/assets/covers/default.svg'">`;
        }

        const npArtworkContainer = document.getElementById('np-artwork');
        if (npArtworkContainer) {
            npArtworkContainer.innerHTML = `<img src="${artwork}" alt="Artwork" onerror="this.src='/assets/covers/default.svg'">`;
        }

        // Set Media Session API for Web/PWA browsers (Native Android MediaSession is managed by Media3 AudioPlayerService)
        if (!Capacitor.isNativePlatform() && 'mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: track.title,
                artist: track.artist,
                artwork: [{ src: artwork, sizes: '500x500', type: 'image/jpeg' }]
            });

            navigator.mediaSession.setActionHandler('play', () => this.togglePlay());
            navigator.mediaSession.setActionHandler('pause', () => this.togglePlay());
            navigator.mediaSession.setActionHandler('previoustrack', () => this.playPrev());
            navigator.mediaSession.setActionHandler('nexttrack', () => this.playNext());
        }

        // Reset progress visually
        const pb = document.getElementById('progress-bar');
        if (pb) pb.style.width = `0%`;
        const tc = document.getElementById('time-current');
        if (tc) tc.textContent = "0:00";

        const npPb = document.getElementById('np-progress-bar');
        if (npPb) npPb.style.width = `0%`;
        const npTc = document.getElementById('np-time-current');
        if (npTc) npTc.textContent = "0:00";

        this.renderUpNextDrawer();
    }

    // =========================================================================
    // Repeat Mode Methods
    // =========================================================================
    async setRepeatMode(mode) {
        if (!['off', 'all', 'one'].includes(mode)) mode = 'off';
        this.repeatMode = mode;
        try {
            localStorage.setItem('mpt_repeat_mode', mode);
        } catch (e) {}

        if (Capacitor.isNativePlatform() && this.nativeInitialized) {
            const modeInt = mode === 'one' ? 1 : (mode === 'all' ? 2 : 0);
            try {
                await NativeAudio.setRepeatMode({ audioId: 'main', mode: modeInt });
            } catch (e) {
                console.warn("[REPEAT] Failed to set native repeat mode:", e);
            }
        } else if (this.audio) {
            this.audio.loop = (mode === 'one');
        }

        this.updateRepeatUI();
    }

    toggleRepeatMode() {
        const next = this.repeatMode === 'off' ? 'all' : (this.repeatMode === 'all' ? 'one' : 'off');
        this.setRepeatMode(next);
        const labels = { off: 'Repeat Off', all: 'Repeat All', one: 'Repeat One' };
        window.uiManager?.showNotification(`Repeat mode: ${labels[next]}`, 'info');
    }

    updateRepeatUI() {
        const btn = document.getElementById('np-repeat-btn');
        const badge = document.getElementById('np-repeat-badge');
        if (!btn) return;

        btn.classList.toggle('active', this.repeatMode !== 'off');
        if (this.repeatMode === 'off') {
            btn.style.color = 'var(--secondary-text)';
            if (badge) badge.textContent = 'Repeat Off';
            btn.innerHTML = `<i data-lucide="repeat" id="np-repeat-icon" style="width: 24px; height: 24px;"></i>`;
        } else if (this.repeatMode === 'all') {
            btn.style.color = 'var(--accent-color)';
            if (badge) badge.textContent = 'Repeat All';
            btn.innerHTML = `<i data-lucide="repeat" id="np-repeat-icon" style="width: 24px; height: 24px; color: var(--accent-color);"></i>`;
        } else if (this.repeatMode === 'one') {
            btn.style.color = 'var(--accent-color)';
            if (badge) badge.textContent = 'Repeat One';
            btn.innerHTML = `<i data-lucide="repeat-1" id="np-repeat-icon" style="width: 24px; height: 24px; color: var(--accent-color);"></i>`;
        }
        if (window.lucide) lucide.createIcons({ root: btn });
    }

    // =========================================================================
    // Queue Management Methods (Play Next, Add to Queue, Remove, Up Next)
    // =========================================================================
    async playNextTrack(track) {
        if (!track) return;
        const queueTrack = {
            ...track,
            _queueUid: 'q_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)
        };
        const insertIdx = (this.queueIndex >= 0 && this.queueIndex < this.queue.length)
            ? this.queueIndex + 1
            : this.queue.length;

        this.queue.splice(insertIdx, 0, queueTrack);

        if (Capacitor.isNativePlatform() && this.nativeInitialized) {
            let playableUrl = queueTrack._prefetchedUrl || '';
            if (!playableUrl) {
                playableUrl = await this.resolveTrackPlayableUrl(queueTrack);
            }
            const nativeItem = this.buildNativeQueueItem(queueTrack, playableUrl || '');
            nativeItem.queueItemUid = queueTrack._queueUid;
            try {
                await NativeAudio.playNext({ audioId: 'main', item: nativeItem });
            } catch (e) {
                console.warn("[QUEUE] Native playNext call failed:", e);
            }
        }

        window.uiManager?.showNotification(`Playing next: ${track.title}`, 'success');
        this.renderUpNextDrawer();
    }

    async addToQueue(track) {
        if (!track) return;
        const queueTrack = {
            ...track,
            _queueUid: 'q_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)
        };
        this.queue.push(queueTrack);

        if (Capacitor.isNativePlatform() && this.nativeInitialized) {
            let playableUrl = queueTrack._prefetchedUrl || '';
            if (!playableUrl) {
                playableUrl = await this.resolveTrackPlayableUrl(queueTrack);
            }
            const nativeItem = this.buildNativeQueueItem(queueTrack, playableUrl || '');
            nativeItem.queueItemUid = queueTrack._queueUid;
            try {
                await NativeAudio.addQueueItems({ audioId: 'main', items: [nativeItem] });
            } catch (e) {
                console.warn("[QUEUE] Native addToQueue call failed:", e);
            }
        }

        window.uiManager?.showNotification(`Added to queue: ${track.title}`, 'success');
        this.renderUpNextDrawer();
    }

    async removeFromQueue(queueIdx) {
        if (queueIdx < 0 || queueIdx >= this.queue.length) return;
        if (queueIdx === this.queueIndex) {
            window.uiManager?.showNotification("Cannot remove currently playing track", "warning");
            return;
        }

        const removed = this.queue.splice(queueIdx, 1)[0];
        if (queueIdx < this.queueIndex) {
            this.queueIndex--;
        }

        if (Capacitor.isNativePlatform() && this.nativeInitialized && removed._queueUid) {
            try {
                await NativeAudio.removeQueueItem({ audioId: 'main', queueItemUid: removed._queueUid });
            } catch (e) {
                console.warn("[QUEUE] Native removeQueueItem failed:", e);
            }
        }

        this.renderUpNextDrawer();
    }

    openUpNextDrawer() {
        const drawer = document.getElementById('drawer-up-next');
        if (drawer) {
            drawer.classList.add('active');
            this.renderUpNextDrawer();
        }
    }

    closeUpNextDrawer() {
        const drawer = document.getElementById('drawer-up-next');
        if (drawer) {
            drawer.classList.remove('active');
        }
    }

    renderUpNextDrawer() {
        const currentContainer = document.getElementById('up-next-current');
        const listContainer = document.getElementById('up-next-list');
        const countLabel = document.getElementById('up-next-count');
        if (!listContainer) return;

        const remainingCount = Math.max(0, this.queue.length - (this.queueIndex + 1));
        if (countLabel) {
            countLabel.textContent = `${remainingCount} upcoming song${remainingCount === 1 ? '' : 's'}`;
        }

        // Render current track
        if (currentContainer) {
            if (this.currentTrack) {
                const artwork = (typeof window.getReliableArtwork === 'function')
                    ? window.getReliableArtwork(this.currentTrack)
                    : (this.currentTrack.thumbnail || '/assets/covers/default.svg');
                currentContainer.innerHTML = `
                    <img src="${artwork}" class="up-next-artwork" alt="" onerror="this.src='/assets/covers/default.svg'">
                    <div class="up-next-info">
                        <div class="up-next-title">${this.currentTrack.title}</div>
                        <div class="up-next-artist">${this.currentTrack.artist}</div>
                    </div>
                    <div class="up-next-actions">
                        <span style="font-size: 11px; font-weight: 700; color: var(--accent-color); padding: 4px 8px; background: rgba(255, 107, 0, 0.15); border-radius: 6px;">PLAYING</span>
                    </div>
                `;
            } else {
                currentContainer.innerHTML = `<div style="font-size: 13px; color: var(--secondary-text);">No track currently playing</div>`;
            }
        }

        // Render upcoming tracks
        listContainer.innerHTML = '';
        if (this.queue.length <= 1 || this.queueIndex >= this.queue.length - 1) {
            listContainer.innerHTML = `<div style="font-size: 13px; color: var(--secondary-text); padding: 12px 0; text-align: center;">Queue is empty. Use "Play Next" or "Add to Queue" on songs!</div>`;
            return;
        }

        for (let i = this.queueIndex + 1; i < this.queue.length; i++) {
            const track = this.queue[i];
            const row = document.createElement('div');
            row.className = 'up-next-row';
            const artwork = (typeof window.getReliableArtwork === 'function')
                ? window.getReliableArtwork(track)
                : (track.thumbnail || '/assets/covers/default.svg');

            row.innerHTML = `
                <img src="${artwork}" class="up-next-artwork" alt="" onerror="this.src='/assets/covers/default.svg'">
                <div class="up-next-info">
                    <div class="up-next-title">${track.title}</div>
                    <div class="up-next-artist">${track.artist}</div>
                </div>
                <div class="up-next-actions">
                    <button class="icon-btn remove-from-queue-btn" data-index="${i}" title="Remove from queue" aria-label="Remove from queue" style="color: var(--secondary-text);">
                        <i data-lucide="trash-2" style="width: 18px; height: 18px;"></i>
                    </button>
                </div>
            `;

            const removeBtn = row.querySelector('.remove-from-queue-btn');
            if (removeBtn) {
                removeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const idx = parseInt(removeBtn.getAttribute('data-index'), 10);
                    this.removeFromQueue(idx);
                });
            }

            row.addEventListener('click', () => {
                this.playTrack(track, this.queue, i);
                this.closeUpNextDrawer();
            });

            listContainer.appendChild(row);
        }

        if (window.lucide) lucide.createIcons({ root: listContainer });
    }

    // =========================================================================
    // Equalizer & Audio Effects Methods
    // =========================================================================
    initWebAudioEq() {
        this.initWebAudioDSP();
    }

    initWebAudioDSP() {
        if (Capacitor.isNativePlatform()) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext || !this.audio) return;

            const initContext = () => {
                if (this.webAudioInitialized) return;
                try {
                    this.audioCtx = new AudioContext();
                    this.sourceNode = this.audioCtx.createMediaElementSource(this.audio);

                    // Equalizer Filters
                    this.bassFilter = this.audioCtx.createBiquadFilter();
                    this.bassFilter.type = 'lowshelf';
                    this.bassFilter.frequency.value = 250;

                    this.midFilter = this.audioCtx.createBiquadFilter();
                    this.midFilter.type = 'peaking';
                    this.midFilter.frequency.value = 1000;
                    this.midFilter.Q.value = 1.0;

                    this.trebleFilter = this.audioCtx.createBiquadFilter();
                    this.trebleFilter.type = 'highshelf';
                    this.trebleFilter.frequency.value = 4000;

                    // 3D Spatial Audio Node (HRTF Binaural Panner)
                    this.pannerNode = this.audioCtx.createPanner();
                    this.pannerNode.panningModel = 'HRTF';
                    this.pannerNode.distanceModel = 'inverse';
                    this.pannerNode.refDistance = 1;
                    this.pannerNode.maxDistance = 100;
                    this.pannerNode.rolloffFactor = 1.0;

                    // Air Absorption Filter (High frequency rolloff with distance)
                    this.airAbsorptionFilter = this.audioCtx.createBiquadFilter();
                    this.airAbsorptionFilter.type = 'lowpass';
                    this.airAbsorptionFilter.frequency.value = 20000;

                    // Dry/Wet Blending Gains for Spatial processing
                    this.spatialDryGain = this.audioCtx.createGain();
                    this.spatialWetGain = this.audioCtx.createGain();

                    // Dynamics compressor / soft limiter to prevent clipping when EQ and Spatial are both boosted
                    this.limiterNode = this.audioCtx.createDynamicsCompressor();
                    this.limiterNode.threshold.value = -1.0;
                    this.limiterNode.knee.value = 10;
                    this.limiterNode.ratio.value = 12;
                    this.limiterNode.attack.value = 0.003;
                    this.limiterNode.release.value = 0.25;

                    // Signal Graph Wiring:
                    // source -> bass -> mid -> treble
                    this.sourceNode.connect(this.bassFilter);
                    this.bassFilter.connect(this.midFilter);
                    this.midFilter.connect(this.trebleFilter);

                    // Treble splits to Dry path (straight to limiter) and Wet Spatial path
                    this.trebleFilter.connect(this.spatialDryGain);
                    this.spatialDryGain.connect(this.limiterNode);

                    this.trebleFilter.connect(this.airAbsorptionFilter);
                    this.airAbsorptionFilter.connect(this.spatialWetGain);
                    this.spatialWetGain.connect(this.pannerNode);
                    this.pannerNode.connect(this.limiterNode);

                    this.limiterNode.connect(this.audioCtx.destination);

                    this.webAudioInitialized = true;
                    this.applyWebAudioEq();
                    this.applyWebAudioSpatial();
                } catch (e) {
                    console.warn("[WEB AUDIO] Init failed:", e);
                }
            };

            window.addEventListener('click', initContext, { once: true });
            this.audio.addEventListener('play', initContext, { once: true });
        } catch (e) {
            console.warn("[WEB AUDIO] AudioContext not available:", e);
        }
    }

    applyWebAudioEq() {
        if (!this.webAudioInitialized || !this.bassFilter) return;
        try {
            const mapGain = (val) => this.eqEnabled ? (((val - 50) / 50) * 12) : 0; // -12dB to +12dB or 0 when disabled
            this.bassFilter.gain.value = mapGain(this.eqSettings.bass);
            this.midFilter.gain.value = mapGain(this.eqSettings.mid);
            this.trebleFilter.gain.value = mapGain(this.eqSettings.treble);
        } catch (e) {}
    }

    async applyNativeAudioEq() {
        if (!Capacitor.isNativePlatform()) return;
        try {
            await NativeAudio.setEqualizerBands({
                bass: this.eqSettings.bass,
                mid: this.eqSettings.mid,
                treble: this.eqSettings.treble,
                enabled: this.eqEnabled
            });
            await NativeAudio.setEqualizerEnabled({
                enabled: this.eqEnabled
            });
        } catch (e) {
            console.warn("[EQ] Failed to set native equalizer settings:", e);
        }
    }

    async setEqualizerEnabled(enabled) {
        this.eqEnabled = !!enabled;
        try {
            localStorage.setItem('mpt_eq_enabled', this.eqEnabled ? 'true' : 'false');
        } catch (e) {}

        if (Capacitor.isNativePlatform()) {
            try {
                await NativeAudio.setEqualizerEnabled({ enabled: this.eqEnabled });
            } catch (e) {
                console.warn("[EQ] Failed to set native equalizer enabled:", e);
            }
        } else {
            this.applyWebAudioEq();
        }
        this.updateEqUI();
    }

    resetEqualizer() {
        this.applyEqualizerPreset('flat');
    }

    async setEqualizerBands(bass, mid, treble) {
        this.eqSettings = {
            bass: Math.max(0, Math.min(100, Number(bass) || 50)),
            mid: Math.max(0, Math.min(100, Number(mid) || 50)),
            treble: Math.max(0, Math.min(100, Number(treble) || 50))
        };
        try {
            localStorage.setItem('mpt_eq_settings', JSON.stringify(this.eqSettings));
        } catch (e) {}

        if (Capacitor.isNativePlatform()) {
            await this.applyNativeAudioEq();
        } else {
            this.applyWebAudioEq();
        }
        this.updateEqSlidersUI();
    }

    applyEqualizerPreset(presetName) {
        const presets = {
            flat: { bass: 50, mid: 50, treble: 50 },
            bass: { bass: 90, mid: 45, treble: 45 },
            vocal: { bass: 30, mid: 85, treble: 55 },
            pop: { bass: 70, mid: 55, treble: 75 },
            rock: { bass: 85, mid: 35, treble: 80 },
            classical: { bass: 45, mid: 70, treble: 65 }
        };
        const p = presets[presetName] || presets.flat;
        this.setEqualizerBands(p.bass, p.mid, p.treble);

        document.querySelectorAll('.eq-preset-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-preset') === presetName);
        });
    }

    updateEqSlidersUI() {
        const sliderBass = document.getElementById('eq-slider-bass');
        const sliderMid = document.getElementById('eq-slider-mid');
        const sliderTreble = document.getElementById('eq-slider-treble');

        const valBass = document.getElementById('eq-val-bass');
        const valMid = document.getElementById('eq-val-mid');
        const valTreble = document.getElementById('eq-val-treble');

        if (sliderBass) sliderBass.value = this.eqSettings.bass;
        if (sliderMid) sliderMid.value = this.eqSettings.mid;
        if (sliderTreble) sliderTreble.value = this.eqSettings.treble;

        if (valBass) valBass.textContent = `${this.eqSettings.bass}%`;
        if (valMid) valMid.textContent = `${this.eqSettings.mid}%`;
        if (valTreble) valTreble.textContent = `${this.eqSettings.treble}%`;
    }

    updateEqUI() {
        const toggle = document.getElementById('eq-toggle-enabled');
        if (toggle) toggle.checked = this.eqEnabled;

        const slidersContainer = document.getElementById('eq-sliders-container');
        if (slidersContainer) {
            slidersContainer.classList.toggle('eq-disabled', !this.eqEnabled);
        }

        const presetsRow = document.querySelector('.eq-presets-row');
        if (presetsRow) {
            presetsRow.classList.toggle('eq-disabled', !this.eqEnabled);
        }

        const label = document.getElementById('eq-status-label');
        if (label) {
            if (!this.eqEnabled) {
                label.textContent = 'Equalizer Bypassed (Off)';
            } else if (Capacitor.isNativePlatform()) {
                label.textContent = 'Native Hardware Equalizer Active';
            } else {
                label.textContent = 'Web Audio DSP Active';
            }
        }
    }

    openEqDrawer() {
        const drawer = document.getElementById('drawer-eq');
        if (drawer) {
            drawer.classList.add('active');
            this.updateEqSlidersUI();
            this.updateEqUI();
            if (Capacitor.isNativePlatform()) {
                NativeAudio.getEqualizerStatus({}).then(status => {
                    const label = document.getElementById('eq-status-label');
                    if (label) {
                        if (!this.eqEnabled) {
                            label.textContent = 'Equalizer Bypassed (Off)';
                        } else if (status && status.isAvailable) {
                            const bands = status.numBands ? `${status.numBands}-Band ` : '';
                            const ctrl = status.hasControl ? 'Hardware DSP Active' : 'DSP Attached';
                            label.textContent = `${bands}${ctrl} (Session ${status.sessionId || 'Ready'})`;
                        } else {
                            label.textContent = 'DSP Initializing / Waiting for Playback';
                        }
                    }
                }).catch(() => {});
            }
        }
    }

    closeEqDrawer() {
        const drawer = document.getElementById('drawer-eq');
        if (drawer) {
            drawer.classList.remove('active');
        }
    }

    // =========================================================================
    // 360° Spatial Audio & 3D Surround Sound Engine
    // =========================================================================
    applyWebAudioSpatial() {
        if (!this.webAudioInitialized || !this.audioCtx || !this.spatialWetGain) return;
        try {
            const now = this.audioCtx.currentTime;
            if (!this.spatialSettings.enabled) {
                this.spatialWetGain.gain.setTargetAtTime(0, now, 0.04);
                this.spatialDryGain.gain.setTargetAtTime(1.0, now, 0.04);
                return;
            }

            const wet = (this.spatialSettings.intensity / 100.0);
            const dry = Math.max(0.05, 1.0 - (wet * 0.6));
            this.spatialWetGain.gain.setTargetAtTime(wet, now, 0.04);
            this.spatialDryGain.gain.setTargetAtTime(dry, now, 0.04);

            // Calculate 3D coordinates based on azimuth angle and distance
            const rad = (this.spatialSettings.azimuth * Math.PI) / 180.0;
            const widthMult = 0.5 + (this.spatialSettings.width / 100.0) * 1.0;
            const distMeters = 1.2 + (this.spatialSettings.distance / 100.0) * 6.0;

            const x = Math.sin(rad) * distMeters * widthMult;
            const z = -Math.cos(rad) * distMeters;

            if (this.pannerNode.positionX) {
                this.pannerNode.positionX.setTargetAtTime(x, now, 0.05);
                this.pannerNode.positionY.setTargetAtTime(0, now, 0.05);
                this.pannerNode.positionZ.setTargetAtTime(z, now, 0.05);
            } else if (typeof this.pannerNode.setPosition === 'function') {
                this.pannerNode.setPosition(x, 0, z);
            }

            // High frequency distance rolloff (air absorption)
            if (this.airAbsorptionFilter) {
                const cutoff = 20000 - (this.spatialSettings.distance / 100.0) * 13000;
                this.airAbsorptionFilter.frequency.setTargetAtTime(cutoff, now, 0.05);
            }
        } catch (e) {
            console.warn("[WEB AUDIO] Error applying spatial settings:", e);
        }
    }

    async applyNativeSpatialAudio() {
        if (!Capacitor.isNativePlatform()) return;
        try {
            await NativeAudio.setSpatialAudioParams({
                enabled: this.spatialSettings.enabled,
                intensity: this.spatialSettings.intensity,
                width: this.spatialSettings.width,
                distance: this.spatialSettings.distance,
                azimuth: this.spatialSettings.azimuth
            });
        } catch (e) {
            console.warn("[SPATIAL] Failed to set native spatial params:", e);
        }
    }

    async setSpatialAudioEnabled(enabled) {
        this.spatialSettings.enabled = !!enabled;
        this.saveSpatialSettings();

        if (Capacitor.isNativePlatform()) {
            await this.applyNativeSpatialAudio();
        } else {
            this.applyWebAudioSpatial();
        }
        this.updateSpatialUI();
    }

    async setSpatialParams(intensity, width, distance, azimuth) {
        if (typeof intensity === 'number' && !isNaN(intensity)) {
            this.spatialSettings.intensity = Math.max(0, Math.min(100, intensity));
        }
        if (typeof width === 'number' && !isNaN(width)) {
            this.spatialSettings.width = Math.max(0, Math.min(100, width));
        }
        if (typeof distance === 'number' && !isNaN(distance)) {
            this.spatialSettings.distance = Math.max(0, Math.min(100, distance));
        }
        if (typeof azimuth === 'number' && !isNaN(azimuth)) {
            this.spatialSettings.azimuth = ((Math.round(azimuth) % 360) + 360) % 360;
        }

        this.saveSpatialSettings();

        if (Capacitor.isNativePlatform()) {
            await this.applyNativeSpatialAudio();
        } else {
            this.applyWebAudioSpatial();
        }
        this.updateSpatialSlidersUI();
        this.updateSpatialRadarUI();
    }

    setSpatialPositionPreset(preset) {
        if (this.autoOrbitInterval) {
            this.stopAutoOrbit();
        }
        if (preset === 'front') {
            this.setSpatialParams(null, 80, 35, 0);
        } else if (preset === 'wide') {
            this.setSpatialParams(null, 100, 50, 45);
        } else if (preset === 'surround') {
            this.setSpatialParams(null, 90, 65, 180);
        }
        document.querySelectorAll('.spatial-pos-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-pos') === preset);
        });
    }

    toggleAutoOrbit() {
        if (this.autoOrbitInterval) {
            this.stopAutoOrbit();
        } else {
            this.startAutoOrbit();
        }
    }

    startAutoOrbit() {
        if (this.autoOrbitInterval) clearInterval(this.autoOrbitInterval);
        this.spatialSettings.autoOrbit = true;
        const btn = document.getElementById('btn-spatial-orbit');
        if (btn) btn.classList.add('active');

        document.querySelectorAll('.spatial-pos-btn').forEach(b => {
            if (b !== btn) b.classList.remove('active');
        });

        if (!this.spatialSettings.enabled) {
            this.setSpatialAudioEnabled(true);
        }

        let angle = this.spatialSettings.azimuth || 0;
        this.autoOrbitInterval = setInterval(() => {
            angle = (angle + 3) % 360;
            this.spatialSettings.azimuth = angle;
            this.updateSpatialRadarUI();
            if (Capacitor.isNativePlatform()) {
                if (angle % 12 === 0) {
                    this.applyNativeSpatialAudio();
                }
            } else {
                this.applyWebAudioSpatial();
            }
        }, 50);
    }

    stopAutoOrbit() {
        if (this.autoOrbitInterval) {
            clearInterval(this.autoOrbitInterval);
            this.autoOrbitInterval = null;
        }
        this.spatialSettings.autoOrbit = false;
        const btn = document.getElementById('btn-spatial-orbit');
        if (btn) btn.classList.remove('active');
        this.saveSpatialSettings();
        if (Capacitor.isNativePlatform()) {
            this.applyNativeSpatialAudio();
        }
    }

    resetSpatialAudio() {
        if (this.autoOrbitInterval) this.stopAutoOrbit();
        this.spatialSettings = {
            enabled: true,
            intensity: 75,
            width: 80,
            distance: 40,
            azimuth: 0,
            autoOrbit: false
        };
        this.saveSpatialSettings();
        if (Capacitor.isNativePlatform()) {
            this.applyNativeSpatialAudio();
        } else {
            this.applyWebAudioSpatial();
        }
        this.updateSpatialUI();
        this.updateSpatialSlidersUI();
        this.updateSpatialRadarUI();
        this.setSpatialPositionPreset('front');
    }

    // 3D Audio Demonstration (Procedural Motorcycle Approach & Flyby)
    async toggle3DMotorcycleDemo() {
        if (this.isDemoRunning) {
            this.stop3DMotorcycleDemo();
        } else {
            this.play3DMotorcycleDemo();
        }
    }

    async play3DMotorcycleDemo() {
        if (this.isDemoRunning) return;
        this.isDemoRunning = true;

        const demoBtn = document.getElementById('btn-spatial-demo');
        const demoText = document.getElementById('spatial-demo-text');
        const demoIcon = document.getElementById('spatial-demo-icon');
        if (demoBtn) demoBtn.classList.add('demo-running');
        if (demoText) demoText.textContent = 'Stop Demo';
        if (demoIcon) demoIcon.setAttribute('data-lucide', 'square');
        if (window.lucide) lucide.createIcons();

        // If music was playing, pause it gracefully
        this.wasPlayingBeforeDemo = false;
        if (Capacitor.isNativePlatform() && this.nativeInitialized) {
            try {
                const { isPlaying } = await NativeAudio.isPlaying({ audioId: 'main' });
                if (isPlaying) {
                    this.wasPlayingBeforeDemo = true;
                    await NativeAudio.pause({ audioId: 'main' });
                    this.syncUIState(false);
                }
            } catch(e) {}
        } else if (this.audio && !this.audio.paused) {
            this.wasPlayingBeforeDemo = true;
            this.audio.pause();
            this.syncUIState(false);
        }

        // Initialize AudioContext for demo
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!this.demoAudioCtx) {
            this.demoAudioCtx = new AudioContext();
        }
        if (this.demoAudioCtx.state === 'suspended') {
            await this.demoAudioCtx.resume();
        }

        const ctx = this.demoAudioCtx;
        const startTime = ctx.currentTime;
        const duration = 9.0; // 9-second flyby sequence

        // Procedural Motorcycle Audio Synthesis Graph:
        // 1. Two harmonic oscillators simulating combustion cylinders
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        osc1.type = 'sawtooth';
        osc2.type = 'triangle';

        // 2. Sub-bass thump oscillator for engine rumble
        const subOsc = ctx.createOscillator();
        subOsc.type = 'sawtooth';

        // 3. Cylinder resonance filter (exhaust body)
        const exhaustFilter = ctx.createBiquadFilter();
        exhaustFilter.type = 'bandpass';
        exhaustFilter.frequency.setValueAtTime(320, startTime);
        exhaustFilter.Q.setValueAtTime(3.2, startTime);

        // 4. Air absorption distance filter
        const airFilter = ctx.createBiquadFilter();
        airFilter.type = 'lowpass';
        airFilter.frequency.setValueAtTime(900, startTime);

        // 5. Engine gain envelope
        const masterGain = ctx.createGain();
        masterGain.gain.setValueAtTime(0.001, startTime);

        // 6. HRTF 3D Panner
        const demoPanner = ctx.createPanner();
        demoPanner.panningModel = 'HRTF';
        demoPanner.distanceModel = 'inverse';
        demoPanner.refDistance = 1;
        demoPanner.maxDistance = 100;
        demoPanner.rolloffFactor = 1.0;

        // Wire nodes:
        osc1.connect(exhaustFilter);
        osc2.connect(exhaustFilter);
        subOsc.connect(exhaustFilter);
        exhaustFilter.connect(airFilter);
        airFilter.connect(masterGain);
        masterGain.connect(demoPanner);
        demoPanner.connect(ctx.destination);

        // Pitch & Throttle Evolution (with Doppler pitch drop)
        osc1.frequency.setValueAtTime(54, startTime);
        osc1.frequency.exponentialRampToValueAtTime(82, startTime + 4.2);
        osc2.frequency.setValueAtTime(108, startTime);
        osc2.frequency.exponentialRampToValueAtTime(164, startTime + 4.2);
        subOsc.frequency.setValueAtTime(27, startTime);
        subOsc.frequency.exponentialRampToValueAtTime(41, startTime + 4.2);

        // Doppler pitch drop at flyby
        osc1.frequency.setValueAtTime(82, startTime + 4.3);
        osc1.frequency.exponentialRampToValueAtTime(50, startTime + 4.8);
        osc2.frequency.setValueAtTime(164, startTime + 4.3);
        osc2.frequency.exponentialRampToValueAtTime(100, startTime + 4.8);
        subOsc.frequency.setValueAtTime(41, startTime + 4.3);
        subOsc.frequency.exponentialRampToValueAtTime(25, startTime + 4.8);

        // Accelerate into distance
        osc1.frequency.exponentialRampToValueAtTime(42, startTime + duration);
        osc2.frequency.exponentialRampToValueAtTime(84, startTime + duration);
        subOsc.frequency.exponentialRampToValueAtTime(21, startTime + duration);

        // Volume Envelope
        masterGain.gain.setValueAtTime(0.01, startTime);
        masterGain.gain.exponentialRampToValueAtTime(0.4, startTime + 3.0);
        masterGain.gain.linearRampToValueAtTime(0.85, startTime + 4.4);
        masterGain.gain.setValueAtTime(0.85, startTime + 4.6);
        masterGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

        // Air Absorption Filter
        airFilter.frequency.setValueAtTime(900, startTime);
        airFilter.frequency.exponentialRampToValueAtTime(10000, startTime + 4.4);
        airFilter.frequency.exponentialRampToValueAtTime(700, startTime + duration);

        // Start Oscillators
        osc1.start(startTime);
        osc2.start(startTime);
        subOsc.start(startTime);
        osc1.stop(startTime + duration);
        osc2.stop(startTime + duration);
        subOsc.stop(startTime + duration);

        this.currentDemoNodes = {
            osc1,
            osc2,
            subOsc,
            exhaustFilter,
            airFilter,
            masterGain,
            demoPanner
        };

        // Real-Time 3D Trajectory Animation across 360° Space:
        const animStart = performance.now();
        const updatePanner = () => {
            if (!this.isDemoRunning) return;
            const elapsed = (performance.now() - animStart) / 1000.0;
            const progress = Math.min(1.0, elapsed / duration);

            let x, z;
            if (progress < 0.48) {
                const t = progress / 0.48;
                x = -22.0 + t * 20.5;
                z = -22.0 + t * 22.0;
            } else {
                const t = (progress - 0.48) / 0.52;
                x = -1.5 + t * 23.5;
                z = 0.0 + t * 25.0;
            }

            if (demoPanner.positionX) {
                demoPanner.positionX.setValueAtTime(x, ctx.currentTime);
                demoPanner.positionY.setValueAtTime(0, ctx.currentTime);
                demoPanner.positionZ.setValueAtTime(z, ctx.currentTime);
            } else if (typeof demoPanner.setPosition === 'function') {
                demoPanner.setPosition(x, 0, z);
            }

            // Update UI Radar Widget dynamically
            const rad = Math.atan2(x, -z);
            let deg = Math.round((rad * 180.0) / Math.PI);
            deg = ((deg % 360) + 360) % 360;
            const dist = Math.min(1.0, Math.sqrt(x * x + z * z) / 25.0);

            const radar = document.getElementById('spatial-radar');
            const puck = document.getElementById('spatial-puck');
            const lbl = document.getElementById('spatial-azimuth-label');
            if (radar && puck) {
                const radius = (radar.offsetWidth / 2) - 16;
                const px = Math.sin(rad) * dist * radius;
                const py = -Math.cos(rad) * dist * radius;
                puck.style.transform = `translate(${px}px, ${py}px)`;
            }
            if (lbl) {
                lbl.textContent = `3D DEMO: ${deg}° • ${Math.round(dist * 100)}% DIST`;
            }

            if (progress < 1.0) {
                this.demoAnimFrame = requestAnimationFrame(updatePanner);
            } else {
                this.stop3DMotorcycleDemo();
            }
        };

        this.demoAnimFrame = requestAnimationFrame(updatePanner);
    }

    stop3DMotorcycleDemo() {
        if (!this.isDemoRunning) return;
        this.isDemoRunning = false;
        if (this.demoAnimFrame) {
            cancelAnimationFrame(this.demoAnimFrame);
            this.demoAnimFrame = null;
        }

        if (this.currentDemoNodes) {
            try {
                this.currentDemoNodes.masterGain.gain.setValueAtTime(0, this.demoAudioCtx?.currentTime || 0);
                try { this.currentDemoNodes.osc1.stop(); } catch(e) {}
                try { this.currentDemoNodes.osc2.stop(); } catch(e) {}
                try { this.currentDemoNodes.subOsc.stop(); } catch(e) {}
                try { this.currentDemoNodes.osc1.disconnect(); } catch(e) {}
                try { this.currentDemoNodes.osc2.disconnect(); } catch(e) {}
                try { this.currentDemoNodes.subOsc.disconnect(); } catch(e) {}
                try { this.currentDemoNodes.exhaustFilter.disconnect(); } catch(e) {}
                try { this.currentDemoNodes.airFilter.disconnect(); } catch(e) {}
                try { this.currentDemoNodes.masterGain.disconnect(); } catch(e) {}
                try { this.currentDemoNodes.demoPanner.disconnect(); } catch(e) {}
            } catch(e) {}
            this.currentDemoNodes = null;
        }

        const demoBtn = document.getElementById('btn-spatial-demo');
        const demoText = document.getElementById('spatial-demo-text');
        const demoIcon = document.getElementById('spatial-demo-icon');
        if (demoBtn) demoBtn.classList.remove('demo-running');
        if (demoText) demoText.textContent = 'Play 3D Demo';
        if (demoIcon) demoIcon.setAttribute('data-lucide', 'play');
        if (window.lucide) lucide.createIcons();

        // Restore saved radar position
        this.updateSpatialRadarUI();

        // Restore music playback if was playing
        if (this.wasPlayingBeforeDemo) {
            this.wasPlayingBeforeDemo = false;
            if (Capacitor.isNativePlatform() && this.nativeInitialized) {
                NativeAudio.play({ audioId: 'main' }).then(() => this.syncUIState(true)).catch(() => {});
            } else if (this.audio && this.audio.src) {
                this.audio.play().then(() => this.syncUIState(true)).catch(() => {});
            }
        }
    }

    // Radar Touch / Pointer Interaction
    setupSpatialRadar() {
        const radar = document.getElementById('spatial-radar');
        if (!radar) return;

        let isInteracting = false;

        const updateFromPointer = (clientX, clientY) => {
            const rect = radar.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const dx = clientX - centerX;
            const dy = clientY - centerY;

            const rad = Math.atan2(dx, -dy);
            let deg = Math.round((rad * 180.0) / Math.PI);
            deg = ((deg % 360) + 360) % 360;

            const radius = rect.width / 2;
            const rawDist = Math.sqrt(dx * dx + dy * dy) / radius;
            const distPercent = Math.max(10, Math.min(100, Math.round(rawDist * 100)));

            if (this.autoOrbitInterval) {
                this.stopAutoOrbit();
            }

            document.querySelectorAll('.spatial-pos-btn').forEach(b => b.classList.remove('active'));

            this.setSpatialParams(null, null, distPercent, deg);
        };

        radar.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            isInteracting = true;
            try { radar.setPointerCapture(e.pointerId); } catch(err) {}
            updateFromPointer(e.clientX, e.clientY);
        });

        radar.addEventListener('pointermove', (e) => {
            if (!isInteracting) return;
            e.preventDefault();
            updateFromPointer(e.clientX, e.clientY);
        });

        const endPointer = (e) => {
            if (!isInteracting) return;
            isInteracting = false;
            try {
                if (radar.hasPointerCapture(e.pointerId)) {
                    radar.releasePointerCapture(e.pointerId);
                }
            } catch(err) {}
            this.saveSpatialSettings();
            if (Capacitor.isNativePlatform()) {
                this.applyNativeSpatialAudio();
            }
        };

        radar.addEventListener('pointerup', endPointer);
        radar.addEventListener('pointercancel', endPointer);
    }

    updateSpatialSlidersUI() {
        const sliderIntensity = document.getElementById('spatial-slider-intensity');
        const sliderWidth = document.getElementById('spatial-slider-width');
        const sliderDist = document.getElementById('spatial-slider-distance');

        const valIntensity = document.getElementById('spatial-val-intensity');
        const valWidth = document.getElementById('spatial-val-width');
        const valDist = document.getElementById('spatial-val-distance');

        if (sliderIntensity) sliderIntensity.value = this.spatialSettings.intensity;
        if (sliderWidth) sliderWidth.value = this.spatialSettings.width;
        if (sliderDist) sliderDist.value = this.spatialSettings.distance;

        if (valIntensity) valIntensity.textContent = `${this.spatialSettings.intensity}%`;
        if (valWidth) valWidth.textContent = `${this.spatialSettings.width}%`;
        if (valDist) valDist.textContent = `${this.spatialSettings.distance}%`;
    }

    updateSpatialRadarUI() {
        const radar = document.getElementById('spatial-radar');
        const puck = document.getElementById('spatial-puck');
        const label = document.getElementById('spatial-azimuth-label');

        if (radar && puck) {
            const rad = (this.spatialSettings.azimuth * Math.PI) / 180.0;
            const distRatio = Math.max(0.15, Math.min(1.0, this.spatialSettings.distance / 100.0));
            const maxRadius = (radar.offsetWidth / 2) - 16;

            const px = Math.sin(rad) * distRatio * maxRadius;
            const py = -Math.cos(rad) * distRatio * maxRadius;
            puck.style.transform = `translate(${px}px, ${py}px)`;
        }

        if (label) {
            let directionStr = 'FRONT';
            const az = this.spatialSettings.azimuth;
            if (az >= 337.5 || az < 22.5) directionStr = 'FRONT';
            else if (az >= 22.5 && az < 67.5) directionStr = 'FRONT-RIGHT';
            else if (az >= 67.5 && az < 112.5) directionStr = 'RIGHT';
            else if (az >= 112.5 && az < 157.5) directionStr = 'REAR-RIGHT';
            else if (az >= 157.5 && az < 202.5) directionStr = 'BACK';
            else if (az >= 202.5 && az < 247.5) directionStr = 'REAR-LEFT';
            else if (az >= 247.5 && az < 292.5) directionStr = 'LEFT';
            else if (az >= 292.5 && az < 337.5) directionStr = 'FRONT-LEFT';

            label.textContent = `${directionStr} ${az}° • ${this.spatialSettings.distance}% DISTANCE`;
        }
    }

    updateSpatialUI() {
        const toggle = document.getElementById('spatial-toggle-enabled');
        if (toggle) toggle.checked = this.spatialSettings.enabled;

        const radarCard = document.getElementById('spatial-radar-card');
        if (radarCard) {
            radarCard.classList.toggle('spatial-disabled', !this.spatialSettings.enabled);
        }

        const slidersContainer = document.getElementById('spatial-sliders-container');
        if (slidersContainer) {
            slidersContainer.classList.toggle('spatial-disabled', !this.spatialSettings.enabled);
        }

        const label = document.getElementById('spatial-status-label');
        if (label) {
            if (!this.spatialSettings.enabled) {
                label.textContent = '360° Spatial Audio Disabled (Stereo Bypass)';
            } else if (Capacitor.isNativePlatform()) {
                label.textContent = 'Native DSP: Headphone Virtualizer & Reverb';
            } else {
                label.textContent = 'Web Audio: HRTF 360° Positional Engine';
            }
        }
    }

    openSpatialDrawer() {
        const drawer = document.getElementById('drawer-spatial');
        if (drawer) {
            drawer.classList.add('active');
            this.updateSpatialSlidersUI();
            this.updateSpatialRadarUI();
            this.updateSpatialUI();
            if (Capacitor.isNativePlatform()) {
                NativeAudio.getSpatialAudioStatus({}).then(status => {
                    const label = document.getElementById('spatial-status-label');
                    if (label && this.spatialSettings.enabled && status) {
                        const virtStr = status.virtualizerSupported ? 'Headphone Virtualizer' : 'Spatializer';
                        const ctrlStr = status.virtualizerHasControl ? 'Hardware DSP Active' : 'Attached';
                        label.textContent = `Native DSP: ${virtStr} (${ctrlStr})`;
                    }
                }).catch(() => {});
            }
        }
    }

    closeSpatialDrawer() {
        if (this.isDemoRunning) {
            this.stop3DMotorcycleDemo();
        }
        const drawer = document.getElementById('drawer-spatial');
        if (drawer) {
            drawer.classList.remove('active');
        }
    }

    saveSpatialSettings() {
        try {
            localStorage.setItem('mpt_spatial_settings', JSON.stringify({
                enabled: this.spatialSettings.enabled,
                intensity: this.spatialSettings.intensity,
                width: this.spatialSettings.width,
                distance: this.spatialSettings.distance,
                azimuth: this.spatialSettings.azimuth
            }));
        } catch(e) {}
    }
}

window.player = new AudioPlayer();
