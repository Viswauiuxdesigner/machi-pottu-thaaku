# Machi Pottu Thaaku 🎧

A static, purely frontend-based web application for searching, playing, and saving Tamil music offline. Built using the Audius API.

## Features
- **Search**: Search for Tamil songs using the Audius Discovery API.
- **Play**: Stream music directly in the browser with a persistent audio player.
- **Save Offline**: Download downloadable tracks directly into the browser's IndexedDB.
- **Offline Playback**: When the internet is disconnected, play saved tracks directly from IndexedDB without any network request.
- **PWA Ready**: Can be installed as a PWA, with the application shell cached for offline access.

## Architecture & Limitations
- **No Backend**: This app is 100% static HTML, CSS, and Vanilla JavaScript.
- **No Node.js Required**: You don't need npm or build tools to run this.
- **IndexedDB**: Audio files are stored as Blobs in IndexedDB.
- **Browser Limitation**: Because audio is saved in IndexedDB, clearing site data or browser cache will delete the saved music.

## How to Test Locally

1. **Obtain Audius API Key (Optional but recommended)**
   - Open `js/audius.js`
   - Paste your key into `const AUDIO_API_KEY = "";`
   - *Note: Audius V1 discovery API often works without an API key just by using `app_name`, which is pre-configured.*

2. **Run Live Server**
   - Open this directory in VS Code.
   - Install the "Live Server" extension if you haven't.
   - Right-click `index.html` and select "Open with Live Server".
   - It will open at something like `http://127.0.0.1:5500`.

3. **Test Offline Playback (Critical)**
   - While online, search for a track and click the **Save Offline** button on a track row.
   - Wait for the "Saved Offline ✓" notification.
   - Open the "Saved" page from the sidebar to verify it's there.
   - Open Chrome DevTools (F12) -> Network tab -> Change throttling to **Offline**.
   - Refresh the page (F5).
   - Navigate to the "Saved" page and click play. The track should play normally without internet.

## Deployment to Netlify

1. Drag and drop this entire folder into Netlify Drop (https://app.netlify.com/drop).
2. Or connect this repository to Netlify. The `netlify.toml` is pre-configured to serve the static files with no build command (`command = ""`).
3. Your app is live!
