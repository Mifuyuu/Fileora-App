require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const { Client, GatewayIntentBits, Events, Partials } = require('discord.js');
const line = require('@line/bot-sdk');
const WebSocket = require('ws');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);
app.use(cors());

// Serve frontend files and uploaded files
app.use(express.static(path.join(__dirname, 'frontend')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Rate limiter
const limiter = rateLimit({ windowMs: 60000, max: 60 });
app.use(limiter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Config env
const VIRUSTOTAL_API_KEY = process.env.VIRUSTOTAL_API_KEY;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// Data Structures
const sessions = {};
// sessions[sessionID] = {
//   key,
//   createdAt,
//   lastActivity,
//   files: [{filename, originalname, uploadedAt}],
//   expireSessionAt,
//   expireKeyAt,
//   senderInfo: [] (for discord/line info)
// }
const keyToSession = {};
const wsClients = {}; // sessionID => ws connection

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const sessionID = req.query.sessionID || 'general';
        if (!sessionID) return cb(new Error('Missing sessionID'), null);
        const dir = path.join(__dirname, 'uploads', sessionID);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Helpers
function generateKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let key = '';
    for (let i = 0; i < 5; i++) {
        key += chars[Math.floor(Math.random() * chars.length)];
    }
    return key;
}

// VirusTotal scan helper
async function scanFileWithVirusTotal(filePath, fileName) {
    try {
        const form = new FormData();
        form.append('file', fs.createReadStream(filePath), fileName);
        const uploadRes = await axios.post(
            'https://www.virustotal.com/api/v3/files',
            form,
            { headers: { 'x-apikey': VIRUSTOTAL_API_KEY, ...form.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity }
        );
        const analysisId = uploadRes.data.data.id;

        // wait 15s for scan to complete
        await new Promise(r => setTimeout(r, 15000));

        const analysisRes = await axios.get(`https://www.virustotal.com/api/v3/analyses/${analysisId}`, {
            headers: { 'x-apikey': VIRUSTOTAL_API_KEY }
        });
        const stats = analysisRes.data.data.attributes.stats;
        return stats.malicious === 0;
    } catch (e) {
        console.error('VirusTotal scan error:', e.response?.data || e.message || e);
        // Fail safe: block upload if error
        return false;
    }
}

// === API ===

// สร้าง session + key + QR code
app.get('/api/session', async (req, res) => {
    try {
        const sessionID = uuidv4();
        const key = generateKey();
        const now = Date.now();

        sessions[sessionID] = {
            key,
            createdAt: now,
            lastActivity: now,
            files: [],
            expireSessionAt: now + 5 * 60 * 1000,
            expireKeyAt: now + 10 * 60 * 1000,
            senderInfo: []
        };
        keyToSession[key] = sessionID;

        const url = `${req.protocol}://${req.get('host')}/upload.html?sessionID=${sessionID}`;
        const qr = await QRCode.toDataURL(url);

        res.json({ sessionID, key, qr });
    } catch (e) {
        res.status(500).json({ error: 'Failed to create session' });
    }
});

// Upload API (web or mobile upload from upload.html)
app.post('/api/upload', upload.single('file'), async (req, res) => {
    const { sessionID, sender } = req.body;
    const finalSessionID = req.query.sessionID || sessionID;

    if (!finalSessionID) return res.status(400).json({ error: 'Missing sessionID' });
    const session = sessions[finalSessionID];

    if (!sessionID) return res.status(400).json({ error: 'Missing sessionID' });
    if (!sessions[sessionID]) return res.status(404).json({ error: 'Session expired or not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    if (session.files.length > 0) {
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: 'This session has already uploaded a file. Please create a new session.' });
    }

    try {
        const isClean = await scanFileWithVirusTotal(req.file.path, req.file.originalname);
        if (!isClean) {
            fs.unlinkSync(req.file.path);
            if (sender?.context?.type === 'discord') sender.context.message.reply('❌ Upload failed: Virus detected.');
            if (sender?.context?.type === 'line') {
                const { replyToken } = sender.context;
                lineClient.replyMessage(replyToken, [{ type: 'text', text: '❌ Upload failed: Virus detected.' }]);
            }
            return res.status(400).json({ error: 'File flagged by virus scanner' });
        }

        // Save file info to session
        const session = sessions[sessionID];
        session.files.push({ filename: req.file.filename, originalname: req.file.originalname, uploadedAt: Date.now() });
        session.lastActivity = Date.now();
        if (sender) session.senderInfo.push(sender);

        // Notify websocket clients
        const ws = wsClients[sessionID];
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'FILE_UPLOADED',
                data: {
                    filename: req.file.filename,
                    originalname: req.file.originalname,
                    sender: sender?.sender || 'Unknown',
                    key: session.key,
                    downloadUrl: `/uploads/${sessionID}/${req.file.filename}`
                }
            }));
        }

        // Reply Discord or LINE if applicable
        if (sender?.context?.type === 'discord') sender.context.message.reply(`✅ Upload successful!\nKey to search: ${session.key}\nExpired in 10min`);
        if (sender?.context?.type === 'line') {
            lineClient.replyMessage(sender.context.replyToken, [{ type: 'text', text: `✅ Upload successful!\nKey to search: ${session.key}\nExpired in 10min` }]);
        }

        res.json({ success: true, key: session.key });
    } catch (e) {
        console.error('Upload error:', e);
        if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Upload or scan failed' });
    }
});

