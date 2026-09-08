// server.js
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');
const { exec, spawn } = require('child_process');
const crypto = require('crypto');
const { Server } = require('socket.io');

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'OPTIONS'],
    },
});

const recordingsDir = path.join(__dirname, 'recordings');
const screenDir = path.join(recordingsDir, 'screen');
[recordingsDir, screenDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function createJobId() {
    try {
        return crypto.randomUUID();
    } catch {
        return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
}

function startConversionJob(jobId, inputPath, outputDir, webmUrl) {
    const parsed = path.parse(inputPath);
    const mp4Name = parsed.name + '.mp4';
    const mp4Path = path.join(outputDir, mp4Name);
    const mp4Url = webmUrl.replace(/\.webm$/i, '.mp4');

    const job = {
        jobId,
        status: 'processing',
        progress: 0,
        webmUrl,
        mp4Url: null,
        error: null,
    };
    conversionJobs.set(jobId, job);

    const ffprobeCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`;

    exec(ffprobeCmd, (probeErr, stdout) => {
        let duration = 0;
        if (!probeErr) {
            const d = parseFloat(String(stdout).trim());
            if (!Number.isNaN(d) && d > 0) duration = d;
        }

        const args = [
            '-y',
            '-i', inputPath,
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            '-progress', 'pipe:1',
            '-nostats',
            mp4Path,
        ];

        const ff = spawn('C:\\Users\\Admin\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe', args, { shell: true });

        ff.on('error', (err) => {
            console.error('ffmpeg spawn error:', err);
            const current = conversionJobs.get(jobId);
            if (current) {
                current.status = 'failed';
                current.error = `Failed to spawn ffmpeg: ${err.message}`;
            }
        });

        ff.stdout.on('data', (data) => {
            try {
                const lines = String(data).split(/\r?\n/);
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('out_time_ms=')) continue;
                    const val = trimmed.split('=')[1];
                    const ms = parseFloat(val) || 0;
                    const seconds = ms / 1_000_000;
                    if (duration > 0) {
                        const pct = Math.max(0, Math.min(100, Math.round((seconds / duration) * 100)));
                        const current = conversionJobs.get(jobId);
                        if (current && current.status === 'processing') {
                            current.progress = pct;
                        }
                    }
                }
            } catch (err) {
                console.error('Error parsing ffmpeg progress:', err);
            }
        });

        ff.stderr.on('data', (data) => {
            console.error(`ffmpeg stderr: ${String(data)}`);
            // ignore noisy stderr; progress comes from stdout
        });

        ff.on('close', (code) => {
            const current = conversionJobs.get(jobId);
            if (!current) return;

            if (code === 0) {
                current.status = 'done';
                current.progress = 100;
                current.mp4Url = mp4Url;
                try {
                    if (fs.existsSync(inputPath)) {
                        fs.unlinkSync(inputPath);
                    }
                } catch (err) {
                    console.error('Failed to delete original webm after conversion:', err);
                }
            } else {
                current.status = 'failed';
                current.error = `ffmpeg exited with code ${code}`;
            }
        });
    });
}

const conversionJobs = new Map();

const screenStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const rawUsername = req.body && req.body.username ? String(req.body.username) : '';
        const safeUsername = rawUsername.toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'user';
        const rawQuizId = req.body && req.body.quizId ? String(req.body.quizId) : '';
        const safeQuizId = rawQuizId.toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'default-quiz';

        const destDir = path.join(screenDir, safeUsername, safeQuizId);
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        cb(null, destDir);
    },
    filename: (req, file, cb) => {
        const originalExtension = path.extname(file.originalname) || '.webm';
        const safeExtension = originalExtension.slice(0, 10) || '.webm';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const rawQuestionId = req.body && req.body.questionId ? String(req.body.questionId) : '';
        const safeQuestionId = rawQuestionId.toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'q-unknown';
        cb(null, `question-${safeQuestionId}-${timestamp}${safeExtension}`);
    },
});

const uploadScreen = multer({ storage: screenStorage });
const chunkDiskStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const destDir = path.join(recordingsDir, 'temp_chunks');
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        cb(null, destDir);
    },
    filename: (req, file, cb) => {
        cb(null, `chunk-${Date.now()}-${Math.random().toString(36).substring(2)}.webm`);
    }
});
const uploadScreenChunk = multer({ storage: chunkDiskStorage });

const chunkSessions = new Map();

app.use(cors({ origin: '*' }));
app.use(express.static('public'));
app.get('/view/:username.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'view.html'));
});

app.get('/recordings/screen/*', (req, res, next) => {
    try {
        const relativePath = req.params[0];
        if (!relativePath || !relativePath.toLowerCase().endsWith('.webm')) return next();

        const mp4RelativePath = relativePath.replace(/\.webm$/i, '.mp4');
        const mp4Path = path.join(screenDir, mp4RelativePath);
        const mp4Url = `/recordings/screen/${mp4RelativePath}`;

        let isProcessing = false;
        for (const job of conversionJobs.values()) {
            if (job && job.mp4Url === mp4Url && job.status === 'processing') {
                isProcessing = true;
                break;
            }
        }

        if (fs.existsSync(mp4Path) && !isProcessing) {
            return res.redirect(mp4Url);
        }
        return next();
    } catch {
        return next();
    }
});
app.use('/recordings', express.static(recordingsDir));
app.use('/recordings/screen', express.static(screenDir));
// no camera static path; broadcaster is served from separate static frontend

app.get('/api/conversion-status/:jobId', (req, res) => {
    const { jobId } = req.params || {};
    if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

    const job = conversionJobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    return res.json({
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        webmUrl: job.webmUrl,
        mp4Url: job.mp4Url,
        error: job.error,
    });
});

// Separate endpoints for screen and camera recordings
app.post('/api/recordings/screen', uploadScreen.single('recording'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No recording file received' });

        const storedPath = req.file.path;
        const relativePath = path.relative(screenDir, storedPath);
        const webmUrl = `/recordings/screen/${relativePath.replace(/\\/g, '/')}`;
        const jobId = createJobId();

        startConversionJob(jobId, storedPath, path.dirname(storedPath), webmUrl);

        return res.json({
            jobId,
            status: 'processing',
            fileName: req.file.filename,
            fileUrl: webmUrl,
        });
    } catch (err) {
        console.error('Error handling screen upload with async mp4 conversion:', err);
        return res.status(500).json({ error: 'Failed to process recording' });
    }
});

app.post('/api/recordings/screen/chunk', uploadScreenChunk.single('recording'), (req, res) => {
    try {
        const { uploadId, index, isLast } = req.body || {};
        if (!uploadId) {
            return res.status(400).json({ error: 'Missing uploadId' });
        }
        if (!req.file || (!req.file.path && (!req.file.buffer || !req.file.buffer.length))) {
            return res.status(400).json({ error: 'No recording chunk received' });
        }

        let session = chunkSessions.get(uploadId);
        if (!session) {
            const rawUsername = req.body && req.body.username ? String(req.body.username) : '';
            const safeUsername = rawUsername.toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'user';
            const rawQuizId = req.body && req.body.quizId ? String(req.body.quizId) : '';
            const safeQuizId = rawQuizId.toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'default-quiz';
            const rawQuestionId = req.body && req.body.questionId ? String(req.body.questionId) : '';
            const safeQuestionId = rawQuestionId.toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'q-unknown';

            const extension = path.extname(req.file.originalname) || '.webm';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

            const destDir = path.join(screenDir, safeUsername, safeQuizId);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }

            const baseName = `question-${safeQuestionId}-${timestamp}${extension}`;
            const filePath = path.join(destDir, baseName);
            fs.copyFileSync(req.file.path, filePath);
            session = { filePath, fileName: baseName, relativeUrlPath: `${safeUsername}/${safeQuizId}/${baseName}` };
            chunkSessions.set(uploadId, session);
        } else {
            const buffer = fs.readFileSync(req.file.path);
            fs.appendFileSync(session.filePath, buffer);
        }

        try {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        } catch (e) {
            console.error('Failed to delete temp chunk', e);
        }

        const last = String(isLast).toLowerCase() === 'true' || String(isLast) === '1';
        if (last) {
            chunkSessions.delete(uploadId);

            const webmUrl = `/recordings/screen/${session.relativeUrlPath}`;
            const jobId = createJobId();

            startConversionJob(jobId, session.filePath, path.dirname(session.filePath), webmUrl);

            return res.json({
                jobId,
                status: 'processing',
                fileName: session.fileName,
                fileUrl: webmUrl,
            });
        }

        return res.json({ ok: true, uploadId, index: typeof index !== 'undefined' ? Number(index) : null });
    } catch (err) {
        console.error('Error handling screen chunk upload:', err);
        return res.status(500).json({ error: 'Failed to process recording chunk' });
    }
});

// Simple signaling: broadcaster announces itself, watchers ask to view
// Track both the broadcaster socket id and the logical username of the
// broadcaster so that /view/<username>.html only sees the correct stream.
let BROADCASTER_ID = null;
let BROADCASTER_USERNAME = null;

io.on('connection', socket => {
    console.log('Client connected:', socket.id);


    socket.on('broadcaster', (payload) => {
        const username = payload && typeof payload.username === 'string'
            ? payload.username.trim()
            : '';

        BROADCASTER_ID = socket.id;
        BROADCASTER_USERNAME = username || null;

        console.log('Broadcaster is:', BROADCASTER_ID, 'username:', BROADCASTER_USERNAME);

        // Notify viewers that a broadcaster is available, including username
        socket.broadcast.emit('broadcaster', { username: BROADCASTER_USERNAME });
    });


    socket.on('stop-broadcast', () => {
        if (socket.id === BROADCASTER_ID) {
            BROADCASTER_ID = null;
            BROADCASTER_USERNAME = null;
            socket.broadcast.emit('broadcaster-stopped');
            console.log('Broadcaster stopped via stop-broadcast event');
        }
    });


    socket.on('watcher', (payload) => {
        const requestedUsername = payload && typeof payload.username === 'string'
            ? payload.username.trim()
            : '';

        if (!BROADCASTER_ID) {
            console.log('No broadcaster available for watcher', socket.id);
            socket.emit('no-broadcaster');
            return;
        }

        // If we have an associated broadcaster username, enforce that only
        // viewers for that username can connect to the live stream.
        if (!BROADCASTER_USERNAME || !requestedUsername || requestedUsername !== BROADCASTER_USERNAME) {
            console.log('Watcher', socket.id, 'requested username', requestedUsername,
                'but active broadcaster username is', BROADCASTER_USERNAME, '- denying');
            socket.emit('no-broadcaster');
            return;
        }

        console.log('Watcher', socket.id, '-> notify broadcaster', BROADCASTER_ID, 'for username', requestedUsername);
        socket.to(BROADCASTER_ID).emit('watcher', socket.id);
    });


    socket.on('offer', (id, message) => {
        // message is SDP from broadcaster to a watcher
        console.log('offer from broadcaster ->', id);
        socket.to(id).emit('offer', socket.id, message);
    });


    socket.on('answer', (id, message) => {
        // message is SDP from watcher to broadcaster
        console.log('answer from watcher', socket.id, '-> broadcaster', id);
        socket.to(id).emit('answer', socket.id, message);
    });


    socket.on('candidate', (id, message) => {
        socket.to(id).emit('candidate', socket.id, message);
    });


    socket.on('recording-ready', payload => {
        if (socket.id === BROADCASTER_ID) {
            const enriched = {
                ...(payload || {}),
                username: BROADCASTER_USERNAME || null,
            };
            socket.broadcast.emit('recording-ready', enriched);
            console.log('Notified viewers about recording:', enriched);
        }
    });


    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        if (socket.id === BROADCASTER_ID) {
            BROADCASTER_ID = null;
            BROADCASTER_USERNAME = null;
            socket.broadcast.emit('broadcaster-stopped');
            console.log('Broadcaster stopped');
        } else if (BROADCASTER_ID) {
            socket.to(BROADCASTER_ID).emit('disconnectPeer', socket.id);
        }
    });
});



// Retention policy: Delete recordings older than 15 days
const RETENTION_DAYS = 15;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

function cleanupOldRecordings() {
    console.log('Running cleanup of old recordings...');
    fs.readdir(screenDir, (err, files) => {
        if (err) {
            console.error('Failed to read screen directory for cleanup:', err);
            return;
        }

        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(screenDir, file);
            fs.stat(filePath, (err, stats) => {
                if (err) {
                    console.error(`Failed to stat file ${file}:`, err);
                    return;
                }

                if (now - stats.mtimeMs > RETENTION_MS) {
                    fs.unlink(filePath, err => {
                        if (err) console.error(`Failed to delete old recording ${file}:`, err);
                        else console.log(`Deleted old recording: ${file}`);
                    });
                }
            });
        });
    });
}

// Run cleanup periodically (e.g., every 24 hours)
setInterval(cleanupOldRecordings, 24 * 60 * 60 * 1000);
// Also run once on startup
cleanupOldRecordings();

const PORT = process.env.PORT || 2025;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));