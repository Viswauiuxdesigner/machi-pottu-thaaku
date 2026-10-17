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

    // 2. Matching album/movie artwork only when explicit and reliable (never generic placeholders)
    if (track.album && typeof track.album === 'string' && track.album.trim().length > 0 && lib.length > 0) {
        const albumTarget = track.album.toLowerCase().trim();
        const genericAlbums = ['single', 'unknown', 'unknown album', 'various', 'various artists', 'audio'];
        if (!genericAlbums.includes(albumTarget)) {
            const albumMatch = lib.find(t =>
                t.album && t.album.toLowerCase().trim() === albumTarget && t.thumbnail && typeof t.thumbnail === 'string' && t.thumbnail.trim().length > 0
            );
            if (albumMatch && albumMatch.thumbnail) {
                if (albumMatch.thumbnail.startsWith('http')) {
                    cacheArtworkOffline(albumMatch.thumbnail);
                }
                return albumMatch.thumbnail;
            }
        }
    }

    // 3. Matching artist artwork from library ONLY when artist is explicit and genuine (never generic placeholders)
    if (track.artist && typeof track.artist === 'string' && track.artist.trim().length > 0 && lib.length > 0) {
        const artistTarget = track.artist.toLowerCase().trim();
        const genericArtists = ['unknown', 'unknown artist', 'various', 'various artists', 'artist'];
        if (!genericArtists.includes(artistTarget)) {
            const artistMatch = lib.find(t =>
                t.artist && t.artist.toLowerCase().trim() === artistTarget && t.thumbnail && typeof t.thumbnail === 'string' && t.thumbnail.trim().length > 0
            );
            if (artistMatch && artistMatch.thumbnail) {
                if (artistMatch.thumbnail.startsWith('http')) {
                    cacheArtworkOffline(artistMatch.thumbnail);
                }
                return artistMatch.thumbnail;
            }
        }
    }

    // 4. Clean, offline-ready local SVG artwork based on collection / category / title
    const category = (track.category || '').toLowerCase();
    const title = (track.title || '').toLowerCase();

    if (category.includes('melod') || title.includes('melody') || title.includes('love') || title.includes('romantic')) {
        return '/assets/covers/melody.svg';
    }
    if (category.includes('folk') || category.includes('flok') || title.includes('folk') || title.includes('kuthu') || title.includes('gaana')) {
        return '/assets/covers/folk.svg';
    }
    if (category.includes('classic') || category.includes('old') || title.includes('retro') || title.includes('classic')) {
        return '/assets/covers/retro.svg';
    }
    if (category.includes('release') || category.includes('hit') || title.includes('hit') || title.includes('trending')) {
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
