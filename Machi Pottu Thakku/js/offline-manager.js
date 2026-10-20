/**
 * js/offline-manager.js
 * Handles downloading, storing, and retrieving audio files and metadata for offline playback.
 */

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';

class OfflineManagerClass {
    constructor() {
        this.downloadsKey = 'mpt_offline_downloads';
        this.metadataFileName = 'mpt_offline_metadata.json';

        // In-flight download deduplication map
        this.downloadingPromises = new Map();

        // Load initial metadata synchronously from localStorage
        this.offlineTracks = this.loadMetadata();
        
        this.Filesystem = Filesystem;
        this.Directory = Directory;

        // Initialize persistent disk storage and migrate if needed
        this.initStorage();
    }

    loadMetadata() {
        try {
            const data = localStorage.getItem(this.downloadsKey);
            return data ? JSON.parse(data) : {};
        } catch (e) {
            console.error("[OFFLINE] Failed to load offline metadata from localStorage", e);
            return {};
        }
    }

    async initStorage() {
        if (!this.Filesystem || !this.Directory) return;
        try {
            // Check if disk backup exists
            const fileResult = await this.Filesystem.readFile({
                path: this.metadataFileName,
                directory: this.Directory.Data,
                encoding: Encoding?.UTF8 || 'utf8'
            });

            if (fileResult && fileResult.data) {
                const diskMetadata = typeof fileResult.data === 'string'
                    ? JSON.parse(fileResult.data)
                    : fileResult.data;

                let changed = false;
                for (const [id, track] of Object.entries(diskMetadata)) {
                    if (!this.offlineTracks[id] && track && track.localPath) {
                        this.offlineTracks[id] = track;
                        changed = true;
                    }
                }

                if (changed) {
                    try {
                        localStorage.setItem(this.downloadsKey, JSON.stringify(this.offlineTracks));
                    } catch (e) {}
                    console.log("[OFFLINE] Hydrated downloads metadata from persistent disk backup");
                }

                // If localStorage had tracks not yet on disk, sync them to disk
                const diskKeys = new Set(Object.keys(diskMetadata));
                const memoryHasNew = Object.keys(this.offlineTracks).some(k => !diskKeys.has(k));
                if (memoryHasNew) {
                    this.persistMetadataToDisk();
                }
            }
        } catch (e) {
            // Backup file does not exist yet; persist initial state
            this.persistMetadataToDisk();
        }

        // Safely clean up any abandoned zero-byte download fragments without affecting valid tracks
        try {
            if (typeof this.Filesystem.readdir === 'function') {
                const dirResult = await this.Filesystem.readdir({
                    path: '',
                    directory: this.Directory.Data
                });
                const files = dirResult?.files || [];
                for (const item of files) {
                    const fname = typeof item === 'string' ? item : item?.name;
                    if (fname && fname.startsWith('offline_')) {
                        try {
                            const stat = await this.Filesystem.stat({
                                path: fname,
                                directory: this.Directory.Data
                            });
                            if (stat && stat.size === 0) {
                                await this.Filesystem.deleteFile({
                                    path: fname,
                                    directory: this.Directory.Data
                                });
                                console.log(`[OFFLINE] Cleaned up 0-byte incomplete download: ${fname}`);
                            }
                        } catch (stErr) {}
                    }
                }
            }
        } catch (cleanupErr) {
            // readdir is optional/non-fatal
        }
    }

    saveMetadata() {
        try {
            localStorage.setItem(this.downloadsKey, JSON.stringify(this.offlineTracks));
        } catch (e) {
            console.error("[OFFLINE] Failed to save offline metadata to localStorage", e);
        }
        this.persistMetadataToDisk();
    }

    async persistMetadataToDisk() {
        if (!this.Filesystem || !this.Directory) return;
        try {
            await this.Filesystem.writeFile({
                path: this.metadataFileName,
                data: JSON.stringify(this.offlineTracks),
                directory: this.Directory.Data,
                encoding: Encoding?.UTF8 || 'utf8'
            });
        } catch (e) {
            console.warn("[OFFLINE] Failed to persist metadata to disk backup:", e);
        }
    }

    getOfflineTracks() {
        return Object.values(this.offlineTracks).sort((a, b) => (b.downloadedAt || 0) - (a.downloadedAt || 0));
    }