// Search files by key
app.get('/api/search/:key', (req, res) => {
    const key = req.params.key.toUpperCase();
    const sessionID = keyToSession[key];
    if (!sessionID || !sessions[sessionID]) return res.status(404).json({ error: 'Key not found or expired' });

    const session = sessions[sessionID];
    const now = Date.now();

    // Filter files within 10 min expiration
    const validFiles = session.files.filter(f => now - f.uploadedAt <= 10 * 60 * 1000);
    const filesUrls = validFiles.map(f => `/uploads/${sessionID}/${f.filename}`);

    res.json({ sessionID, files: filesUrls });
});

// LINE webhook
const lineClient = new line.Client({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });

app.post('/line-webhook', line.middleware(lineClient.config), async (req, res) => {
    const events = req.body.events;
    for (const event of events) {
        if (event.type === 'message' && (event.message.type === 'image' || event.message.type === 'file')) {
            try {
                const messageId = event.message.id;
                const stream = await lineClient.getMessageContent(messageId);
                const ext = event.message.fileName ? path.extname(event.message.fileName) : '.jpg';
                const filename = Date.now() + ext;
                const userSessionID = `line-${event.source.userId}`;
                const dir = path.join(__dirname, 'uploads', userSessionID);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const filepath = path.join(dir, filename);
                const writer = fs.createWriteStream(filepath);
                stream.pipe(writer);

                writer.on('finish', async () => {
                    // Push to upload queue for VirusTotal scanning + WebSocket notify
                    // We simulate "sender" for line here
                    try {
                        // VirusTotal scan
                        const isClean = await scanFileWithVirusTotal(filepath, filename);
                        if (!isClean) {
                            fs.unlinkSync(filepath);
                            await lineClient.replyMessage(event.replyToken, [{ type: 'text', text: '❌ Upload failed: Virus detected.' }]);
                            return;
                        }

                        sessions[userSessionID] = sessions[userSessionID] || {
                            key: generateKey(),
                            createdAt: Date.now(),
                            lastActivity: Date.now(),
                            files: [],
                            expireSessionAt: Date.now() + 5 * 60 * 1000,
                            expireKeyAt: Date.now() + 10 * 60 * 1000,
                            senderInfo: []
                        };

                        const session = sessions[userSessionID];
                        session.files.push({ filename, originalname: filename, uploadedAt: Date.now() });
                        session.lastActivity = Date.now();
                        session.senderInfo.push(`LINE: ${event.source.userId}`);

                        keyToSession[session.key] = userSessionID;

                        // Notify websocket if any
                        const ws = wsClients[userSessionID];
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'FILE_UPLOADED',
                                data: {
                                    filename,
                                    originalname: filename,
                                    sender: `LINE: ${event.source.userId}`,
                                    key: session.key,
                                    downloadUrl: `/uploads/${userSessionID}/${filename}`
                                }
                            }));
                        }

                        // Reply LINE with key
                        await lineClient.replyMessage(event.replyToken, [{
                            type: 'text',
                            text: `✅ Upload Successful!\nKey to Search: ${session.key}\nExpired in 10min`
                        }]);
                    } catch (e) {
                        console.error(e);
                        await lineClient.replyMessage(event.replyToken, [{ type: 'text', text: '❌ Upload failed due to error.' }]);
                    }
                });
            } catch (e) {
                console.error('LINE message error', e);
            }
        }
    }
    res.sendStatus(200);
});

