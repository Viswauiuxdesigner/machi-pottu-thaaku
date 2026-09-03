/**
 * js/machi-guess.js
 * Machi Guess (Guess Artist Mode) - APK-Ready Isolated Mini-Game Engine
 */

import { Capacitor } from '@capacitor/core';

class MachiGuessEngine {
    constructor() {
        this.score = 0;
        this.currentTrack = null;
        this.correctArtist = '';
        this.usedSessionTrackIds = new Set();
        this.previewAudio = new Audio();
        this.previewTimer = null;
        this.isPlayingPreview = false;
        this.historyKey = 'mpt_mg_recent_history';
        
        this.initListeners();
    }

    initListeners() {
        try {
            window.addEventListener('beforeunload', () => this.stopPreview());
            window.addEventListener('pagehide', () => this.stopPreview());
        } catch(e) {
            console.error("[MACHI GUESS] Error initializing listeners:", e);
        }
    }

    getRecentHistory() {
        try {
            const data = localStorage.getItem(this.historyKey);
            return data ? JSON.parse(data) : [];
        } catch(e) {
            return [];
        }
    }

    saveRecentHistory(trackId) {
        if (!trackId) return;
        try {
            let history = this.getRecentHistory();
            if (!history.includes(trackId)) {
                history.push(trackId);
            }
            if (history.length > 20) {
                history = history.slice(-20);
            }
            localStorage.setItem(this.historyKey, JSON.stringify(history));
        } catch(e) {}
    }

