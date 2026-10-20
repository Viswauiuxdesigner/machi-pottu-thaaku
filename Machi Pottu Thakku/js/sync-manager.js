/**
 * js/sync-manager.js
 * Production-minded Listen Together synchronization engine for Machi Pottu Thaaku.
 * Supports synchronized co-listening between two users across Internet P2P WebRTC.
 */

import { Capacitor } from '@capacitor/core';
import { AudioPlayer as NativeAudio } from '@mediagrid/capacitor-native-audio';

export const SyncState = Object.freeze({
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    WAITING: 'waiting',
    BUFFERING: 'buffering',
    READY: 'ready',
    RECONNECTING: 'reconnecting'
});

export const SyncRole = Object.freeze({
    NONE: 'none',
    HOST: 'host',
    RECEIVER: 'receiver'
});

export const TransportType = Object.freeze({
    INTERNET: 'internet',
    LOCAL_WIFI: 'local_wifi'
});

/**
 * NTP-style Clock Synchronization
 * Calculates RTT and clock offset between host and receiver.
 */
export class ClockSynchronizer {
    constructor() {
        this.samples = [];
        this.maxSamples = 7;
        this.clockOffset = 0; // receiverTime + clockOffset = hostTime
        this.rtt = 0;
        this.lastSyncEpoch = 0;
    }

    reset() {
        this.samples = [];
        this.clockOffset = 0;
        this.rtt = 0;
        this.lastSyncEpoch = 0;
    }

    createPingPayload(seq) {
        return {
            type: 'SYNC_PING',
            t0: Date.now(),
            seq
        };
    }

    createPongPayload(pingData, seq) {
        return {
            type: 'SYNC_PONG',
            t0: pingData.t0,
            t1: Date.now(),
            t2: Date.now(),
            seq
        };
    }

    processPong(pongData) {
        const t3 = Date.now();
        const t0 = pongData.t0;
        const t1 = pongData.t1;
        const t2 = pongData.t2;

        const roundTrip = (t3 - t0) - (t2 - t1);
        const rtt = Math.max(1, roundTrip);
        // Offset: Delta = ((t1 - t0) + (t2 - t3)) / 2
        const offset = Math.round(((t1 - t0) + (t2 - t3)) / 2);

        this.samples.push({ rtt, offset, timestamp: t3 });
        if (this.samples.length > this.maxSamples) {
            this.samples.shift();
        }

        // Sort by RTT and select lowest network jitter sample
        const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
        const best = sorted[0];

        this.rtt = best.rtt;
        this.clockOffset = best.offset;
        this.lastSyncEpoch = t3;

        return { rtt: this.rtt, clockOffset: this.clockOffset };
    }

    getSynchronizedNow() {
        return Date.now() + this.clockOffset;
    }
}

export const PROTOCOL_VERSION = 1;

/**
 * WebRTC DataChannel Transport using Official PeerJS Client
 * Connects via official PeerJS broker (0.peerjs.com) over standard PeerJS protocol.
 */
export class WebRTCPeerTransport {
    constructor(options = {}) {
        this.options = options;
        this.peer = null;
        this.dataConnection = null;
        this.onMessageCallback = null;
        this.onStatusCallback = null;
        this.role = SyncRole.NONE;
        this.isOpen = false;
        this.roomId = null;
        this.myPeerId = null;
        this.remotePeerId = null;
        this.connectionWatchdogTimer = null;
        this.sessionId = 0;
    }

    init(role, onMessage, onStatus) {
        this.role = role;
        this.onMessageCallback = onMessage;
        this.onStatusCallback = onStatus;
    }

