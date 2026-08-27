/**
 * js/ui.js
 * Handles DOM rendering and UI updates
 */

class UIManager {
    constructor() {
        this.pages = ['home', 'search', 'saved', 'favorites', 'recent', 'storage'];
    }

    showPage(pageId) {
        this.pages.forEach(p => {
            const el = document.getElementById(`page-${p}`);
            if (el) {
                if (p === pageId) {
                    el.classList.add('active');
                } else {
                    el.classList.remove('active');
                }
            }
        });

        // Update nav active state
        document.querySelectorAll('.nav-item').forEach(el => {
            if (el.getAttribute('data-page') === pageId) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });
        
        // Refresh specific page data if needed
        if (pageId === 'saved') window.app.loadSavedTracks();
        if (pageId === 'favorites') window.app.loadFavorites();
        if (pageId === 'downloads' && window.app.loadDownloads) window.app.loadDownloads();
        if (pageId === 'storage') window.app.updateStorageStats();
        
        // Scroll to top
        document.querySelector('.scroll-container').scrollTop = 0;
    }

    showNotification(message, type = 'info') {
        const container = document.getElementById('notification-container');
        if (!container) return;

        const notif = document.createElement('div');
        notif.className = 'notification';
        
        let icon = 'info';
        if (type === 'success') icon = 'check-circle';
        if (type === 'error' || type === 'warning') icon = 'alert-circle';
        
        notif.innerHTML = `
            <i data-lucide="${icon}"></i>
            <span>${message}</span>
        `;
        
        container.appendChild(notif);
        if (window.lucide) lucide.createIcons();
        
        setTimeout(() => {
            notif.classList.add('hiding');
            notif.addEventListener('animationend', () => notif.remove());
        }, 3000);
    }

