/**
 * js/storage.js
 * Handles LocalStorage for metadata (favorites)
 */

class StorageManager {
    constructor() {
    }

    // --- LocalStorage for Metadata ---

    getFavorites() {
        try {
            return JSON.parse(localStorage.getItem('mpt_favorites')) || [];
        } catch {
            return [];
        }
    }

    toggleFavorite(track) {
        const favs = this.getFavorites();
        const index = favs.findIndex(t => t.id === track.id);
        
        if (index > -1) {
            favs.splice(index, 1);
        } else {
            // Strip large unnecessary data if any, keep metadata
            favs.unshift({
                id: track.id,
                videoId: track.videoId,
                title: track.title,
                artist: track.artist,
                thumbnail: track.thumbnail,
                duration: track.duration,
                audioUrl: track.audioUrl
            });
        }
        
        localStorage.setItem('mpt_favorites', JSON.stringify(favs));
        return index === -1; // returns true if added
    }

    isFavorite(trackId) {
        return this.getFavorites().some(t => t.id === trackId);
    }
}

window.storageManager = new StorageManager();