    getPeerConfig() {
        return {
            host: '0.peerjs.com',
            port: 443,
            path: '/',
            secure: true,
            debug: 1,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                    { urls: 'stun:stun.services.mozilla.com' }
                ]
            }
        };
    }

    startConnectionWatchdog(timeoutMs = 14000) {
        this.clearConnectionWatchdog();
        this.connectionWatchdogTimer = setTimeout(() => {
            if (!this.isOpen) {
                console.warn("[LISTEN_TOGETHER_RTC] Connection timed out before WebRTC DataConnection opened");
                this.close();
                if (this.onStatusCallback) {
                    this.onStatusCallback(SyncState.DISCONNECTED);
                }
                if (window.uiManager?.showNotification) {
                    window.uiManager.showNotification("Connection timed out. Check room code and ensure the host is waiting.", "error");
                }
            }
        }, timeoutMs);
    }

    clearConnectionWatchdog() {
        if (this.connectionWatchdogTimer) {
            clearTimeout(this.connectionWatchdogTimer);
            this.connectionWatchdogTimer = null;
        }
    }

    handlePeerError(err) {
        console.error("[LISTEN_TOGETHER_RTC] PeerJS error:", err.type, err.message);
        let userMessage = "Connection error. Please try again.";

        switch (err.type) {
            case 'unavailable-id':
                userMessage = "This room code is already active. Please generate a new room code.";
                break;
            case 'peer-unavailable':
                userMessage = "Room not found. Check the 6-digit code and ensure the host is online.";
                break;
            case 'network':
                userMessage = "Cannot reach signaling server. Check your internet connection.";
                break;
            case 'server-error':
                userMessage = "Signaling service unavailable. Please retry in a moment.";
                break;
            case 'browser-incompatible':
                userMessage = "WebRTC is not supported on this browser or device.";
                break;
            case 'invalid-id':
                userMessage = "Invalid room code format.";
                break;
            default:
                if (err.message) {
                    userMessage = `Connection notice: ${err.message}`;
                }
                break;
        }

        if (window.uiManager?.showNotification) {
            window.uiManager.showNotification(userMessage, "error");
        }

        this.clearConnectionWatchdog();
        // Only trigger status callback if the connection was already actively established
        if (this.onStatusCallback && this.isOpen) {
            this.onStatusCallback(SyncState.DISCONNECTED);
        }
    }

    setupDataConnection(conn, currentSession = this.sessionId) {
        this.dataConnection = conn;

        conn.on('open', () => {
            if (this.sessionId !== currentSession) return;
            console.log("[LISTEN_TOGETHER_RTC] PeerJS DataConnection open & ready!");
            this.clearConnectionWatchdog();
            this.isOpen = true;
            this.remotePeerId = conn.peer;
            if (this.onStatusCallback) {
                this.onStatusCallback(SyncState.READY);
            }
        });

        conn.on('data', (rawMsg) => {
            if (this.sessionId !== currentSession) return;
            try {
                let msg = rawMsg;
                if (typeof rawMsg === 'string') {
                    msg = JSON.parse(rawMsg);
                }
                if (!msg || typeof msg !== 'object') {
                    console.warn("[LISTEN_TOGETHER_RTC] Dropped invalid non-object payload");
                    return;
                }
                if (msg.v && msg.v !== PROTOCOL_VERSION) {
                    console.warn(`[LISTEN_TOGETHER_RTC] Mismatched protocol version: ${msg.v} vs expected ${PROTOCOL_VERSION}`);
                    return;
                }
                if (!msg.type || typeof msg.type !== 'string') {
                    console.warn("[LISTEN_TOGETHER_RTC] Dropped payload missing type");
                    return;
                }
                if (this.onMessageCallback) {
                    this.onMessageCallback(msg);
                }
            } catch (e) {
                console.error("[LISTEN_TOGETHER_RTC] Error parsing DataConnection message:", e);
            }
        });

        conn.on('close', () => {
            if (this.sessionId !== currentSession) return;
            console.log("[LISTEN_TOGETHER_RTC] PeerJS DataConnection closed");
            this.dataConnection = null;
            if (this.role === SyncRole.HOST && this.peer && !this.peer.destroyed) {
                this.isOpen = true;
                if (this.onStatusCallback) {
                    this.onStatusCallback(SyncState.WAITING);
                }
            } else {
                this.isOpen = false;
                if (this.onStatusCallback) {
                    this.onStatusCallback(SyncState.DISCONNECTED);
                }
            }
        });

        conn.on('error', (err) => {
            if (this.sessionId !== currentSession) return;
            console.error("[LISTEN_TOGETHER_RTC] PeerJS DataConnection error:", err);
        });
    }

    async startHost(roomId) {
        this.close();
        const currentSession = this.sessionId;

        this.roomId = roomId;
        this.role = SyncRole.HOST;
        this.myPeerId = `mpt-${roomId.toUpperCase()}`;

        const PeerClass = window.Peer || window.peerjs?.Peer;
        if (typeof PeerClass !== 'function') {
            const err = new Error("PeerJS library is missing or failed to load. Please ensure peerjs.min.js is accessible.");
            err.type = 'peerjs-missing';
            console.error("[LISTEN_TOGETHER_RTC]", err);
            throw err;
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            let hostTimeoutTimer = null;

            const cleanupAndSettle = (err, val) => {
                if (settled) return;
                settled = true;
                if (hostTimeoutTimer) {
                    clearTimeout(hostTimeoutTimer);
                    hostTimeoutTimer = null;
                }
                if (err) {
                    this.close();
                    reject(err);
                } else {
                    resolve(val);
                }
            };

            hostTimeoutTimer = setTimeout(() => {
                if (this.sessionId !== currentSession || settled) return;
                console.error("[LISTEN_TOGETHER_RTC] Host creation timed out waiting for PeerJS open event");
                const timeoutErr = new Error("Connection to signaling broker timed out. Please check your internet connection and retry.");
                timeoutErr.type = "timeout";
                cleanupAndSettle(timeoutErr);
            }, 10000);

            try {
                console.log(`[LISTEN_TOGETHER_RTC] Registering host Peer ID: ${this.myPeerId}`);
                this.peer = new PeerClass(this.myPeerId, this.getPeerConfig());

                this.peer.on('open', (id) => {
                    if (this.sessionId !== currentSession || settled) return;
                    console.log(`[LISTEN_TOGETHER_RTC] Host peer opened with ID: ${id}`);
                    this.myPeerId = id;
                    this.isOpen = true;
                    cleanupAndSettle(null, true);
                });

                this.peer.on('connection', (conn) => {
                    if (this.sessionId !== currentSession) {
                        try { conn.close(); } catch(e) {}
                        return;
                    }
                    console.log(`[LISTEN_TOGETHER_RTC] Receiver connecting: ${conn.peer}`);
                    // Room occupancy protection: reject extra receivers if already paired
                    if (this.dataConnection && this.dataConnection.open) {
                        console.warn("[LISTEN_TOGETHER_RTC] Room already full. Closing secondary connection.");
                        conn.close();
                        return;
                    }

                    this.setupDataConnection(conn, currentSession);
                });

                this.peer.on('disconnected', () => {
                    if (this.sessionId !== currentSession) return;
                    console.warn("[LISTEN_TOGETHER_RTC] Host peer disconnected from signaling broker");
                    // Only attempt reconnect if peer was successfully established previously
                    if (this.isOpen && this.peer && !this.peer.destroyed) {
                        try { this.peer.reconnect(); } catch(e) {}
                    } else if (!settled) {
                        const discErr = new Error("Disconnected from signaling server before host registration completed.");
                        discErr.type = "network";
                        cleanupAndSettle(discErr);
                    }
                });

                this.peer.on('close', () => {
                    if (this.sessionId !== currentSession) return;
                    console.log("[LISTEN_TOGETHER_RTC] Host peer destroyed");
                    this.isOpen = false;
                    if (!settled) {
                        const closeErr = new Error("Peer connection closed before host registration completed.");
                        cleanupAndSettle(closeErr);
                    }
                });

                this.peer.on('error', (err) => {
                    if (this.sessionId !== currentSession) return;
                    if (!settled) {
                        console.error("[LISTEN_TOGETHER_RTC] Host registration error:", err?.type, err?.message);
                        cleanupAndSettle(err);
                    } else {
                        console.error("[LISTEN_TOGETHER_RTC] Host runtime peer error:", err?.type, err?.message);
                        this.handlePeerError(err);
                    }
                });

            } catch (err) {
                console.error("[LISTEN_TOGETHER_RTC] Synchronous error initializing host Peer:", err);
                cleanupAndSettle(err);
            }
        });
    }

    async startReceiver(roomId) {
        this.close();
        const currentSession = this.sessionId;

        this.roomId = roomId;
        this.role = SyncRole.RECEIVER;
        this.remotePeerId = `mpt-${roomId.toUpperCase()}`;

        const PeerClass = window.Peer || window.peerjs?.Peer;
        if (typeof PeerClass !== 'function') {
            const err = new Error("PeerJS library is missing or failed to load. Please ensure peerjs.min.js is accessible.");
            err.type = 'peerjs-missing';
            console.error("[LISTEN_TOGETHER_RTC]", err);
            throw err;
        }

        this.startConnectionWatchdog(14000);

        return new Promise((resolve, reject) => {
            let settled = false;

            const cleanupAndSettle = (err, val) => {
                if (settled) return;
                settled = true;
                if (err) {
                    this.close();
                    reject(err);
                } else {
                    resolve(val);
                }
            };

            try {
                console.log(`[LISTEN_TOGETHER_RTC] Receiver creating Peer to connect to host: ${this.remotePeerId}`);
                // Receiver lets broker assign a unique ID
                this.peer = new PeerClass(this.getPeerConfig());

                this.peer.on('open', (id) => {
                    if (this.sessionId !== currentSession || settled) return;
                    console.log(`[LISTEN_TOGETHER_RTC] Receiver peer opened with ID: ${id}. Connecting to ${this.remotePeerId}...`);
                    this.myPeerId = id;

                    try {
                        const conn = this.peer.connect(this.remotePeerId, {
                            reliable: true,
                            serialization: 'json'
                        });

                        this.setupDataConnection(conn, currentSession);
                        cleanupAndSettle(null, true);
                    } catch (connErr) {
                        console.error("[LISTEN_TOGETHER_RTC] Failed to initiate connection to host:", connErr);
                        cleanupAndSettle(connErr);
                    }
                });

                this.peer.on('disconnected', () => {
                    if (this.sessionId !== currentSession) return;
                    console.warn("[LISTEN_TOGETHER_RTC] Receiver disconnected from signaling broker");
                    if (this.isOpen && this.peer && !this.peer.destroyed) {
                        try { this.peer.reconnect(); } catch(e) {}
                    } else if (!settled) {
                        const discErr = new Error("Disconnected from signaling broker before connecting to host.");
                        discErr.type = "network";
                        cleanupAndSettle(discErr);
                    }
                });

                this.peer.on('close', () => {
                    if (this.sessionId !== currentSession) return;
                    console.log("[LISTEN_TOGETHER_RTC] Receiver peer destroyed");
                    this.isOpen = false;
                    if (!settled) {
                        cleanupAndSettle(new Error("Peer closed before connecting to host."));
                    }
                });

                this.peer.on('error', (err) => {
                    if (this.sessionId !== currentSession) return;
                    if (!settled) {
                        console.error("[LISTEN_TOGETHER_RTC] Receiver registration error:", err?.type, err?.message);
                        cleanupAndSettle(err);
                    } else {
                        console.error("[LISTEN_TOGETHER_RTC] Receiver runtime peer error:", err?.type, err?.message);
                        this.handlePeerError(err);
                    }
                });

            } catch (err) {
                console.error("[LISTEN_TOGETHER_RTC] Synchronous error initializing receiver Peer:", err);
                cleanupAndSettle(err);
            }
        });
    }

    send(data) {
        if (this.dataConnection && this.dataConnection.open) {
            const payload = {
                v: PROTOCOL_VERSION,
                ...data
            };
            this.dataConnection.send(payload);
            return true;
        }
        return false;
    }

    close() {
        this.sessionId++;
        this.clearConnectionWatchdog();

        if (this.dataConnection) {
            try { this.dataConnection.close(); } catch(e) {}
            this.dataConnection = null;
        }

        if (this.peer) {
            try { this.peer.destroy(); } catch(e) {}
            this.peer = null;
        }

        this.isOpen = false;
        this.role = SyncRole.NONE;
        this.remotePeerId = null;
        this.myPeerId = null;
        this.roomId = null;
    }
}