    findTrackEntry(trackIdentifier) {
        if (!trackIdentifier) return null;
        const entries = Object.values(this.offlineTracks);
        // 1. Match by canonical s3Key (permanent across library order/indexing changes)
        const matchByKey = entries.find(t => t.s3Key && t.s3Key === trackIdentifier);
        if (matchByKey) return matchByKey;
        // 2. Direct key lookup in map
        if (this.offlineTracks[trackIdentifier]) return this.offlineTracks[trackIdentifier];
        // 3. Fallback match by id
        return entries.find(t => String(t.id) === String(trackIdentifier)) || null;
    }

    async isDownloaded(trackId) {
        const track = this.findTrackEntry(trackId);

        if (!track || !track.localPath) {
            return false;
        }

        if (!this.Filesystem || !this.Directory) {
            return false;
        }

        try {
            const stat = await this.Filesystem.stat({
                path: track.localPath,
                directory: this.Directory.Data
            });

            // Ensure file exists and is not empty (0 bytes)
            return !!(stat && typeof stat.size === 'number' && stat.size > 0);
        } catch (e) {
            // Non-destructive: log warning but DO NOT delete metadata on transient errors
            console.warn("[OFFLINE] stat check failed for track:", trackId, e?.message);
            return false;
        }
    }

    async getLocalUrls(trackId) {
        const track = this.findTrackEntry(trackId);
        if (!track || !track.localPath) return null;

        if (!this.Filesystem || !this.Directory) {
            return null;
        }

        try {
            const stat = await this.Filesystem.stat({
                path: track.localPath,
                directory: this.Directory.Data
            });

            if (!stat || typeof stat.size !== 'number' || stat.size <= 0) {
                return null;
            }

            const uriResult = await this.Filesystem.getUri({
                path: track.localPath,
                directory: this.Directory.Data
            });

            return {
                nativeUrl: uriResult.uri,
                webViewUrl: Capacitor.convertFileSrc(uriResult.uri)
            };
        } catch (e) {
            console.error("[OFFLINE] Failed to resolve local URI:", e);
            return null;
        }
    }

    getLocalTrack(trackId) {
        return this.findTrackEntry(trackId);
    }

    async getStorageStats() {
        const tracks = Object.values(this.offlineTracks);
        let totalBytes = 0;
        let verifiedCount = 0;

        for (const track of tracks) {
            if (track && track.localPath && this.Filesystem && this.Directory) {
                try {
                    const stat = await this.Filesystem.stat({
                        path: track.localPath,
                        directory: this.Directory.Data
                    });
                    if (stat && typeof stat.size === 'number' && stat.size > 0) {
                        totalBytes += stat.size;
                        track.fileSize = stat.size;
                        verifiedCount++;
                        continue;
                    }
                } catch (e) {}
            }
            if (track && track.fileSize && typeof track.fileSize === 'number') {
                totalBytes += track.fileSize;
                verifiedCount++;
            }
        }

        const formatBytes = (bytes) => {
            if (!bytes || bytes <= 0) return '0 MB';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
        };

        return {
            totalBytes,
            formattedTotal: formatBytes(totalBytes),
            trackCount: verifiedCount
        };
    }

    async downloadTrack(track) {
        if (!track?.id) throw new Error("Invalid track object");

        // Canonical deduplication: check both track.id and s3Key
        const existingTrack = (track.s3Key && this.findTrackEntry(track.s3Key)) || this.findTrackEntry(track.id);
        if (existingTrack && await this.isDownloaded(existingTrack.id)) {
            console.log(`[OFFLINE] Track already downloaded: ${track.title || track.id}`);
            return existingTrack;
        }

        // Prevent duplicate concurrent downloads
        const downloadKey = track.s3Key || track.id;
        if (this.downloadingPromises.has(downloadKey)) {
            console.log(`[OFFLINE] Download already in progress for: ${track.title || track.id}`);
            return this.downloadingPromises.get(downloadKey);
        }

        const downloadPromise = this._executeDownload(track);
        this.downloadingPromises.set(downloadKey, downloadPromise);

        try {
            return await downloadPromise;
        } finally {
            this.downloadingPromises.delete(downloadKey);
        }
    }

