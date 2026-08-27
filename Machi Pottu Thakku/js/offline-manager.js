/**
 * js/offline-manager.js
 * Handles downloading, storing, and retrieving audio files and metadata for offline playback.
 */

import { Filesystem, Directory } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';

class OfflineManagerClass {
    constructor() {
        this.downloadsKey = 'mpt_offline_downloads';
        // Object mapping track.id to track metadata + localPath
        this.offlineTracks = this.loadMetadata();
        
        // Use imported modules directly
        this.Filesystem = Filesystem;
        this.Directory = Directory;
    }

    loadMetadata() {
        try {
            const data = localStorage.getItem(this.downloadsKey);
            return data ? JSON.parse(data) : {};
        } catch (e) {
            console.error("Failed to load offline metadata", e);
            return {};
        }
    }

    saveMetadata() {
        try {
            localStorage.setItem(this.downloadsKey, JSON.stringify(this.offlineTracks));
        } catch (e) {
            console.error("Failed to save offline metadata", e);
        }
    }

    getOfflineTracks() {
        return Object.values(this.offlineTracks).sort((a, b) => b.downloadedAt - a.downloadedAt);
    }

    async isDownloaded(trackId) {
        if (!this.offlineTracks[trackId]) return false;
        
        // Optionally verify file exists if we are in Capacitor
        if (this.Filesystem && this.Directory) {
            try {
                const path = this.offlineTracks[trackId].localPath;
                await this.Filesystem.stat({
                    path: path,
                    directory: this.Directory.Data
                });
                return true;
            } catch (e) {
                // File missing on disk despite metadata
                console.warn("Track metadata exists but file is missing:", trackId);
                delete this.offlineTracks[trackId];
                this.saveMetadata();
                return false;
            }
        }
        
        return true;
    }

    async getLocalUrl(trackId) {
        if (!this.offlineTracks[trackId]) return null;
        const path = this.offlineTracks[trackId].localPath;
        
        if (this.Filesystem && this.Directory) {
            try {
                const uriResult = await this.Filesystem.getUri({
                    path: path,
                    directory: this.Directory.Data
                });
                return Capacitor.convertFileSrc(uriResult.uri);
            } catch (e) {
                console.error("Failed to get local URI", e);
                return null;
            }
        }
        
        return null;
    }

    getLocalTrack(trackId) {
        return this.offlineTracks[trackId] || null;
    }

    async downloadTrack(track) {
        if (await this.isDownloaded(track.id)) {
            return; // Already downloaded
        }

        if (!track.s3Key) {
            throw new Error("Track has no s3Key, cannot download.");
        }

        if (!this.Filesystem || !this.Directory) {
            throw new Error("Filesystem plugin is not available. Are you running in Capacitor?");
        }

        // 1. Fetch Presigned URL (we reuse the existing Netlify API for this)
        let downloadUrl;
        try {
            const response = await fetch(window.getApiUrl(`/.netlify/functions/music-play?key=${encodeURIComponent(track.s3Key)}`));
            if (!response.ok) throw new Error("Failed to get signed URL");
            const data = await response.json();
            if (data.error) throw new Error(data.error);
            if (!data.url) throw new Error("No URL returned");
            downloadUrl = data.url;
        } catch (e) {
            throw new Error("Failed to fetch presigned URL: " + e.message);
        }

        // 2. Download the actual audio data using Filesystem
        const extension = track.s3Key.split('.').pop() || 'mp3';
        const fileName = `offline_${track.id}.${extension}`;
        
        try {
            await this.Filesystem.downloadFile({
                url: downloadUrl,
                path: fileName,
                directory: this.Directory.Data
            });
            
            // 3. Save metadata
            const offlineTrack = {
                id: track.id,
                title: track.title,
                artist: track.artist,
                album: track.album || '',
                duration: track.duration || 0,
                thumbnail: track.thumbnail || '',
                s3Key: track.s3Key,
                localPath: fileName,
                downloadedAt: Date.now()
            };
            
            this.offlineTracks[track.id] = offlineTrack;
            this.saveMetadata();
            
            return offlineTrack;
        } catch (e) {
            console.error("Filesystem download failed", e);
            // Cleanup partial file if it exists
            try {
                await this.Filesystem.deleteFile({
                    path: fileName,
                    directory: this.Directory.Data
                });
            } catch (cleanupErr) {
                console.error("Failed to cleanup partial download", cleanupErr);
            }
            throw new Error("Download failed: " + e.message);
        }
    }

    async deleteTrack(trackId) {
        if (!this.offlineTracks[trackId]) return;
        
        if (this.Filesystem && this.Directory) {
            try {
                const path = this.offlineTracks[trackId].localPath;
                await this.Filesystem.deleteFile({
                    path: path,
                    directory: this.Directory.Data
                });
            } catch (e) {
                console.error("Failed to delete local file for track", trackId, e);
                // Continue to remove metadata even if file deletion fails
            }
        }
        
        delete this.offlineTracks[trackId];
        this.saveMetadata();
    }
}

window.OfflineManager = new OfflineManagerClass();
