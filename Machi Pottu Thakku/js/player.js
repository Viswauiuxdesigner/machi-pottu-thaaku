/**
 * js/player.js
 * Handles audio playback, queue, and UI synchronization using native HTML5 Audio
 */

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

        this.setupListeners();
        this.setupAudioEvents();
    }

    setupListeners() {
        // UI Controls
        document.getElementById('btn-play-pause').addEventListener('click', () => this.togglePlay());
        document.getElementById('btn-prev').addEventListener('click', () => this.playPrev());
        document.getElementById('btn-next').addEventListener('click', () => this.playNext());
        document.getElementById('btn-mute').addEventListener('click', () => this.toggleMute());
        
        // Progress Bar Seeking
        const progressContainer = document.getElementById('progress-container');
        progressContainer.addEventListener('click', (e) => {
            if (!this.audio || !this.audio.duration || isNaN(this.audio.duration)) return;
            const rect = progressContainer.getBoundingClientRect();
            const pos = (e.clientX - rect.left) / rect.width;
            this.audio.currentTime = pos * this.audio.duration;
        });
        
        // Volume Bar
        const volumeContainer = document.getElementById('volume-container');
        volumeContainer.addEventListener('click', (e) => {
            const rect = volumeContainer.getBoundingClientRect();
            const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            this.setVolume(pos);
        });
        
        // Set default volume
        this.setVolume(1);
    }

    setupAudioEvents() {
        this.audio.addEventListener('play', () => this.syncUIState(true));
        this.audio.addEventListener('pause', () => this.syncUIState(false));
        this.audio.addEventListener('ended', () => this.playNext());
        
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
    }

    syncUIState(isPlaying) {
        if (!this.currentTrack) return;
        
        const btnIcon = document.getElementById('btn-play-pause');
        if (btnIcon) {
            btnIcon.innerHTML = `<i data-lucide="${isPlaying ? 'pause' : 'play'}"></i>`;
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
        
        // Update Queue
        if (queueList.length > 0) {
            this.queue = queueList;
            this.queueIndex = index;
        } else if (this.queue.length === 0) {
            this.queue = [track];
            this.queueIndex = 0;
        }

        this.updateUI();
        
        try {
            console.log("[FILEBASE PLAYBACK] Requesting signed URL");
            const requestUrl = `/.netlify/functions/music-play?key=${encodeURIComponent(track.s3Key)}`;
            console.log(`[FILEBASE PLAYBACK] Request URL: ${requestUrl}`);
            
            const response = await fetch(requestUrl);
            if (!response.ok) {
                throw new Error("Failed to generate signed URL.");
            }
            const data = await response.json();
            
            if (data.error) throw new Error(data.error);
            if (!data.url) throw new Error("No URL returned from server.");
            
            console.log("[FILEBASE PLAYBACK] Signed URL generated");
            
            this.audio.src = data.url;
            console.log("[RUNTIME TRACE] audio.src immediately before play():", "Presigned URL (hidden)");
            
            this.audio.play().catch(err => {
                console.error("Autoplay prevented:", err);
            });
        } catch (error) {
            console.error("[FILEBASE PLAYBACK] Error fetching presigned URL:", error);
            window.uiManager.showNotification("Playback failed: " + error.message, "error");
            this.syncUIState(false);
        }
    }

    togglePlay() {
        if (!this.currentTrack || !this.audio.src) return;
        
        if (this.audio.paused) {
            this.audio.play();
        } else {
            this.audio.pause();
        }
    }

    playNext() {
        if (this.queueIndex >= 0 && this.queueIndex < this.queue.length - 1) {
            this.queueIndex++;
            this.playTrack(this.queue[this.queueIndex], this.queue, this.queueIndex);
        } else {
            this.audio.pause();
            this.audio.currentTime = 0;
        }
    }

    playPrev() {
        if (!this.audio) return;
        
        if (this.audio.currentTime > 3) {
            this.audio.currentTime = 0;
            this.audio.play();
        } else if (this.queueIndex > 0) {
            this.queueIndex--;
            this.playTrack(this.queue[this.queueIndex], this.queue, this.queueIndex);
        }
    }

    setVolume(level) {
        if (this.audio) {
            this.audio.volume = level;
        }
        
        document.getElementById('volume-bar').style.width = `${level * 100}%`;
        
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
            document.getElementById('progress-bar').style.width = `${percent}%`;
            document.getElementById('time-current').textContent = this.formatTime(current);
            document.getElementById('time-total').textContent = this.formatTime(total);
        }
    }
    
    updateDuration(total) {
        if (total > 0 && isFinite(total) && !isNaN(total)) {
            document.getElementById('time-total').textContent = this.formatTime(total);
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
        document.getElementById('player-title').textContent = track.title;
        document.getElementById('player-artist').textContent = track.artist;
        
        const artworkContainer = document.getElementById('player-artwork');
        if (track.thumbnail) {
            artworkContainer.innerHTML = `<img src="${track.thumbnail}" alt="Artwork">`;
        } else {
            artworkContainer.innerHTML = `<i data-lucide="music"></i>`;
            if (window.lucide) lucide.createIcons();
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
        
        // Reset progress visually
        document.getElementById('progress-bar').style.width = `0%`;
        document.getElementById('time-current').textContent = "0:00";
    }
}

window.player = new AudioPlayer();