    async _executeDownload(track) {
        if (await this.isDownloaded(track.id)) {
            return this.getLocalTrack(track.id); // Already downloaded and verified
        }

        if (track.s3Key) {
            const existingByKey = this.findTrackEntry(track.s3Key);
            if (existingByKey && await this.isDownloaded(existingByKey.id)) {
                return existingByKey;
            }
        }

        if (!track.s3Key) {
            throw new Error("Track has no s3Key, cannot download.");
        }

        if (!this.Filesystem || !this.Directory) {
            throw new Error("Filesystem plugin is not available. Are you running in Capacitor?");
        }

        // 1. Fetch Presigned URL (reusing existing Netlify API)
        let downloadUrl;
        try {
            const response = await fetch(window.getApiUrl(`/.netlify/functions/music-play?key=${encodeURIComponent(track.s3Key)}`));
            if (!response.ok) throw new Error("Failed to get signed URL (HTTP " + response.status + ")");
            const data = await response.json();
            if (data.error) throw new Error(data.error);
            if (!data.url) throw new Error("No URL returned from server");
            downloadUrl = data.url;
        } catch (e) {
            throw new Error("Failed to fetch presigned URL: " + e.message);
        }

        // 2. Download the actual audio data using Filesystem to a canonical path
        const extension = track.s3Key.split('.').pop() || 'mp3';
        const safeId = String(track.id).replace(/[^a-zA-Z0-9_-]/g, '_');
        const fileName = `offline_${safeId}.${extension}`;

        try {
            await this.Filesystem.downloadFile({
                url: downloadUrl,
                path: fileName,
                directory: this.Directory.Data
            });

            // Verify file exists and has non-zero size
            const stat = await this.Filesystem.stat({
                path: fileName,
                directory: this.Directory.Data
            });

            if (!stat || typeof stat.size !== 'number' || stat.size <= 0) {
                // Interrupted or empty file
                try {
                    await this.Filesystem.deleteFile({
                        path: fileName,
                        directory: this.Directory.Data
                    });
                } catch (cleanupErr) {}
                throw new Error("Downloaded audio file is empty or corrupted.");
            }

            // Generate both native and web URIs
            let nativeUrl = '';
            let webViewUrl = '';
            try {
                const uriResult = await this.Filesystem.getUri({
                    path: fileName,
                    directory: this.Directory.Data
                });
                nativeUrl = uriResult.uri;
                webViewUrl = Capacitor.convertFileSrc(uriResult.uri);
            } catch (e) {
                console.error("[OFFLINE] Failed to generate URIs post-download", e);
            }

            // 3. Save canonical metadata
            const offlineTrack = {
                id: track.id,
                title: track.title,
                artist: track.artist,
                album: track.album || '',
                duration: track.duration || 0,
                thumbnail: track.thumbnail || '',
                s3Key: track.s3Key,
                localPath: fileName,
                nativeUrl: nativeUrl,
                webViewUrl: webViewUrl,
                fileSize: stat.size,
                downloadedAt: Date.now()
            };

            this.offlineTracks[track.id] = offlineTrack;
            this.saveMetadata();

            console.log(`[OFFLINE] Successfully downloaded and verified: ${track.title} (${stat.size} bytes)`);
            return offlineTrack;
        } catch (e) {
            console.error("[OFFLINE] Filesystem download failed:", e);
            // Cleanup partial file if it exists
            try {
                await this.Filesystem.deleteFile({
                    path: fileName,
                    directory: this.Directory.Data
                });
            } catch (cleanupErr) {}
            throw new Error("Download failed: " + e.message);
        }
    }

    async deleteTrack(trackId) {
        const track = this.findTrackEntry(trackId);
        if (!track) return;

        // 1. Delete physical file from filesystem
        if (this.Filesystem && this.Directory && track.localPath) {
            try {
                await this.Filesystem.deleteFile({
                    path: track.localPath,
                    directory: this.Directory.Data
                });
            } catch (e) {
                console.error("[OFFLINE] Failed to delete local file for track", trackId, e);
            }
        }

        // 2. Clear any cached webview or network URLs from CacheStorage
        if (typeof window !== 'undefined' && 'caches' in window) {
            try {
                const cacheNames = await caches.keys();
                for (const name of cacheNames) {
                    const cache = await caches.open(name);
                    if (track.webViewUrl) await cache.delete(track.webViewUrl);
                    if (track.nativeUrl) await cache.delete(track.nativeUrl);
                }
            } catch (err) {
                console.warn("[OFFLINE] Cache eviction on track delete error:", err);
            }
        }

        // 3. Remove from metadata (by track.id and any matching key)
        const trackKey = track.id || trackId;
        delete this.offlineTracks[trackKey];
        if (trackId !== trackKey) {
            delete this.offlineTracks[trackId];
        }
        if (track.s3Key && this.offlineTracks[track.s3Key]) {
            delete this.offlineTracks[track.s3Key];
        }

        this.saveMetadata();
        console.log("[OFFLINE] Deleted track from offline storage:", trackId);
    }
}

window.OfflineManager = new OfflineManagerClass();
