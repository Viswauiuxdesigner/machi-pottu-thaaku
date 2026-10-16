/**
 * js/ui.js
 * Handles DOM rendering and UI updates
 */

class UIManager {
    constructor() {
        this.pages = ['home', 'search', 'saved', 'favorites', 'recent', 'downloads', 'storage'];
        this.currentPage = 'home';
        this.previousPage = 'home';
        this.pageHistory = ['home'];
        this.selectedMenuTrack = null;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.setupTrackMenuListeners());
        } else {
            this.setupTrackMenuListeners();
        }
    }

    showPage(pageId, isBack = false) {
        if (!isBack && this.currentPage !== pageId) {
            this.previousPage = this.currentPage;
            this.pageHistory.push(pageId);
        }
        this.currentPage = pageId;

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

        // Hide top app-header search icon while Downloads page is active
        const topSearchBtn = document.getElementById('top-header-search-btn');
        if (topSearchBtn) {
            topSearchBtn.style.display = (pageId === 'downloads') ? 'none' : '';
        }

        // Refresh specific page data if needed
        if (pageId === 'saved') window.app.loadSavedTracks();
        if (pageId === 'favorites') window.app.loadFavorites();
        if (pageId === 'downloads' && window.app.loadDownloads) window.app.loadDownloads();
        if (pageId === 'storage') window.app.updateStorageStats();

        // Scroll to top
        const scrollContainer = document.querySelector('.scroll-container');
        if (scrollContainer) scrollContainer.scrollTop = 0;
    }

    navigateBack() {
        // 1. Close downloads sort menu if open
        const sortMenu = document.getElementById('downloads-sort-menu');
        if (sortMenu && (sortMenu.style.display === 'flex' || sortMenu.style.display === 'block')) {
            sortMenu.style.display = 'none';
            return true;
        }

        // 2. Close Machi Guess overlay if active
        const mgOverlay = document.getElementById('page-machi-guess');
        if (mgOverlay && mgOverlay.classList.contains('active')) {
            if (window.machiGuess && typeof window.machiGuess.closeGame === 'function') {
                window.machiGuess.closeGame();
            } else {
                mgOverlay.classList.remove('active');
            }
            return true;
        }

        // 3. Close Now Playing overlay if active (playback continues uninterrupted)
        const npOverlay = document.getElementById('page-now-playing');
        if (npOverlay && npOverlay.classList.contains('active')) {
            npOverlay.classList.remove('active');
            return true;
        }

        // 4. Pop internal page history if available
        if (this.pageHistory.length > 1) {
            if (this.pageHistory[this.pageHistory.length - 1] === this.currentPage) {
                this.pageHistory.pop();
            }
            const targetPage = this.pageHistory[this.pageHistory.length - 1] || 'home';
            this.showPage(targetPage, true);
            return true;
        }

        // 5. If on another page without history, return to home
        if (this.currentPage !== 'home') {
            this.pageHistory = ['home'];
            this.showPage('home', true);
            return true;
        }

        // At root home with no history/overlay
        return false;
    }

    goBackFromDownloads() {
        this.navigateBack();
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
        if (!track || !durationElement) {
            return;
        }

        if (track.duration && isFinite(track.duration) && track.duration > 0) {
            durationElement.textContent = this.formatDuration(track.duration);
            return;
        }

        // Check if offline manager has duration cached for this track
        if (window.OfflineManager) {
            const local = window.OfflineManager.getLocalTrack(track.id) || (track.s3Key && window.OfflineManager.getLocalTrack(track.s3Key));
            if (local && local.duration && isFinite(local.duration) && local.duration > 0) {
                track.duration = local.duration;
                durationElement.textContent = this.formatDuration(track.duration);
                if (window.app && window.app.updateCachedLibrary) {
                    window.app.updateCachedLibrary(track);
                }
                return;
            }
        }

        durationElement.textContent = '--:--';
    }

    async createTrackRow(track, queueList, index, isDownloadsView = false) {
        const isFav = window.storageManager.isFavorite(track.id);
        const lastPlayedId = window.player ? window.player.getLastPlayedTrackId() : (localStorage.getItem('mpt_last_played_track') || null);

        const row = document.createElement('div');
        row.className = 'track-row' + (lastPlayedId && track.id === lastPlayedId ? ' last-played-highlight' : '');
        row.dataset.id = track.id;

        const artworkUrl = (typeof window.getReliableArtwork === 'function')
            ? window.getReliableArtwork(track)
            : (track.thumbnail || '/assets/covers/default.svg');
        const artworkHtml = `<img src="${artworkUrl}" class="track-artwork" loading="lazy" onerror="this.src='/assets/covers/default.svg';">`;

        let actionsHtml = '';
        if (isDownloadsView) {
            actionsHtml = `
                <span class="track-duration">${this.formatDuration(track.duration)}</span>
                <button class="icon-btn action-play" aria-label="Play" data-video-id="${track.videoId || ''}">
                    <i data-lucide="play"></i>
                </button>
                <button class="icon-btn action-delete-dl" title="Delete Download" aria-label="Delete Download" style="color: var(--primary-color);">
                    <i data-lucide="trash-2"></i>
                </button>
                <button class="icon-btn action-more" title="More options" aria-label="More options">
                    <i data-lucide="more-vertical"></i>
                </button>
            `;
        } else {
            actionsHtml = `
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
                <button class="icon-btn action-more" title="More options" aria-label="More options">
                    <i data-lucide="more-vertical"></i>
                </button>
            `;
        }

        row.innerHTML = `
            ${artworkHtml}
            <div class="track-info">
                <div class="track-title">${track.title}</div>
                <div class="track-artist">${track.artist}</div>
            </div>
            <div class="track-actions">
                ${actionsHtml}
            </div>
        `;

        // Play action
        const playBtn = row.querySelector('.action-play');
        playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            console.log("[UI] PLAY TRACK");
            const trackToPlay = isDownloadsView ? { ...track, _fromDownloads: true } : track;
            const queueToPlay = isDownloadsView ? queueList.map(t => ({ ...t, _fromDownloads: true })) : queueList;
            window.player.playTrack(trackToPlay, queueToPlay, index);
        });

        // Row click plays track
        row.addEventListener('click', () => {
            console.log("[UI] PLAY TRACK");
            const trackToPlay = isDownloadsView ? { ...track, _fromDownloads: true } : track;
            const queueToPlay = isDownloadsView ? queueList.map(t => ({ ...t, _fromDownloads: true })) : queueList;
            window.player.playTrack(trackToPlay, queueToPlay, index);
        });

        const favBtn = row.querySelector('.action-fav');
        if (favBtn) {
            favBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const added = window.storageManager.toggleFavorite(track);
                favBtn.classList.toggle('active', added);
                const icon = favBtn.querySelector('i');
                if (added) icon.setAttribute('fill', 'currentColor');
                else icon.removeAttribute('fill');
            });
        }

        const durationSpan = row.querySelector('.track-duration');
        if (!track.duration) {
            this.loadTrackMetadata(track, durationSpan);
        }

        if (isDownloadsView) {
            const delBtn = row.querySelector('.action-delete-dl');
            if (delBtn && window.OfflineManager) {
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (confirm('Delete this download?')) {
                        await window.OfflineManager.deleteTrack(track.id);
                        if (window.app && window.app.loadDownloads) {
                            window.app.loadDownloads();
                        }
                    }
                });
            }
        } else {
            const dlBtn = row.querySelector('.action-download');

            // Initial state
            if (dlBtn && window.OfflineManager) {
                window.OfflineManager.isDownloaded(track.id).then(isDl => {
                    if (isDl) {
                        dlBtn.classList.add('active');
                        dlBtn.innerHTML = `<i data-lucide="check-circle" style="color: var(--accent-color)"></i>`;
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
                            if (document.getElementById('page-downloads').classList.contains('active') && window.app && window.app.loadDownloads) {
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
                            dlBtn.innerHTML = `<i data-lucide="check-circle" style="color: var(--accent-color)"></i>`;
                            window.uiManager.showNotification('Song downloaded', 'success');

                            if (document.getElementById('page-downloads')?.classList.contains('active') && window.app && window.app.loadDownloads) {
                                window.app.loadDownloads();
                            }
                        } catch (err) {
                            dlBtn.innerHTML = `<i data-lucide="download"></i>`;
                            window.uiManager.showNotification('Download failed: ' + err.message, 'error');
                        }
                        if (window.lucide) lucide.createIcons({root: dlBtn});
                    }
                });
            }
        }

        const moreBtn = row.querySelector('.action-more');
        if (moreBtn) {
            moreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openTrackMenu(track);
            });
        }

        return row;
    }

    async renderTrackList(tracks, containerId, emptyMessage = "No tracks found.") {
        const isDownloadsView = (containerId === 'downloads-results');
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
            const row = await this.createTrackRow(tracks[i], tracks, i, isDownloadsView);
            container.appendChild(row);
        }

        if (window.lucide) lucide.createIcons();
    }

    // Create card for grid (Home Page)
    createGridCard(track, queueList, index) {
        const lastPlayedId = window.player ? window.player.getLastPlayedTrackId() : (localStorage.getItem('mpt_last_played_track') || null);

        const card = document.createElement('div');
        card.className = 'track-card' + (lastPlayedId && track.id === lastPlayedId ? ' last-played-highlight' : '');
        card.dataset.id = track.id;

        const artworkUrl = (typeof window.getReliableArtwork === 'function')
            ? window.getReliableArtwork(track)
            : (track.thumbnail || '/assets/covers/default.svg');
        const artworkHtml = `<img src="${artworkUrl}" class="grid-artwork" loading="lazy" onerror="this.src='/assets/covers/default.svg';">`;

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

    openTrackMenu(track) {
        this.selectedMenuTrack = track;
        const modal = document.getElementById('modal-track-menu');
        const titleEl = document.getElementById('context-menu-title');
        const artistEl = document.getElementById('context-menu-artist');
        const artworkEl = document.getElementById('context-menu-artwork');
        const favLabel = document.getElementById('ctx-fav-label');
        const dlLabel = document.getElementById('ctx-dl-label');

        if (!modal) return;

        if (titleEl) titleEl.textContent = track.title || 'Unknown Track';
        if (artistEl) artistEl.textContent = track.artist || '-';
        if (artworkEl) {
            const art = (typeof window.getReliableArtwork === 'function')
                ? window.getReliableArtwork(track)
                : (track.thumbnail || '/assets/covers/default.svg');
            artworkEl.src = art;
        }

        const isFav = window.storageManager?.isFavorite(track.id);
        if (favLabel) favLabel.textContent = isFav ? 'Remove Favorite' : 'Add to Favorites';

        modal.style.display = 'block';
        if (window.lucide) lucide.createIcons({ root: modal });
    }

    closeTrackMenu() {
        const modal = document.getElementById('modal-track-menu');
        if (modal) modal.style.display = 'none';
        this.selectedMenuTrack = null;
    }

    setupTrackMenuListeners() {
        const playNextBtn = document.getElementById('ctx-play-next');
        if (playNextBtn) {
            playNextBtn.addEventListener('click', () => {
                if (this.selectedMenuTrack && window.player) {
                    window.player.playNextTrack(this.selectedMenuTrack);
                }
                this.closeTrackMenu();
            });
        }

        const addQueueBtn = document.getElementById('ctx-add-queue');
        if (addQueueBtn) {
            addQueueBtn.addEventListener('click', () => {
                if (this.selectedMenuTrack && window.player) {
                    window.player.addToQueue(this.selectedMenuTrack);
                }
                this.closeTrackMenu();
            });
        }

        const favBtn = document.getElementById('ctx-favorite');
        if (favBtn) {
            favBtn.addEventListener('click', () => {
                if (this.selectedMenuTrack && window.storageManager) {
                    const added = window.storageManager.toggleFavorite(this.selectedMenuTrack);
                    window.uiManager.showNotification(added ? "Added to Favorites" : "Removed from Favorites", "success");
                    if (document.getElementById('page-favorites')?.classList.contains('active') && window.app?.loadFavorites) {
                        window.app.loadFavorites();
                    }
                }
                this.closeTrackMenu();
            });
        }

        const dlBtn = document.getElementById('ctx-download');
        if (dlBtn) {
            dlBtn.addEventListener('click', async () => {
                if (this.selectedMenuTrack && window.OfflineManager) {
                    try {
                        await window.OfflineManager.downloadTrack(this.selectedMenuTrack);
                        window.uiManager.showNotification(`Downloaded ${this.selectedMenuTrack.title}`, 'success');
                    } catch (e) {
                        window.uiManager.showNotification(`Download error: ${e.message}`, 'error');
                    }
                }
                this.closeTrackMenu();
            });
        }
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