/**
 * Local Wi-Fi / Hotspot Transport Placeholder
 * Real offline P2P requires Android Native Service Discovery (NSD) over local LAN sockets.
 */
export class LocalManualTransport {
    constructor() {
        this.isSupported = false;
    }

    init(role, onMessage, onStatus) {}

    async startHost(roomId) {
        throw new Error("Local Wi-Fi Mode requires Android Native Service Discovery (NSD) and is under active development. Please switch to Internet P2P mode.");
    }

    async startReceiver(roomId) {
        throw new Error("Local Wi-Fi Mode requires Android Native Service Discovery (NSD) and is under active development. Please switch to Internet P2P mode.");
    }

    send(data) { return false; }
    close() {}
}

/**
 * SyncManager
 * Orchestrates room lifecycle, NTP clock sync, authoritative host controls,
 * readiness-gated track changes, and drift correction.
 */
export class SyncManager {
    constructor() {
        this.state = SyncState.DISCONNECTED;
        this.role = SyncRole.NONE;
        this.roomCode = null;
        this.transportType = TransportType.INTERNET;
        this.transport = null;

        this.isCreatingRoom = false;
        this.isJoiningRoom = false;

        this.clockSync = new ClockSynchronizer();
        this.currentSeq = 0;
        this.lastSeenSeq = 0;

        // Authoritative Host State
        this.sharedTrack = null;
        this.sharedPosition = 0;
        this.isHostPlaying = false;
        this.pendingTrackChangeTimeout = null;

        // Drift Monitoring
        this.heartbeatTimer = null;
        this.clockSyncTimer = null;
        this.currentDriftMs = 0;
        this.lastDriftAdjustmentEpoch = 0;
        this.isNudgeActive = false;

        this.scheduledPlayTimer = null;
        this.isExecutingPlay = false;

        this.stateListeners = new Set();
        this.statsListeners = new Set();

        this.initDOM();
    }

