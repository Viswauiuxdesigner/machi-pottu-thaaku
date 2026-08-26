/**
 * js/app.js
 * Main application initialization and routing
 */

class App {
    constructor() {
        console.log("[RUNTIME] Local Music Library version loaded");
        
        this.currentSearchQuery = '';
        this.currentSearchResults = [];
        this.musicLibrary = [];
        this.init();
    }

    async init() {
        // Initialize Icons
        if (window.lucide) lucide.createIcons();

        // Register Service Worker
        if ('serviceWorker' in navigator) {
            try {
                await navigator.serviceWorker.register('/service-worker.js');
                console.log('[SW] Service Worker Registered');
            } catch (e) {
                console.error('[SW] Service Worker Registration Failed', e);
            }
        }

        // Clear local storage for old youtube home data
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('mpt_home_yt_v1_')) {
                localStorage.removeItem(key);
            }
        }

        // Fetch music library
        await this.loadMusicLibrary();

        // Setup Navigation Listeners
        document.querySelectorAll('.nav-item').forEach(el => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                const pageId = el.getAttribute('data-page');
                window.uiManager.showPage(pageId);
            });
        });
        
        // Dynamic Greeting
        this.updateGreeting();
        
        // Explore Button
        document.getElementById('btn-explore').addEventListener('click', () => {
            window.uiManager.showPage('search');
            document.getElementById('search-input').focus();
        });

        // Setup Search
        this.setupSearch();
        
        // Setup Network Listeners
        window.addEventListener('online', () => this.updateNetworkStatus(true));
        window.addEventListener('offline', () => this.updateNetworkStatus(false));
        this.updateNetworkStatus(navigator.onLine);
        
        // Setup Load More Button (Hidden for local library as search is instant/unlimited)
        const btnLoadMoreContainer = document.getElementById('load-more-container');
        if (btnLoadMoreContainer) {
            btnLoadMoreContainer.style.display = 'none';
        }
        
        // Setup Refresh Button
        const btnRefresh = document.getElementById('btn-refresh-library');
        if (btnRefresh) {
            btnRefresh.addEventListener('click', async () => {
                const icon = btnRefresh.querySelector('i');
                if (icon) icon.classList.add('spin');
                await this.loadMusicLibrary(true); // force refresh
                if (icon) icon.classList.remove('spin');
                this.loadHomeData(); // Re-render
                if (this.currentSearchQuery) {
                    this.performSearch(this.currentSearchQuery);
                }
            });
        }
        
        // Load initial data
        this.loadHomeData();
    }

    async loadMusicLibrary(forceRefresh = false) {
        console.log("[FILEBASE LIBRARY] Loading library");
        try {
            if (!forceRefresh) {
                const cachedStr = sessionStorage.getItem('mpt_filebase_library');
                if (cachedStr) {
                    const cachedData = JSON.parse(cachedStr);
                    // Ensure the cache is not older than 1 hour AND contains the new s3Key property
                    if (cachedData && cachedData.songs && cachedData.songs.length > 0 && cachedData.songs[0].s3Key && Date.now() - cachedData.timestamp < 3600000) {
                        this.musicLibrary = cachedData.songs;
                        console.log("[FILEBASE LIBRARY] Loaded from local cache");
                        console.log(`[FILEBASE LIBRARY] Objects found: ${this.musicLibrary.length}`);
                        console.log(`[FILEBASE LIBRARY] Audio files: ${this.musicLibrary.length}`);
                        console.log("[FILEBASE LIBRARY] Library ready");
                        return;
                    }
                }
            }

            const response = await fetch('/.netlify/functions/music-library');
            if (!response.ok) throw new Error('Failed to load music library from serverless function');
            const data = await response.json();
            
            if (data.error) throw new Error(data.error);

            this.musicLibrary = data.songs || [];
            
            // Cache it
            sessionStorage.setItem('mpt_filebase_library', JSON.stringify({
                timestamp: Date.now(),
                songs: this.musicLibrary
            }));
            
            console.log(`[FILEBASE LIBRARY] Objects found: ${this.musicLibrary.length}`);
            console.log(`[FILEBASE LIBRARY] Audio files: ${this.musicLibrary.length}`);
            console.log("[FILEBASE LIBRARY] Library ready");
        } catch (error) {
            console.error('[FILEBASE LIBRARY] Error loading music library:', error);
            window.uiManager.showNotification("Failed to load music library. Backend credentials might be missing.", "error");
        }
    }

    updateCachedLibrary(updatedTrack) {
        const index = this.musicLibrary.findIndex(t => t.id === updatedTrack.id);
        if (index !== -1) {
            this.musicLibrary[index] = updatedTrack;
            sessionStorage.setItem('mpt_filebase_library', JSON.stringify({
                timestamp: Date.now(),
                songs: this.musicLibrary
            }));
        }
    }

    updateGreeting() {
        const hour = new Date().getHours();
        let greeting = "Good evening";
        
        if (hour >= 5 && hour < 12) {
            greeting = "Good morning";
        } else if (hour >= 12 && hour < 17) {
            greeting = "Good afternoon";
        } else if (hour >= 17 && hour < 21) {
            greeting = "Good evening";
        } else {
            greeting = "Good night";
        }
        
        const greetingEl = document.getElementById('header-greeting');
        if (greetingEl) {
            greetingEl.textContent = `${greeting}, Machi 👋`;
        }
    }
    
    updateNetworkStatus(isOnline) {
        const el = document.getElementById('network-status');
        if (!el) return;
        
        if (isOnline) {
            el.className = 'network-status online';
            el.innerHTML = '<span class="status-dot"></span> <span class="status-text">Online</span>';
        } else {
            el.className = 'network-status offline';
            el.innerHTML = '<span class="status-dot" style="background-color: #f44336; box-shadow: 0 0 8px rgba(244, 67, 54, 0.5);"></span> <span class="status-text">Offline</span>';
        }
    }

    setupSearch() {
        const searchInput = document.getElementById('search-input');
        
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            
            if (!query) {
                document.getElementById('search-results').innerHTML = `
                    <div class="empty-state">
                        <i data-lucide="search" class="empty-icon"></i>
                        <p>Search for Tamil songs, artists...</p>
                    </div>
                `;
                if (window.lucide) lucide.createIcons();
                return;
            }
            
            this.performSearch(query);
        });

        // Setup Search Chips
        document.querySelectorAll('.search-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                const query = e.target.textContent;
                searchInput.value = query;
                searchInput.dispatchEvent(new Event('input'));
                
                // Highlight active chip
                document.querySelectorAll('.search-chip').forEach(c => c.classList.remove('active'));
                e.target.classList.add('active');
            });
        });
    }

    performSearch(query) {
        console.log(`[SEARCH] query: ${query}`);
        console.log("[FILEBASE LIBRARY] Search source: dynamically loaded serverless library");
        this.currentSearchQuery = query;
        
        const lowercaseQuery = query.toLowerCase();
        
        this.currentSearchResults = this.musicLibrary.filter(song => {
            return (
                (song.title && song.title.toLowerCase().includes(lowercaseQuery)) ||
                (song.artist && song.artist.toLowerCase().includes(lowercaseQuery)) ||
                (song.album && song.album.toLowerCase().includes(lowercaseQuery)) ||
                (song.category && song.category.toLowerCase().includes(lowercaseQuery)) ||
                (song.year && song.year.toString().includes(lowercaseQuery))
            );
        });
        
        console.log(`[SEARCH] matched: ${this.currentSearchResults.length} tracks`);
        window.uiManager.renderTrackList(this.currentSearchResults, 'search-results', "No results found for '" + query + "'");
        
        const btnLoadMoreContainer = document.getElementById('load-more-container');
        if (btnLoadMoreContainer) {
            btnLoadMoreContainer.style.display = 'none'; // No pagination needed
        }
    }

    loadHomeData() {
        const collections = [
            { id: 'ar-rahman', title: "A.R.Rahman", folder: "A.R.Rahman", thumbnail: "https://picsum.photos/seed/A.R.Rahman/500/500" },
            { id: 'hiphop', title: "Hiphop", folder: "Hiphop", thumbnail: "https://picsum.photos/seed/Hiphop/500/500" },
            { id: 'new-releases', title: "Tamil New Releases", folder: "NewReleases", thumbnail: "https://picsum.photos/seed/NewReleases/500/500" },
            { id: 'yuvan', title: "Yuvan", folder: "Yuvan", thumbnail: "https://picsum.photos/seed/Yuvan/500/500" },
            { id: 'recently-added', title: "Recently Added", folder: "", thumbnail: "https://picsum.photos/seed/recent/500/500" }
        ];
        
        const container = document.getElementById('collections-grid');
        if (!container) return;
        
        container.innerHTML = '';
        
        for (const coll of collections) {
            const folderTracks = this.musicLibrary.filter(song => {
                const parts = (song.s3Key || "").split('/');
                const songFolder = parts.length > 1 ? parts[parts.length - 2] : "";
                return songFolder === coll.folder;
            });
            
            if (folderTracks.length === 0) continue;
            
            console.log(`[HOME] Rendering collection: ${coll.title} with ${folderTracks.length} tracks`);
            
            const card = document.createElement('div');
            card.className = 'collection-card grid-card';
            
            card.innerHTML = `
                <img src="${coll.thumbnail}" class="grid-artwork" loading="lazy" alt="${coll.title}">
                <div class="grid-details">
                    <div class="grid-title">${coll.title}</div>
                    <div class="grid-artist" style="color: var(--secondary-text); font-size: 13px;">${folderTracks.length} songs</div>
                </div>
            `;
            
            card.addEventListener('click', () => {
                const searchInput = document.getElementById('search-input');
                if (searchInput) searchInput.value = coll.title;
                window.uiManager.showPage('search');
                window.uiManager.renderTrackList(folderTracks, 'search-results', "No results found for '" + coll.title + "'");
            });
            
            container.appendChild(card);
        }
    }

    loadFavorites() {
        const tracks = window.storageManager.getFavorites();
        window.uiManager.renderTrackList(tracks, 'favorites-results', "You haven't favorited any tracks yet.");
    }
    
    loadDownloads() {
        if (!window.OfflineManager) return;
        const tracks = window.OfflineManager.getOfflineTracks();
        window.uiManager.renderTrackList(tracks, 'downloads-results', "You haven't downloaded any tracks yet. Download tracks to listen offline.");
    }
}

// Initialize application on load
window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