    formatDuration(seconds) {
        const num = Number(seconds);
        if (!isFinite(num) || isNaN(num)) return '0:00';
        const m = Math.floor(num / 60);
        const s = Math.floor(num % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    async loadTrackMetadata(track, durationElement) {
        if (track.duration > 0) {
            if (durationElement) durationElement.textContent = this.formatDuration(track.duration);
            return;
        }

        try {
            const response = await fetch(window.getApiUrl(`/.netlify/functions/music-play?key=${encodeURIComponent(track.s3Key)}`));
            if (!response.ok) return;
            const data = await response.json();
            if (!data.url) return;

            const tempAudio = new Audio();
            tempAudio.preload = "metadata";
            
            tempAudio.addEventListener('loadedmetadata', () => {
                if (tempAudio.duration && isFinite(tempAudio.duration)) {
                    track.duration = tempAudio.duration;
                    if (durationElement) {
                        durationElement.textContent = this.formatDuration(track.duration);
                    }
                    if (window.app && window.app.updateCachedLibrary) {
                        window.app.updateCachedLibrary(track);
                    }
                }
                tempAudio.removeAttribute('src'); // Cleanup
            });
            tempAudio.src = data.url;
        } catch (e) {
            console.error("Metadata load error", e);
        }
    }

    async createTrackRow(track, queueList, index) {
        const isFav = window.storageManager.isFavorite(track.id);
        
        const row = document.createElement('div');
        row.className = 'track-row';
        row.dataset.id = track.id;
        
        const artworkHtml = track.thumbnail ? 
            `<img src="${track.thumbnail}" class="track-artwork" loading="lazy">` : 
            `<div class="track-artwork placeholder"><i data-lucide="music"></i></div>`;
            
        row.innerHTML = `
            ${artworkHtml}
            <div class="track-info">
                <div class="track-title">${track.title}</div>
                <div class="track-artist">${track.artist}</div>
            </div>
            <div class="track-actions">
                <button class="icon-btn action-fav ${isFav ? 'active' : ''}" title="Favorite" aria-label="Favorite">
                    <i data-lucide="heart" ${isFav ? 'fill="currentColor"' : ''}></i>
                </button>
                
                <button class="icon-btn action-download" title="Download" aria-label="Download">
                    <i data-lucide="download"></i>
                </button>
                
                <span class="track-duration">${this.formatDuration(track.duration)}</span>
                <button class="icon-btn action-play" aria-label="Play" data-video-id="${track.videoId || ''}">
                    <i data-lucide="play"></i>
                </button>
            </div>
        `;
        
        // Play action
        const playBtn = row.querySelector('.action-play');
        playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            console.log("[UI] PLAY TRACK");
            window.player.playTrack(track, queueList, index);
        });
        
        // Row click plays track
        row.addEventListener('click', () => {
            console.log("[UI] PLAY TRACK");
            window.player.playTrack(track, queueList, index);
        });
        
        // Favorite action
        const favBtn = row.querySelector('.action-fav');
        favBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const added = window.storageManager.toggleFavorite(track);
            favBtn.classList.toggle('active', added);
            const icon = favBtn.querySelector('i');
            if (added) icon.setAttribute('fill', 'currentColor');
            else icon.removeAttribute('fill');
        });
        
        const durationSpan = row.querySelector('.track-duration');
        if (!track.duration) {
            this.loadTrackMetadata(track, durationSpan);
        }
        
        const dlBtn = row.querySelector('.action-download');
        
        // Initial state
        if (window.OfflineManager) {
            window.OfflineManager.isDownloaded(track.id).then(isDl => {
                if (isDl) {
                    dlBtn.classList.add('active');
                    dlBtn.innerHTML = `<i data-lucide="check-circle" style="color: var(--primary-color)"></i>`;
                    if (window.lucide) lucide.createIcons({root: dlBtn});
                }
            });
            
            dlBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                
                const isDl = await window.OfflineManager.isDownloaded(track.id);
                
                if (isDl) {
                    // Delete
                    if (confirm('Remove from downloads?')) {
                        await window.OfflineManager.deleteTrack(track.id);
                        dlBtn.classList.remove('active');
                        dlBtn.innerHTML = `<i data-lucide="download"></i>`;
                        if (window.lucide) lucide.createIcons({root: dlBtn});
                        
                        // If we are on the downloads page, refresh
                        if (document.getElementById('page-downloads').classList.contains('active') && window.app.loadDownloads) {
                            window.app.loadDownloads();
                        }
                    }
                } else {
                    // Download
                    dlBtn.innerHTML = `<i data-lucide="loader" class="spin"></i>`;
                    if (window.lucide) lucide.createIcons({root: dlBtn});
                    
                    try {
                        await window.OfflineManager.downloadTrack(track);
                        dlBtn.classList.add('active');
                        dlBtn.innerHTML = `<i data-lucide="check-circle" style="color: var(--primary-color)"></i>`;
                        window.uiManager.showNotification('Song downloaded', 'success');
                    } catch (err) {
                        dlBtn.innerHTML = `<i data-lucide="download"></i>`;
                        window.uiManager.showNotification('Download failed: ' + err.message, 'error');
                    }
                    if (window.lucide) lucide.createIcons({root: dlBtn});
                }
            });
        }
        
        return row;
    }
    
    async renderTrackList(tracks, containerId, emptyMessage = "No tracks found.") {
        const container = document.getElementById(containerId);
        if (!container) return;
        
        container.innerHTML = '';
        
        if (!tracks || tracks.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i data-lucide="search" class="empty-icon"></i>
                    <p>${emptyMessage}</p>
                </div>
            `;
            if (window.lucide) lucide.createIcons();
            return;
        }
        
        for (let i = 0; i < tracks.length; i++) {
            const row = await this.createTrackRow(tracks[i], tracks, i);
            container.appendChild(row);
        }
        
        if (window.lucide) lucide.createIcons();
    }
    
    // Create card for grid (Home Page)
    createGridCard(track, queueList, index) {
        const card = document.createElement('div');
        card.className = 'track-card';
        
        const artworkHtml = track.thumbnail ? 
            `<img src="${track.thumbnail}" class="grid-artwork" loading="lazy">` : 
            `<div class="grid-artwork placeholder"><i data-lucide="music"></i></div>`;
            
        card.innerHTML = `
            ${artworkHtml}
            <div class="grid-details">
                <div class="grid-title">${track.title}</div>
                <div class="grid-artist">${track.artist}</div>
                <div class="grid-duration track-duration" style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 4px;">${this.formatDuration(track.duration)}</div>
            </div>
        `;
        
        card.addEventListener('click', () => {
            console.log("[UI] PLAY TRACK");
            if (window.player) {
                window.player.playTrack(track, queueList, index);
            }
        });
        
        const durationSpan = card.querySelector('.grid-duration');
        if (!track.duration) {
            this.loadTrackMetadata(track, durationSpan);
        }
        
        return card;
    }
    
    renderHorizontalGrid(tracks, containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = '';
        tracks.forEach((track, index) => {
            const card = this.createGridCard(track, tracks, index);
            container.appendChild(card);
        });

        if (window.lucide) lucide.createIcons();
    }
}

// Add simple spin animation CSS for loaders
document.head.insertAdjacentHTML('beforeend', `
<style>
@keyframes spin { 100% { transform: rotate(360deg); } }
.spin { animation: spin 2s linear infinite; }
</style>
`);

window.uiManager = new UIManager();