// Discord Bot Setup
const discordClient = new Client({
    intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel]
});

discordClient.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    if (message.channel.type !== 1) return; // DM only
    if (message.attachments.size === 0) return;

    const userSessionID = `discord-${message.author.id}`;
    sessions[userSessionID] = sessions[userSessionID] || {
        key: generateKey(),
        createdAt: Date.now(),
        lastActivity: Date.now(),
        files: [],
        expireSessionAt: Date.now() + 5 * 60 * 1000,
        expireKeyAt: Date.now() + 10 * 60 * 1000,
        senderInfo: []
    };

    for (const [, attachment] of message.attachments) {
        try {
            const url = attachment.url;
            const filename = attachment.name;
            const uploadPath = path.join(__dirname, 'uploads', userSessionID);
            if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
            const filepath = path.join(uploadPath, Date.now() + '-' + filename);

            const writer = fs.createWriteStream(filepath);
            const response = await axios({ url, method: 'GET', responseType: 'stream' });
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            // VirusTotal scan
            const isClean = await scanFileWithVirusTotal(filepath, filename);
            if (!isClean) {
                fs.unlinkSync(filepath);
                await message.reply('❌ Upload failed: Virus detected.');
                return;
            }

            const session = sessions[userSessionID];
            session.files.push({ filename: path.basename(filepath), originalname: filename, uploadedAt: Date.now() });
            session.lastActivity = Date.now();
            session.senderInfo.push(`Discord: ${message.author.tag}`);

            keyToSession[session.key] = userSessionID;

            // Notify WebSocket
            const ws = wsClients[userSessionID];
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'FILE_UPLOADED',
                    data: {
                        filename: path.basename(filepath),
                        originalname: filename,
                        sender: `Discord: ${message.author.tag}`,
                        key: session.key,
                        downloadUrl: `/uploads/${userSessionID}/${path.basename(filepath)}`
                    }
                }));
            }

            await message.reply(`✅ Upload successful!\nKey to search: ${session.key}\nExpired in 10min`);
        } catch (e) {
            console.error('Discord upload error:', e);
            await message.reply('❌ Upload failed due to error.');
        }
    }
});

discordClient.login(DISCORD_BOT_TOKEN);

// Cleanup expired sessions and files every minute
cron.schedule('* * * * *', () => {
    const now = Date.now();
    for (const sessionID in sessions) {
        const session = sessions[sessionID];

        // Remove files older than 10 minutes
        session.files = session.files.filter(f => now - f.uploadedAt <= 10 * 60 * 1000);

        // Remove session expired after 5 minutes
        if (now > session.expireSessionAt) {
            const dir = path.join(__dirname, 'uploads', sessionID);
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

            delete keyToSession[session.key];
            delete sessions[sessionID];

            if (wsClients[sessionID]) {
                wsClients[sessionID].close();
                delete wsClients[sessionID];
            }

            console.log(`Session ${sessionID} expired and cleaned`);
        }
    }
});

// WebSocket Server
const server = app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
    ws.on('message', msg => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'REGISTER_SESSION' && data.sessionID) {
                wsClients[data.sessionID] = ws;
                console.log(`WebSocket registered for session: ${data.sessionID}`);
            }
        } catch { }
    });

    ws.on('close', () => {
        for (const sessionID in wsClients) {
            if (wsClients[sessionID] === ws) {
                delete wsClients[sessionID];
                console.log(`WebSocket disconnected for session: ${sessionID}`);
            }
        }
    });
});
