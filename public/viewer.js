// viewer.js
const socket = io();
const video = document.getElementById('remoteVideo');
const info = document.getElementById('info');
const recordingInfo = document.getElementById('recordingInfo');

// Derive the intended username from the /view/<username>.html path so the
// backend can enforce that only that viewer URL receives the live stream.
function getPageUsername() {
    try {
        const m = window.location.pathname.match(/\/view\/([^/.]+)\.html/i);
        if (!m || !m[1]) return '';
        return decodeURIComponent(m[1]).trim();
    } catch {
        return '';
    }
}

const PAGE_USERNAME = getPageUsername();

let pc = null;
// camera overlay removed from view.html; we ignore camera tracks now
let screenMedia = null;
let cameraMedia = null;

socket.on('connect', () => {
    // Ask to watch the broadcaster for this specific username (if any).
    if (PAGE_USERNAME) {
        socket.emit('watcher', { username: PAGE_USERNAME });
    } else {
        socket.emit('watcher', { username: '' });
    }
    info.innerText = 'Connecting to broadcaster...';
    recordingInfo.textContent = '';
});

socket.on('no-broadcaster', () => {
    if (PAGE_USERNAME) {
        info.innerText = `No live session is currently available for "${PAGE_USERNAME}".`;
    } else {
        info.innerText = 'No broadcaster is currently streaming.';
    }
    recordingInfo.textContent = '';
});

socket.on('offer', async (broadcasterId, description) => {
    pc = new RTCPeerConnection();

    pc.ontrack = event => {
        const track = event.track;
        if (track.kind === 'video') {
            const hint = (track.contentHint || '').toLowerCase();
            if (hint === 'camera') {
                // ignore camera track in backend viewer
                return;
            }
            // Fallback when no hint: first video -> screen, second -> camera
            if (!screenMedia || !video.srcObject) {
                // Prefer using the provided MediaStream directly if available
                const [incomingStream] = event.streams || [];
                if (incomingStream) {
                    screenMedia = incomingStream;
                    video.srcObject = incomingStream;
                } else {
                    if (!screenMedia) screenMedia = new MediaStream();
                    screenMedia.addTrack(track);
                    video.srcObject = screenMedia;
                }
                // Start playback safely under autoplay policies
                try {
                    if (video.readyState >= 1) { video.muted = true; video.play().catch(()=>{}); }
                    else {
                        video.onloadedmetadata = () => { try { video.muted = true; video.play().catch(()=>{}); } catch{} };
                    }
                } catch {}
            } else {
                // if a second video track arrives (camera), ignore it
            }
        } else if (track.kind === 'audio') {
            // Attach audio tracks to the primary (screen) stream so the main video element plays audio
            if (!screenMedia) screenMedia = new MediaStream();
            screenMedia.addTrack(track);
            if (video.srcObject !== screenMedia) {
                video.srcObject = screenMedia;
                try {
                    if (video.readyState >= 1) { video.muted = true; video.play().catch(()=>{}); }
                    else { video.onloadedmetadata = () => { try { video.muted = true; video.play().catch(()=>{}); } catch{} }; }
                } catch {}
            }
        }
    };

    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('candidate', broadcasterId, event.candidate);
        }
    };

    await pc.setRemoteDescription(description);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', broadcasterId, pc.localDescription);
    info.innerText = 'Connected to broadcaster.';
    recordingInfo.textContent = '';
});

socket.on('candidate', (id, candidate) => {
    if (pc) pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
});

socket.on('broadcaster-stopped', () => {
    info.innerText = 'Broadcast stopped by broadcaster.';
    if (pc) {
        pc.close();
        pc = null;
    }
    recordingInfo.textContent = 'If a recording was saved, the link will appear here shortly.';
    screenMedia = null;
    cameraMedia = null;
    // no camera overlay to clean up
});

socket.on('recording-ready', (payload) => {
    info.innerText = 'Broadcast finished.';
    const screenUrl = payload.screenUrl || payload.fileUrl || null;
    if (!screenUrl) {
        recordingInfo.textContent = 'Broadcast ended without a saved recording.';
        return;
    }
    const a = document.createElement('a');
    a.href = screenUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Screen recording';
    recordingInfo.textContent = '';
    recordingInfo.appendChild(a);
});

// Fallback: if autoplay was blocked, allow user to click anywhere to start playback muted
document.addEventListener('click', () => {
    const tryPlay = () => {
        if (!video) return;
        if (!video.srcObject) return;
        if (!video.paused) return;
        try { video.muted = true; video.play().catch(()=>{}); } catch {}
    };
    // try immediately
    tryPlay();
    // and once more shortly after, in case stream arrives a bit later
    setTimeout(tryPlay, 500);
}, { once: true });