    initDOM() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.bindUI());
        } else {
            this.bindUI();
        }
    }

    bindUI() {
        const btnSync = document.getElementById('np-btn-sync');
        if (btnSync) {
            btnSync.onclick = () => this.openSyncDrawer();
        }

        const btnCreate = document.getElementById('sync-btn-create-room');
        if (btnCreate) {
            btnCreate.onclick = (e) => {
                if (e?.preventDefault) e.preventDefault();
                if (e?.stopPropagation) e.stopPropagation();
                this.createRoom();
            };
        }

        const btnJoin = document.getElementById('sync-btn-join-room');
        if (btnJoin) {
            btnJoin.onclick = (e) => {
                if (e?.preventDefault) e.preventDefault();
                if (e?.stopPropagation) e.stopPropagation();
                this.joinRoomFromInput();
            };
        }

        const inputCode = document.getElementById('sync-input-room-code');
        if (inputCode) {
            inputCode.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.joinRoomFromInput();
                }
            };
        }

        const btnLeave = document.getElementById('sync-btn-leave-room');
        if (btnLeave) {
            btnLeave.onclick = () => this.leaveRoom(true);
        }

        const btnCopy = document.getElementById('sync-btn-copy-code');
        if (btnCopy) {
            btnCopy.onclick = () => this.copyRoomCode();
        }

        const btnModeInternet = document.getElementById('sync-mode-internet');
        const btnModeLocal = document.getElementById('sync-mode-local');
        if (btnModeInternet && btnModeLocal) {
            btnModeInternet.onclick = () => {
                this.setTransportType(TransportType.INTERNET);
                btnModeInternet.classList.add('active');
                btnModeLocal.classList.remove('active');
            };
            btnModeLocal.onclick = () => {
                this.setTransportType(TransportType.LOCAL_WIFI);
                btnModeLocal.classList.add('active');
                btnModeInternet.classList.remove('active');
            };
        }

        this.renderDrawerUI();
    }

    updateCreateRoomButton(isCreating) {
        const btn = document.getElementById('sync-btn-create-room');
        if (!btn) return;
        if (isCreating) {
            btn.disabled = true;
            btn.style.opacity = '0.7';
            btn.style.pointerEvents = 'none';
            btn.innerHTML = `<span class="sync-spinner"></span> Creating Room...`;
        } else {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.pointerEvents = '';
            btn.innerHTML = `<i data-lucide="plus-circle" style="width: 18px; height: 18px; margin-right: 8px;"></i> Create Room`;
            if (window.lucide?.createIcons) {
                try { window.lucide.createIcons(); } catch(e) {}
            }
        }
    }

    updateJoinRoomButton(isJoining) {
        const btn = document.getElementById('sync-btn-join-room');
        const input = document.getElementById('sync-input-room-code');
        if (btn) {
            if (isJoining) {
                btn.disabled = true;
                btn.style.opacity = '0.7';
                btn.style.pointerEvents = 'none';
                btn.innerHTML = `<span class="sync-spinner"></span>`;
            } else {
                btn.disabled = false;
                btn.style.opacity = '1';
                btn.style.pointerEvents = '';
                btn.textContent = 'Join';
            }
        }
        if (input) {
            input.disabled = isJoining;
        }
    }

    setTransportType(type) {
        if (this.isInRoom()) {
            if (window.uiManager?.showNotification) {
                window.uiManager.showNotification("Cannot change transport mode while in a room. Leave room first.", "warning");
            }
            return;
        }

        if (type === TransportType.LOCAL_WIFI) {
            if (window.uiManager?.showNotification) {
                window.uiManager.showNotification("Local Wi-Fi Mode requires Android Native Service Discovery (NSD) and is under development. Use Internet P2P mode.", "info");
            }
            return;
        }

        this.transportType = type;
        console.log(`[LISTEN_TOGETHER] Transport set to: ${type}`);
    }

    generate6DigitCode() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    validateRoomCode(code) {
        if (!code || typeof code !== 'string') return false;
        return /^\d{6}$/.test(code.trim());
    }

    isInRoom() {
        return this.state !== SyncState.DISCONNECTED && this.role !== SyncRole.NONE;
    }

    isHost() {
        return this.role === SyncRole.HOST && this.isInRoom();
    }

    isReceiver() {
        return this.role === SyncRole.RECEIVER && this.isInRoom();
    }

    handleTransportStatus(status) {
        console.log(`[LISTEN_TOGETHER] Transport status callback received: ${status}`);
        if (status === SyncState.DISCONNECTED) {
            if (this.role === SyncRole.HOST && this.transport?.peer && !this.transport.peer.destroyed) {
                console.log("[LISTEN_TOGETHER] Receiver disconnected. Host returning to WAITING state.");
                this.setState(SyncState.WAITING);
                return;
            }
            this.setState(SyncState.DISCONNECTED);
        } else {
            this.setState(status);
        }
    }

    setState(newState) {
        const oldState = this.state;
        this.state = newState;
        console.log(`[LISTEN_TOGETHER] State transition: ${oldState} -> ${newState}`);

        if (newState === SyncState.DISCONNECTED) {
            this.role = SyncRole.NONE;
            this.roomCode = null;
            this.sharedTrack = null;
            this.currentDriftMs = 0;
            this.isCreatingRoom = false;
            this.isJoiningRoom = false;
            this.updateCreateRoomButton(false);
            this.updateJoinRoomButton(false);
        }

        if (newState === SyncState.READY && oldState !== SyncState.READY) {
            if (this.isHost()) {
                this.startClockSync();
                this.startHeartbeat();
                if (window.player?.currentTrack) {
                    this.broadcastTrackChange(window.player.currentTrack, window.player.queueIndex || 0);
                }
            } else if (this.isReceiver()) {
                this.startClockSync();
            }
        }

        this.stateListeners.forEach(cb => {
            try { cb(newState, oldState, this.role); } catch(e) {}
        });

        this.renderDrawerUI();
        this.updateNowPlayingBadge();
    }

    updateStats() {
        const stats = {
            rtt: this.clockSync.rtt,
            clockOffset: this.clockSync.clockOffset,
            driftMs: this.currentDriftMs,
            role: this.role,
            state: this.state,
            roomCode: this.roomCode
        };

        this.statsListeners.forEach(cb => {
            try { cb(stats); } catch(e) {}
        });

        this.renderDrawerUI();
    }

    async createRoom() {
        if (this.isCreatingRoom || this.isJoiningRoom) {
            console.log("[LISTEN_TOGETHER] Room creation or join already in progress. Ignoring duplicate click.");
            return;
        }

        const PeerClass = window.Peer || window.peerjs?.Peer;
        if (typeof PeerClass !== 'function') {
            console.error("[LISTEN_TOGETHER] PeerJS library is missing or failed to load.");
            if (window.uiManager?.showNotification) {
                window.uiManager.showNotification("PeerJS library is missing. Please check internet connection.", "error");
            }
            return;
        }

        if (this.isInRoom()) {
            this.leaveRoom(false);
        }

        this.isCreatingRoom = true;
        this.updateCreateRoomButton(true);

        let attempts = 0;
        let success = false;
        let lastError = null;

        try {
            while (attempts < 2 && !success) {
                attempts++;
                const newCode = this.generate6DigitCode();
                console.log(`[LISTEN_TOGETHER] Generated room code attempt ${attempts}: ${newCode}`);

                const transport = new WebRTCPeerTransport();
                transport.init(
                    SyncRole.HOST,
                    (msg) => this.handleIncomingMessage(msg),
                    (status) => this.handleTransportStatus(status)
                );

                try {
                    await transport.startHost(newCode);

                    // PeerJS host successfully opened and registered with signaling broker!
                    this.transport = transport;
                    this.roomCode = newCode;
                    this.role = SyncRole.HOST;
                    this.currentSeq = 1;
                    this.lastSeenSeq = 0;
                    this.clockSync.reset();

                    this.setState(SyncState.WAITING);
                    success = true;

                    if (window.uiManager?.showNotification) {
                        window.uiManager.showNotification(`Room created! Code: ${this.roomCode}. Share code with friend.`, "success");
                    }
                } catch (err) {
                    lastError = err;
                    console.error(`[LISTEN_TOGETHER] Host creation failed on code ${newCode}:`, err);
                    try { transport.close(); } catch(e) {}

                    if (err?.type === 'unavailable-id' && attempts < 2) {
                        console.warn(`[LISTEN_TOGETHER] Code ${newCode} was already taken. Retrying with a new code...`);
                        continue;
                    }
                    break;
                }
            }

            if (!success) {
                this.setState(SyncState.DISCONNECTED);
                let userMsg = "Failed to create room. Please check internet connection.";
                if (lastError?.type === 'unavailable-id') {
                    userMsg = "Room code collision. Please tap Create Room again.";
                } else if (lastError?.type === 'peerjs-missing') {
                    userMsg = "PeerJS library is missing or failed to load.";
                } else if (lastError?.type === 'network') {
                    userMsg = "Network error: Unable to reach signaling broker.";
                } else if (lastError?.type === 'timeout') {
                    userMsg = "Room creation timed out. Signaling broker unreachable.";
                } else if (lastError?.message) {
                    userMsg = lastError.message;
                }

                if (window.uiManager?.showNotification) {
                    window.uiManager.showNotification(userMsg, "error");
                }
            }
        } finally {
            this.isCreatingRoom = false;
            this.updateCreateRoomButton(false);
        }
    }

    async joinRoomFromInput() {
        const input = document.getElementById('sync-input-room-code');
        const code = input ? input.value.trim() : '';
        await this.joinRoom(code);
    }

    async joinRoom(code) {
        if (this.isJoiningRoom || this.isCreatingRoom) {
            console.log("[LISTEN_TOGETHER] Connection attempt already in progress.");
            return;
        }

        const trimmedCode = (code || '').trim();
        if (!this.validateRoomCode(trimmedCode)) {
            if (window.uiManager?.showNotification) {
                window.uiManager.showNotification("Please enter a valid 6-digit numeric room code.", "warning");
            }
            return;
        }

        const PeerClass = window.Peer || window.peerjs?.Peer;
        if (typeof PeerClass !== 'function') {
            console.error("[LISTEN_TOGETHER] PeerJS library is missing or failed to load.");
            if (window.uiManager?.showNotification) {
                window.uiManager.showNotification("PeerJS library is missing. Please check internet connection.", "error");
            }
            return;
        }

        if (this.isInRoom()) {
            this.leaveRoom(false);
        }

        this.isJoiningRoom = true;
        this.updateJoinRoomButton(true);

        const transport = new WebRTCPeerTransport();
        transport.init(
            SyncRole.RECEIVER,
            (msg) => this.handleIncomingMessage(msg),
            (status) => this.handleTransportStatus(status)
        );

        try {
            console.log(`[LISTEN_TOGETHER] Receiver connecting to room ${trimmedCode}...`);
            this.roomCode = trimmedCode;
            this.role = SyncRole.RECEIVER;
            this.currentSeq = 0;
            this.lastSeenSeq = 0;
            this.clockSync.reset();
            this.setState(SyncState.CONNECTING);

            await transport.startReceiver(trimmedCode);
            this.transport = transport;

            if (window.uiManager?.showNotification) {
                window.uiManager.showNotification(`Connecting to room ${trimmedCode}...`, "info");
            }
        } catch (err) {
            console.error("[LISTEN_TOGETHER] Failed to join room:", err);
            try { transport.close(); } catch(e) {}
            this.transport = null;
            this.setState(SyncState.DISCONNECTED);

            let userMsg = "Failed to connect to room. Verify the code and retry.";
            if (err?.type === 'peer-unavailable') {
                userMsg = "Room not found. Check the 6-digit code and ensure the host is waiting.";
            } else if (err?.message) {
                userMsg = err.message;
            }

            if (window.uiManager?.showNotification) {
                window.uiManager.showNotification(userMsg, "error");
            }
        } finally {
            this.isJoiningRoom = false;
            this.updateJoinRoomButton(false);
        }
    }

    leaveRoom(notifyPeer = true) {
        if (this.state === SyncState.DISCONNECTED && this.role === SyncRole.NONE) return;

        console.log("[LISTEN_TOGETHER] Leaving room...");

        if (this.pendingTrackChangeTimeout) {
            clearTimeout(this.pendingTrackChangeTimeout);
            this.pendingTrackChangeTimeout = null;
        }

        if (this.scheduledPlayTimer) {
            clearTimeout(this.scheduledPlayTimer);
            this.scheduledPlayTimer = null;
        }

        if (notifyPeer && this.transport) {
            try {
                this.transport.send({
                    type: 'ROOM_LEAVE',
                    role: this.role,
                    roomCode: this.roomCode
                });
            } catch(e) {}
        }

        this.stopHeartbeat();
        this.stopClockSyncInterval();

        if (this.transport) {
            try { this.transport.close(); } catch(e) {}
            this.transport = null;
        }

        if (this.isNudgeActive) {
            this.applyPlaybackRate(1.0);
            this.isNudgeActive = false;
        }

        const prevRole = this.role;
        this.setState(SyncState.DISCONNECTED);

        if (window.uiManager?.showNotification) {
            window.uiManager.showNotification(
                prevRole === SyncRole.HOST ? "Room closed. Returned to solo listening." : "Left room. Returned to solo listening.",
                "info"
            );
        }
    }

    copyRoomCode() {
        if (!this.roomCode) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(this.roomCode).then(() => {
                if (window.uiManager?.showNotification) {
                    window.uiManager.showNotification("Room code copied to clipboard!", "success");
                }
            }).catch(() => {
                this.fallbackCopy(this.roomCode);
            });
        } else {
            this.fallbackCopy(this.roomCode);
        }
    }

    fallbackCopy(text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            if (window.uiManager?.showNotification) {
                window.uiManager.showNotification("Room code copied!", "success");
            }
        } catch(e) {}
        document.body.removeChild(textarea);
    }

    // --- Clock Synchronization ---

    startClockSync() {
        let count = 0;
        const burstInterval = setInterval(() => {
            if (!this.isInRoom() || !this.transport) {
                clearInterval(burstInterval);
                return;
            }
            this.sendPing();
            count++;
            if (count >= 4) {
                clearInterval(burstInterval);
                this.startClockSyncInterval();
            }
        }, 350);
    }

    startClockSyncInterval() {
        this.stopClockSyncInterval();
        this.clockSyncTimer = setInterval(() => {
            if (this.isInRoom() && this.transport) {
                this.sendPing();
            }
        }, 12000);
    }

    stopClockSyncInterval() {
        if (this.clockSyncTimer) {
            clearInterval(this.clockSyncTimer);
            this.clockSyncTimer = null;
        }
    }

    sendPing() {
        if (!this.transport) return;
        this.currentSeq++;
        const ping = this.clockSync.createPingPayload(this.currentSeq);
        this.transport.send(ping);
    }

    // --- Message Handling ---

    handleIncomingMessage(data) {
        if (!data || !data.type) return;

        // Sequence Validation
        if (typeof data.seq === 'number') {
            if (data.seq <= this.lastSeenSeq && data.type !== 'SYNC_PONG' && data.type !== 'SYNC_PING') {
                console.log(`[LISTEN_TOGETHER] Discarded stale packet seq ${data.seq} <= ${this.lastSeenSeq}`);
                return;
            }
            this.lastSeenSeq = data.seq;
        }

        switch (data.type) {
            case 'SYNC_PING':
                this.handlePing(data);
                break;
            case 'SYNC_PONG':
                this.handlePong(data);
                break;
            case 'ROOM_LEAVE':
                console.log("[LISTEN_TOGETHER] Peer left room");
                if (this.role === SyncRole.RECEIVER) {
                    this.leaveRoom(false);
                } else if (this.role === SyncRole.HOST) {
                    this.setState(SyncState.WAITING);
                    if (window.uiManager?.showNotification) {
                        window.uiManager.showNotification("Friend left the room. Waiting for reconnection...", "info");
                    }
                }
                break;
            case 'PREPARE_TRACK':
                if (this.role === SyncRole.RECEIVER) {
                    this.handlePrepareTrack(data);
                }
                break;
            case 'RECEIVER_READY':
                if (this.role === SyncRole.HOST) {
                    this.handleReceiverReady(data);
                }
                break;
            case 'RECEIVER_ERROR':
                if (this.role === SyncRole.HOST) {
                    this.handleReceiverError(data);
                }
                break;
            case 'SCHEDULED_PLAY':
                if (this.role === SyncRole.RECEIVER) {
                    this.handleScheduledPlay(data);
                }
                break;
            case 'PAUSE':
                if (this.role === SyncRole.RECEIVER) {
                    this.handlePause(data);
                }
                break;
            case 'SEEK':
                if (this.role === SyncRole.RECEIVER) {
                    this.handleSeek(data);
                }
                break;
            case 'HEARTBEAT':
                if (this.role === SyncRole.RECEIVER) {
                    this.handleHeartbeat(data);
                }
                break;
            case 'REPEAT_MODE':
                if (this.role === SyncRole.RECEIVER) {
                    this.handleRepeatMode(data);
                }
                break;
            default:
                console.warn("[LISTEN_TOGETHER] Unknown packet type:", data.type);
        }
    }

    handlePing(pingData) {
        if (!this.transport) return;
        const pong = this.clockSync.createPongPayload(pingData, pingData.seq);
        this.transport.send(pong);
    }

    handlePong(pongData) {
        const stats = this.clockSync.processPong(pongData);
        this.updateStats();
        console.log(`[LISTEN_TOGETHER] NTP Sync: RTT=${stats.rtt}ms, ClockOffset=${stats.clockOffset}ms`);
    }

    // --- Host Broadcast Operations ---

    broadcastTrackChange(track, queueIndex = 0) {
        if (!this.isHost() || !track) return;

        this.currentSeq++;
        this.sharedTrack = {
            id: track.id,
            s3Key: track.s3Key,
            title: track.title,
            artist: track.artist,
            album: track.album,
            duration: track.duration,
            thumbnail: track.thumbnail
        };

        this.setState(SyncState.BUFFERING);
        console.log("[LISTEN_TOGETHER] Host broadcasting PREPARE_TRACK:", this.sharedTrack.title);

        this.transport.send({
            type: 'PREPARE_TRACK',
            track: this.sharedTrack,
            queueIndex,
            seq: this.currentSeq
        });

        // Readiness Watchdog: If Receiver doesn't report ready within 4.5s, Host plays gracefully
        if (this.pendingTrackChangeTimeout) {
            clearTimeout(this.pendingTrackChangeTimeout);
        }
        this.pendingTrackChangeTimeout = setTimeout(() => {
            if (this.isHost() && this.state === SyncState.BUFFERING) {
                console.warn("[LISTEN_TOGETHER] Receiver ready timeout reached; proceeding with Host start");
                this.setState(SyncState.READY);
                this.broadcastScheduledPlay(0);
                if (window.uiManager?.showNotification) {
                    window.uiManager.showNotification("Friend took too long to prepare; starting playback.", "info");
                }
            }
        }, 4500);
    }

    handleReceiverReady(data) {
        console.log("[LISTEN_TOGETHER] Receiver reported READY for track:", data.trackId);
        if (this.pendingTrackChangeTimeout) {
            clearTimeout(this.pendingTrackChangeTimeout);
            this.pendingTrackChangeTimeout = null;
        }

        this.setState(SyncState.READY);
        if (window.uiManager?.showNotification) {
            window.uiManager.showNotification("Friend is ready! Starting synchronized playback...", "success");
        }

        // Both devices are ready! Schedule synchronized start
        this.broadcastScheduledPlay(0);
    }

    handleReceiverError(data) {
        console.warn("[LISTEN_TOGETHER] Receiver reported error:", data.reason);
        if (this.pendingTrackChangeTimeout) {
            clearTimeout(this.pendingTrackChangeTimeout);
            this.pendingTrackChangeTimeout = null;
        }
        this.setState(SyncState.READY);
        if (window.uiManager?.showNotification) {
            window.uiManager.showNotification(`Friend could not load track: ${data.reason}`, "warning");
        }
    }

    broadcastScheduledPlay(position = 0) {
        if (!this.isHost()) return;

        this.currentSeq++;
        this.isHostPlaying = true;
        // Lead-time: measured RTT + safety buffer (at least 350ms, or RTT + 150ms)
        const leadTimeMs = Math.max(350, (this.clockSync.rtt || 100) + 150);
        const scheduledStartEpoch = this.clockSync.getSynchronizedNow() + leadTimeMs;

        console.log(`[LISTEN_TOGETHER] Host scheduling start in ${leadTimeMs}ms at epoch ${scheduledStartEpoch}`);

        this.transport.send({
            type: 'SCHEDULED_PLAY',
            position,
            scheduledStartEpoch,
            seq: this.currentSeq
        });

        // Host schedules its own audio start at target epoch
        this.scheduleLocalPlay(position, scheduledStartEpoch);
    }

    broadcastPause(position = 0) {
        if (!this.isHost()) return;

        this.currentSeq++;
        this.isHostPlaying = false;

        this.transport.send({
            type: 'PAUSE',
            position,
            timestamp: this.clockSync.getSynchronizedNow(),
            seq: this.currentSeq
        });
    }

    broadcastSeek(position, isPlaying = true) {
        if (!this.isHost()) return;

        this.currentSeq++;
        this.isHostPlaying = isPlaying;

        this.transport.send({
            type: 'SEEK',
            position,
            isPlaying,
            timestamp: this.clockSync.getSynchronizedNow(),
            seq: this.currentSeq
        });
    }

    broadcastRepeatMode(mode) {
        if (!this.isHost() || !this.transport) return;
        this.currentSeq++;
        this.transport.send({
            type: 'REPEAT_MODE',
            mode,
            seq: this.currentSeq
        });
    }

    handleRepeatMode(data) {
        if (!data || !data.mode) return;
        console.log("[LISTEN_TOGETHER] Host updated repeat mode:", data.mode);
        if (window.player && typeof window.player.setRepeatMode === 'function') {
            window.player.setRepeatMode(data.mode);
        }
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(async () => {
            if (!this.isHost() || !this.transport) return;

            let currentPos = 0;
            let isPlaying = false;

            if (Capacitor.isNativePlatform() && window.player?.nativeInitialized) {
                try {
                    const status = await NativeAudio.isPlaying({ audioId: 'main' });
                    isPlaying = Boolean(status.isPlaying);
                    const timeRes = await NativeAudio.getCurrentTime({ audioId: 'main' });
                    currentPos = timeRes.currentTime || 0;
                } catch(e) {}
            } else if (window.player?.audio) {
                isPlaying = !window.player.audio.paused;
                currentPos = window.player.audio.currentTime || 0;
            }

            this.currentSeq++;
            this.transport.send({
                type: 'HEARTBEAT',
                position: currentPos,
                isPlaying,
                timestamp: this.clockSync.getSynchronizedNow(),
                seq: this.currentSeq
            });
        }, 2500);
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    // --- Receiver Handlers ---

    async handlePrepareTrack(data) {
        const trackMeta = data.track;
        if (!trackMeta) return;

        console.log("[LISTEN_TOGETHER] Receiver preparing track:", trackMeta.title);
        this.setState(SyncState.BUFFERING);

        try {
            // Load track directly into player pipeline (supports both native Android and Web)
            const success = await window.player?.loadSyncTrack(trackMeta);
            if (!success) {
                console.warn("[LISTEN_TOGETHER] Could not load track on receiver:", trackMeta.title);
                this.transport.send({
                    type: 'RECEIVER_ERROR',
                    trackId: trackMeta.id,
                    reason: 'Track audio unavailable on receiver',
                    seq: this.currentSeq
                });
                if (window.uiManager?.showNotification) {
                    window.uiManager.showNotification(`Cannot sync: "${trackMeta.title}" is unavailable on this phone.`, "error");
                }
                return;
            }

            // Signal readiness to host
            this.setState(SyncState.READY);
            this.transport.send({
                type: 'RECEIVER_READY',
                trackId: trackMeta.id,
                seq: this.currentSeq
            });
            console.log("[LISTEN_TOGETHER] Sent RECEIVER_READY for:", trackMeta.title);
        } catch (err) {
            console.error("[LISTEN_TOGETHER] Failed to prepare receiver track:", err);
            this.transport.send({
                type: 'RECEIVER_ERROR',
                trackId: trackMeta.id,
                reason: err.message,
                seq: this.currentSeq
            });
        }
    }

    handleScheduledPlay(data) {
        if (this.scheduledPlayTimer) {
            clearTimeout(this.scheduledPlayTimer);
            this.scheduledPlayTimer = null;
        }

        const { position, scheduledStartEpoch } = data;
        const now = this.clockSync.getSynchronizedNow();
        const delayMs = scheduledStartEpoch - now;

        console.log(`[LISTEN_TOGETHER] Receiver scheduled play: delay=${delayMs}ms at pos=${position}s`);

        if (delayMs > 0) {
            this.scheduledPlayTimer = setTimeout(() => {
                this.scheduledPlayTimer = null;
                this.executePlay(position);
            }, delayMs);
        } else {
            const catchupPos = position + Math.abs(delayMs) / 1000;
            this.executePlay(catchupPos);
        }
    }

    scheduleLocalPlay(position, scheduledStartEpoch) {
        if (this.scheduledPlayTimer) {
            clearTimeout(this.scheduledPlayTimer);
            this.scheduledPlayTimer = null;
        }

        const now = this.clockSync.getSynchronizedNow();
        const delayMs = scheduledStartEpoch - now;

        if (delayMs > 0) {
            this.scheduledPlayTimer = setTimeout(() => {
                this.scheduledPlayTimer = null;
                this.executePlay(position);
            }, delayMs);
        } else {
            this.executePlay(position);
        }
    }

    async executePlay(targetPosition) {
        if (!window.player) return;
        if (this.isExecutingPlay) {
            console.log("[LISTEN_TOGETHER] Playback execution already in flight, debouncing duplicate invocation");
            return;
        }
        this.isExecutingPlay = true;

        try {
            if (Capacitor.isNativePlatform() && window.player.nativeInitialized) {
                try {
                    if (typeof targetPosition === 'number' && targetPosition > 0) {
                        await NativeAudio.seek({ audioId: 'main', timeInSeconds: Math.round(targetPosition) });
                    }
                    await NativeAudio.play({ audioId: 'main' });
                    window.player.syncUIState(true);
                } catch(e) {
                    console.error("[LISTEN_TOGETHER] Native executePlay error", e);
                }
            } else if (window.player.audio) {
                try {
                    if (typeof targetPosition === 'number' && targetPosition > 0) {
                        window.player.audio.currentTime = targetPosition;
                    }
                    await window.player.audio.play();
                    window.player.syncUIState(true);
                } catch(e) {
                    console.error("[LISTEN_TOGETHER] Web executePlay error", e);
                }
            }
        } finally {
            setTimeout(() => {
                this.isExecutingPlay = false;
            }, 300);
        }
    }

    async handlePause(data) {
        console.log("[LISTEN_TOGETHER] Host paused playback at:", data.position);
        if (!window.player) return;

        if (Capacitor.isNativePlatform() && window.player.nativeInitialized) {
            try {
                await NativeAudio.pause({ audioId: 'main' });
                if (typeof data.position === 'number') {
                    await NativeAudio.seek({ audioId: 'main', timeInSeconds: Math.round(data.position) });
                }
            } catch(e) {}
        } else if (window.player.audio) {
            window.player.audio.pause();
            if (typeof data.position === 'number') {
                window.player.audio.currentTime = data.position;
            }
        }

        window.player.syncUIState(false);
    }

    async handleSeek(data) {
        console.log("[LISTEN_TOGETHER] Host seeked to:", data.position, "isPlaying:", data.isPlaying);
        if (!window.player) return;

        if (Capacitor.isNativePlatform() && window.player.nativeInitialized) {
            try {
                await NativeAudio.seek({ audioId: 'main', timeInSeconds: Math.round(data.position) });
                if (data.isPlaying) {
                    await NativeAudio.play({ audioId: 'main' });
                    window.player.syncUIState(true);
                } else {
                    await NativeAudio.pause({ audioId: 'main' });
                    window.player.syncUIState(false);
                }
            } catch(e) {}
        } else if (window.player.audio) {
            window.player.audio.currentTime = data.position;
            if (data.isPlaying) {
                window.player.audio.play().catch(() => {});
                window.player.syncUIState(true);
            } else {
                window.player.audio.pause();
                window.player.syncUIState(false);
            }
        }
    }

    // --- Drift Correction Engine ---

    async handleHeartbeat(data) {
        if (this.role !== SyncRole.RECEIVER || !data) return;

        const { position: hostPos, isPlaying: hostPlaying, timestamp } = data;
        const now = this.clockSync.getSynchronizedNow();

        const elapsedSec = hostPlaying ? (now - timestamp) / 1000 : 0;
        const expectedHostPos = hostPos + elapsedSec;

        let receiverPos = 0;
        let receiverPlaying = false;

        if (Capacitor.isNativePlatform() && window.player?.nativeInitialized) {
            try {
                const res = await NativeAudio.getCurrentTime({ audioId: 'main' });
                receiverPos = res.currentTime || 0;
                const status = await NativeAudio.isPlaying({ audioId: 'main' });
                receiverPlaying = Boolean(status.isPlaying);
            } catch(e) {}
        } else if (window.player?.audio) {
            receiverPos = window.player.audio.currentTime || 0;
            receiverPlaying = !window.player.audio.paused;
        }

        // Align playback state with Host
        if (!hostPlaying && receiverPlaying) {
            this.handlePause({ position: hostPos });
            return;
        }

        if (hostPlaying && !receiverPlaying) {
            this.executePlay(expectedHostPos);
            return;
        }

        if (!hostPlaying) return;

        const driftSec = receiverPos - expectedHostPos;
        this.currentDriftMs = Math.round(driftSec * 1000);
        const absDriftMs = Math.abs(this.currentDriftMs);

        this.updateStats();

        // Drift Classification & Correction
        if (absDriftMs < 120) {
            // In Sync (< 120ms): Imperceptible
            if (this.isNudgeActive) {
                this.applyPlaybackRate(1.0);
                this.isNudgeActive = false;
            }
        } else if (absDriftMs <= 600) {
            // Gentle Rate Nudge (120ms to 600ms)
            const nowEpoch = Date.now();
            if (nowEpoch - this.lastDriftAdjustmentEpoch > 2000) {
                this.lastDriftAdjustmentEpoch = nowEpoch;
                this.isNudgeActive = true;

                if (driftSec > 0) {
                    console.log(`[LISTEN_TOGETHER_DRIFT] Receiver ahead by ${this.currentDriftMs}ms -> Nudging to 0.97x`);
                    this.applyPlaybackRate(0.97);
                } else {
                    console.log(`[LISTEN_TOGETHER_DRIFT] Receiver behind by ${this.currentDriftMs}ms -> Nudging to 1.03x`);
                    this.applyPlaybackRate(1.03);
                }

                setTimeout(() => {
                    if (this.isNudgeActive) {
                        this.applyPlaybackRate(1.0);
                        this.isNudgeActive = false;
                    }
                }, 1800);
            }
        } else {
            // Hard Seek Alignment (> 600ms)
            console.log(`[LISTEN_TOGETHER_DRIFT] Large drift (${this.currentDriftMs}ms) -> Seeking to ${expectedHostPos.toFixed(2)}s`);
            if (this.isNudgeActive) {
                this.applyPlaybackRate(1.0);
                this.isNudgeActive = false;
            }
            if (Capacitor.isNativePlatform() && window.player?.nativeInitialized) {
                NativeAudio.seek({ audioId: 'main', timeInSeconds: Math.round(expectedHostPos) }).catch(() => {});
            } else if (window.player?.audio) {
                window.player.audio.currentTime = expectedHostPos;
            }
        }
    }

    applyPlaybackRate(rate) {
        if (Capacitor.isNativePlatform() && window.player?.nativeInitialized) {
            try {
                NativeAudio.setRate({ audioId: 'main', rate });
            } catch(e) {}
        } else if (window.player?.audio) {
            try {
                window.player.audio.playbackRate = rate;
            } catch(e) {}
        }
    }

    // --- UI Drawer & Badges ---

    openSyncDrawer() {
        this.bindUI();
        const drawer = document.getElementById('drawer-sync');
        if (drawer) {
            drawer.classList.add('active');
            this.renderDrawerUI();
        }
    }

    closeSyncDrawer() {
        const drawer = document.getElementById('drawer-sync');
        if (drawer) {
            drawer.classList.remove('active');
        }
    }

    updateNowPlayingBadge() {
        const badge = document.getElementById('np-sync-badge');
        if (this.isInRoom()) {
            if (badge) {
                badge.style.display = 'inline-flex';
                badge.textContent = this.role === SyncRole.HOST ? '👑 Host' : '🎧 Synced';
            }
            const btn = document.getElementById('np-btn-sync');
            if (btn) btn.classList.add('active-sync');
        } else {
            if (badge) badge.style.display = 'none';
            const btn = document.getElementById('np-btn-sync');
            if (btn) btn.classList.remove('active-sync');
        }
    }

    renderDrawerUI() {
        const notInRoomSection = document.getElementById('sync-not-in-room-section');
        const inRoomSection = document.getElementById('sync-in-room-section');
        const statusLabel = document.getElementById('sync-status-label');
        const roomCodeDisplay = document.getElementById('sync-display-room-code');
        const roleBadge = document.getElementById('sync-role-badge');
        const statusPill = document.getElementById('sync-status-pill');
        const statRtt = document.getElementById('sync-stat-rtt');
        const statDrift = document.getElementById('sync-stat-drift');
        const statOffset = document.getElementById('sync-stat-offset');

        if (!statusLabel) return;

        if (this.isInRoom()) {
            if (notInRoomSection) notInRoomSection.style.display = 'none';
            if (inRoomSection) inRoomSection.style.display = 'block';

            if (roomCodeDisplay) roomCodeDisplay.textContent = this.roomCode || '------';
            if (roleBadge) {
                roleBadge.textContent = this.role === SyncRole.HOST ? 'HOST (Controls Audio)' : 'RECEIVER (Synced)';
                roleBadge.className = `sync-role-badge ${this.role}`;
            }

            let statusText = 'Connected';
            let pillClass = 'status-green';

            if (this.state === SyncState.CONNECTING) {
                statusText = 'Connecting...';
                pillClass = 'status-yellow';
            } else if (this.state === SyncState.WAITING) {
                statusText = 'Waiting for friend to join...';
                pillClass = 'status-orange';
            } else if (this.state === SyncState.BUFFERING) {
                statusText = 'Preparing audio...';
                pillClass = 'status-blue';
            } else if (this.state === SyncState.RECONNECTING) {
                statusText = 'Reconnecting...';
                pillClass = 'status-yellow';
            } else if (this.state === SyncState.READY) {
                const absDrift = Math.abs(this.currentDriftMs);
                if (absDrift < 120) {
                    statusText = 'In Sync (< 120ms drift)';
                    pillClass = 'status-green';
                } else if (absDrift <= 600) {
                    statusText = `Aligning (${absDrift}ms drift)`;
                    pillClass = 'status-yellow';
                } else {
                    statusText = `Resyncing (${absDrift}ms drift)`;
                    pillClass = 'status-orange';
                }
            }

            statusLabel.textContent = statusText;
            if (statusPill) {
                statusPill.textContent = statusText;
                statusPill.className = `sync-status-pill ${pillClass}`;
            }

            if (statRtt) statRtt.textContent = `${this.clockSync.rtt} ms`;
            if (statDrift) statDrift.textContent = `${this.currentDriftMs >= 0 ? '+' : ''}${this.currentDriftMs} ms`;
            if (statOffset) statOffset.textContent = `${this.clockSync.clockOffset >= 0 ? '+' : ''}${this.clockSync.clockOffset} ms`;

        } else {
            if (notInRoomSection) notInRoomSection.style.display = 'block';
            if (inRoomSection) inRoomSection.style.display = 'none';
            statusLabel.textContent = 'Co-listen in real-time with a friend';
        }

        if (window.lucide?.createIcons) {
            try { window.lucide.createIcons(); } catch(e) {}
        }
    }
}

// Global Singleton Instance
window.syncManager = new SyncManager();
