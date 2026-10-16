/**
 * js/artwork.js
 * Implements reliable artwork resolution hierarchy:
 * 1. Exact track artwork (track.thumbnail)
 * 2. Matching album or movie artwork from the library
 * 3. Matching artist artwork from the library
 * 4. Clean, offline-ready local SVG artwork
 */

export async function cacheArtworkOffline(url) {
    if (!url || typeof url !== 'string' || !url.startsWith('http') || !('caches' in window)) {
        return;
    }
    try {
        const cache = await caches.open('mpt-artwork-cache-v1');
        const match = await cache.match(url);
        if (!match) {
            fetch(url, { mode: 'no-cors' })
                .then(res => {
                    if (res && (res.status === 200 || res.type === 'opaque')) {
                        cache.put(url, res);
                    }
                })
                .catch(() => {});
        }
    } catch (e) {}
}

export function getReliableArtwork(track, library = null) {
    if (!track) return '/assets/covers/default.svg';

    // 1. Exact track artwork if reliably available
    if (track.thumbnail && typeof track.thumbnail === 'string' && track.thumbnail.trim().length > 0) {
        if (track.thumbnail.startsWith('http')) {
            cacheArtworkOffline(track.thumbnail);
        }
        return track.thumbnail;
    }

    const lib = library || window.app?.musicLibrary || [];

    // 2. Matching album/movie artwork
    if (track.album && typeof track.album === 'string' && track.album.trim().length > 0 && lib.length > 0) {
        const albumTarget = track.album.toLowerCase().trim();
        const albumMatch = lib.find(t =>
            t.album && t.album.toLowerCase().trim() === albumTarget && t.thumbnail && t.thumbnail.trim().length > 0
        );
        if (albumMatch && albumMatch.thumbnail) {
            if (albumMatch.thumbnail.startsWith('http')) {
                cacheArtworkOffline(albumMatch.thumbnail);
            }
            return albumMatch.thumbnail;
        }
    }

    // 3. Matching artist artwork
    if (track.artist && typeof track.artist === 'string' && track.artist.trim().length > 0 && lib.length > 0) {
        const artistTarget = track.artist.toLowerCase().trim();
        const artistMatch = lib.find(t =>
            t.artist && t.artist.toLowerCase().trim() === artistTarget && t.thumbnail && t.thumbnail.trim().length > 0
        );
        if (artistMatch && artistMatch.thumbnail) {
            if (artistMatch.thumbnail.startsWith('http')) {
                cacheArtworkOffline(artistMatch.thumbnail);
            }
            return artistMatch.thumbnail;
        }
    }

    // 4. Deterministic curated local placeholder
    const textContext = `${track.title || ''} ${track.album || ''} ${track.artist || ''} ${track.category || ''}`.toLowerCase();

    if (textContext.includes('melody') || textContext.includes('love') || textContext.includes('romantic') || textContext.includes('feel')) {
        return '/assets/covers/melody.svg';
    }
    if (textContext.includes('folk') || textContext.includes('kuthu') || textContext.includes('gaana') || textContext.includes('beat') || textContext.includes('thara')) {
        return '/assets/covers/folk.svg';
    }
    if (textContext.includes('retro') || textContext.includes('classic') || textContext.includes('80s') || textContext.includes('90s') || textContext.includes('ilayaraja') || textContext.includes('spb')) {
        return '/assets/covers/retro.svg';
    }
    if (textContext.includes('hit') || textContext.includes('mass') || textContext.includes('trending') || textContext.includes('ani') || textContext.includes('anirudh')) {
        return '/assets/covers/tamil-hits.svg';
    }

    return '/assets/covers/default.svg';
}

export function getCollectionCover(folderName, tracks = []) {
    // Check if any track in collection has thumbnail
    const trackWithThumb = tracks.find(t => t.thumbnail && t.thumbnail.trim().length > 0);
    if (trackWithThumb) {
        if (trackWithThumb.thumbnail.startsWith('http')) {
            cacheArtworkOffline(trackWithThumb.thumbnail);
        }
        return trackWithThumb.thumbnail;
    }

    const titleLower = (folderName || '').toLowerCase();
    if (titleLower.includes('melody')) return '/assets/covers/melody.svg';
    if (titleLower.includes('folk') || titleLower.includes('kuthu')) return '/assets/covers/folk.svg';
    if (titleLower.includes('classic') || titleLower.includes('retro')) return '/assets/covers/retro.svg';
    if (titleLower.includes('hit') || titleLower.includes('trending')) return '/assets/covers/tamil-hits.svg';

    return '/assets/covers/default.svg';
}

window.getReliableArtwork = getReliableArtwork;
window.getCollectionCover = getCollectionCover;
window.cacheArtworkOffline = cacheArtworkOffline;