    async waitForLibrary(maxRetries = 6, intervalMs = 500) {
        for (let i = 0; i < maxRetries; i++) {
            if (window.app && Array.isArray(window.app.musicLibrary) && window.app.musicLibrary.length > 0) {
                return true;
            }
            if (window.OfflineManager && window.OfflineManager.getOfflineTracks().length > 0) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
        return (window.app && Array.isArray(window.app.musicLibrary) && window.app.musicLibrary.length > 0);
    }

    async getEligibleTracks() {
        let tracks = [];

        if (window.app && Array.isArray(window.app.musicLibrary) && window.app.musicLibrary.length > 0) {
            tracks = window.app.musicLibrary;
        } else if (window.OfflineManager) {
            tracks = window.OfflineManager.getOfflineTracks();
        }

        return tracks.filter(t => {
            if (!t || typeof t !== 'object') return false;
            const hasId = t.id || t.s3Key;
            const hasArtist = t.artist && typeof t.artist === 'string' && t.artist.trim() !== '';
            const hasTitle = t.title && typeof t.title === 'string' && t.title.trim() !== '';
            const hasSource = t.s3Key || t.localPath || t.nativeUrl || t.webViewUrl;
            return Boolean(hasId && hasArtist && hasTitle && hasSource);
        });
    }

    extractUniqueArtists(tracks) {
        const artistSet = new Set();
        tracks.forEach(t => {
            if (t && t.artist && typeof t.artist === 'string') {
                const trimmed = t.artist.trim();
                if (trimmed) artistSet.add(trimmed);
            }
        });
        return Array.from(artistSet);
    }

    async openGame() {
        try {
            this.score = 0;
            this.usedSessionTrackIds.clear();
            this.updateScoreDisplay();
            
            const overlay = document.getElementById('page-machi-guess');
            if (overlay) {
                overlay.classList.add('active');
            }

            const promptEl = document.getElementById('mg-prompt');
            const emptyState = document.getElementById('mg-empty-state');
            const gameContent = document.getElementById('mg-game-content');

            let ready = (window.app && Array.isArray(window.app.musicLibrary) && window.app.musicLibrary.length > 0) ||
                        (window.OfflineManager && window.OfflineManager.getOfflineTracks().length > 0);

            if (!ready) {
                if (promptEl) promptEl.textContent = "Music library is loading...";
                ready = await this.waitForLibrary(6, 500);
            }

            if (!ready) {
                const eligible = await this.getEligibleTracks();
                if (eligible.length === 0) {
                    if (emptyState) {
                        emptyState.style.display = 'block';
                        emptyState.innerHTML = `
                            <p style="margin-bottom:12px;">Music library is unavailable.</p>
                            <button class="btn btn-primary" style="padding: 8px 20px; border-radius: 20px; font-size: 13px;" onclick="window.machiGuess.openGame()">TRY AGAIN</button>
                        `;
                    }
                    if (gameContent) gameContent.style.display = 'none';
                    return;
                }
            }

            await this.startRound();
        } catch (e) {
            console.error("[MACHI GUESS] Error opening game:", e);
        }
    }

    closeGame() {
        try {
            this.stopPreview();
            const overlay = document.getElementById('page-machi-guess');
            if (overlay) {
                overlay.classList.remove('active');
            }
        } catch (e) {
            console.error("[MACHI GUESS] Error closing game:", e);
        }
    }

    updateScoreDisplay() {
        const el = document.getElementById('mg-score-val');
        if (el) el.textContent = this.score;
    }

    async startRound() {
        try {
            this.stopPreview();

            const choicesContainer = document.getElementById('mg-choices-container');
            const promptEl = document.getElementById('mg-prompt');
            const resultEl = document.getElementById('mg-result');
            const btnNext = document.getElementById('mg-btn-next');
            const emptyState = document.getElementById('mg-empty-state');
            const gameContent = document.getElementById('mg-game-content');
            const artworkEl = document.getElementById('mg-artwork');

            if (resultEl) resultEl.style.display = 'none';
            if (btnNext) btnNext.style.display = 'none';

            const tracks = await this.getEligibleTracks();
            const uniqueArtists = this.extractUniqueArtists(tracks);

            if (tracks.length === 0 || uniqueArtists.length < 4) {
                if (emptyState) {
                    emptyState.style.display = 'block';
                    const isOnline = navigator.onLine;
                    const msg = (isOnline && window.app && Array.isArray(window.app.musicLibrary) && window.app.musicLibrary.length > 0)
                        ? "Not enough artists to start MACHI GUESS." 
                        : "Download a few more songs to play MACHI GUESS offline.";
                    emptyState.innerHTML = `<p>${msg}</p>`;
                }
                if (gameContent) gameContent.style.display = 'none';
                return;
            }

            if (emptyState) emptyState.style.display = 'none';
            if (gameContent) gameContent.style.display = 'flex';

            // Select candidate track
            const recentHistory = this.getRecentHistory();
            let eligibleCandidates = tracks.filter(t => 
                !this.usedSessionTrackIds.has(t.id || t.s3Key) && !recentHistory.includes(t.id || t.s3Key)
            );

            if (eligibleCandidates.length === 0) {
                eligibleCandidates = tracks.filter(t => !this.usedSessionTrackIds.has(t.id || t.s3Key));
            }

            if (eligibleCandidates.length === 0) {
                this.usedSessionTrackIds.clear();
                eligibleCandidates = tracks;
            }

            const selectedTrack = eligibleCandidates[Math.floor(Math.random() * eligibleCandidates.length)];
            const trackKey = selectedTrack.id || selectedTrack.s3Key;
            
            this.currentTrack = selectedTrack;
            this.correctArtist = selectedTrack.artist.trim();
            this.usedSessionTrackIds.add(trackKey);
            this.saveRecentHistory(trackKey);

            // Update Artwork
            if (artworkEl) {
                if (selectedTrack.thumbnail) {
                    artworkEl.innerHTML = `<img src="${selectedTrack.thumbnail}" alt="Artwork" style="width:100%;height:100%;object-fit:cover;border-radius:16px;">`;
                } else {
                    artworkEl.innerHTML = `<i data-lucide="headphones" style="width: 64px; height: 64px; color: var(--accent-color);"></i>`;
                    if (window.lucide) lucide.createIcons();
                }
            }

            if (promptEl) promptEl.textContent = `Song: "${selectedTrack.title}" — Listen carefully...`;

            // Generate 4 choices
            const wrongArtists = uniqueArtists.filter(a => a.toLowerCase() !== this.correctArtist.toLowerCase());
            
            const shuffledWrong = wrongArtists.sort(() => 0.5 - Math.random()).slice(0, 3);
            const allChoices = [this.correctArtist, ...shuffledWrong].sort(() => 0.5 - Math.random());

            // Render choice buttons
            if (choicesContainer) {
                choicesContainer.innerHTML = '';
                allChoices.forEach(artistName => {
                    const btn = document.createElement('button');
                    btn.className = 'mg-choice-btn';
                    btn.textContent = artistName;
                    btn.addEventListener('click', () => this.handleChoice(artistName, btn));
                    choicesContainer.appendChild(btn);
                });
            }

            // Start isolated audio preview
            this.playPreview(selectedTrack);

        } catch (e) {
            console.error("[MACHI GUESS] Error in startRound:", e);
        }
    }

    async playPreview(track) {
        this.stopPreview();

        let previewUrl = null;

        try {
            // 1. Check local download first
            if (window.OfflineManager && track.id) {
                const isDl = await window.OfflineManager.isDownloaded(track.id);
                if (isDl) {
                    const localUrls = await window.OfflineManager.getLocalUrls(track.id);
                    if (localUrls) {
                        previewUrl = Capacitor.isNativePlatform() ? localUrls.nativeUrl : localUrls.webViewUrl;
                    }
                }
            }

            // 2. Fetch presigned URL if online and no local file
            if (!previewUrl && navigator.onLine && track.s3Key) {
                try {
                    const res = await fetch(window.getApiUrl(`/.netlify/functions/music-play?key=${encodeURIComponent(track.s3Key)}`));
                    if (res.ok) {
                        const data = await res.json();
                        if (data.url) previewUrl = data.url;
                    }
                } catch(netErr) {
                    console.warn("[MACHI GUESS] Failed to fetch presigned URL for preview:", netErr);
                }
            }

            if (!previewUrl) {
                console.warn("[MACHI GUESS] Could not resolve preview URL for track:", track.title);
                const promptEl = document.getElementById('mg-prompt');
                if (promptEl) promptEl.textContent = `Song: "${track.title}" — Couldn't play audio preview.`;
                return;
            }

            this.previewAudio.onerror = () => {
                console.warn("[MACHI GUESS] Preview audio playback error");
                const promptEl = document.getElementById('mg-prompt');
                if (promptEl) promptEl.textContent = `Song: "${track.title}" — Couldn't play audio preview.`;
            };

            this.previewAudio.src = previewUrl;
            this.previewAudio.currentTime = 0;
            this.isPlayingPreview = true;

            const playPromise = this.previewAudio.play();
            if (playPromise !== undefined) {
                playPromise.catch(err => {
                    console.warn("[MACHI GUESS] Autoplay prevented or preview error:", err);
                });
            }

            // Stop preview after 7 seconds
            this.previewTimer = setTimeout(() => {
                this.stopPreview();
                const promptEl = document.getElementById('mg-prompt');
                if (promptEl && this.currentTrack) {
                    promptEl.textContent = `Song: "${this.currentTrack.title}" — Who is the artist?`;
                }
            }, 7000);

        } catch (e) {
            console.error("[MACHI GUESS] Error starting preview:", e);
        }
    }

    stopPreview() {
        if (this.previewTimer) {
            clearTimeout(this.previewTimer);
            this.previewTimer = null;
        }
        if (this.previewAudio) {
            try {
                this.previewAudio.onerror = null;
                this.previewAudio.pause();
                this.previewAudio.removeAttribute('src');
                this.previewAudio.load();
            } catch(e) {}
        }
        this.isPlayingPreview = false;
    }

    handleChoice(selectedArtist, selectedBtn) {
        try {
            this.stopPreview();

            const isCorrect = selectedArtist.toLowerCase() === this.correctArtist.toLowerCase();
            const choicesContainer = document.getElementById('mg-choices-container');
            const resultEl = document.getElementById('mg-result');
            const btnNext = document.getElementById('mg-btn-next');

            if (choicesContainer) {
                const buttons = choicesContainer.querySelectorAll('.mg-choice-btn');
                buttons.forEach(btn => {
                    btn.disabled = true;
                    if (btn.textContent.trim().toLowerCase() === this.correctArtist.toLowerCase()) {
                        btn.classList.add('correct');
                    } else if (btn === selectedBtn && !isCorrect) {
                        btn.classList.add('wrong');
                    }
                });
            }

            if (isCorrect) {
                this.score += 10;
                this.updateScoreDisplay();
                if (resultEl) {
                    resultEl.style.display = 'block';
                    resultEl.className = 'mg-result success';
                    resultEl.innerHTML = `🔥 Correct! Artist: <strong>${this.correctArtist}</strong>`;
                }
            } else {
                if (resultEl) {
                    resultEl.style.display = 'block';
                    resultEl.className = 'mg-result failure';
                    resultEl.innerHTML = `😏 Not quite! Correct artist: <strong>${this.correctArtist}</strong>`;
                }
            }

            if (btnNext) {
                btnNext.style.display = 'inline-flex';
            }
        } catch (e) {
            console.error("[MACHI GUESS] Error handling choice:", e);
        }
    }
}

window.machiGuess = new MachiGuessEngine();
