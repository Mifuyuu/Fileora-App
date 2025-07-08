require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cron = require('node-cron');
const { Client, GatewayIntentBits, Events, Partials } = require('discord.js');
const line = require('@line/bot-sdk');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const crypto = require('crypto');
const Session = require('./models/Session');

// --- SETUP ---
const app = express();
const PORT = process.env.PORT || 3001;

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB Connected...'))
    .catch(err => console.error('MongoDB Connection Error:', err));

// --- MIDDLEWARE ---
app.set('trust proxy', 1);
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
// app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CONFIG & CONSTANTS ---
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

const FORBIDDEN_EXTENSIONS = [
    '.exe', '.bat', '.cmd', '.sh', '.msi', '.vbs', '.js', '.jar', '.scr', '.pif',
    '.dll', '.com', '.ps1', '.psm1', '.reg', '.cpl'
];

// --- DATA STRUCTURES ---
const wsClients = {};

// --- MULTER STORAGE & FILTER ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const sessionId = req.query.sessionId;
        if (!sessionId) return cb(new Error('Missing sessionId in URL query'), null);
        const dir = path.join(__dirname, 'uploads', sessionId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, uuidv4())
});

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (FORBIDDEN_EXTENSIONS.includes(ext)) {
        cb(new Error(`File type not allowed: ${ext}`), false);
    } else {
        cb(null, true);
    }
};

const upload = multer({ 
    storage, 
    fileFilter, 
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// --- HELPER FUNCTIONS ---

function generateAccessKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let key = '';
    for (let i = 0; i < 5; i++) key += chars.charAt(Math.floor(Math.random() * chars.length));
    return key;
}

async function processAndSaveFile(stream, originalname, sessionId, encryptionKey, sender) {
    const ext = path.extname(originalname).toLowerCase();
    if (FORBIDDEN_EXTENSIONS.includes(ext)) {
        throw new Error(`File type not allowed: ${ext}`);
    }

    const dir = path.join(__dirname, 'uploads', sessionId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tempFilePath = path.join(dir, uuidv4());
    const writer = fs.createWriteStream(tempFilePath);
    
    try {
        await new Promise((resolve, reject) => {
            stream.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const encKeyBuffer = Buffer.from(encryptionKey, 'hex');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, encKeyBuffer, iv);
        const encryptedFilename = uuidv4() + '.enc';
        const encryptedFilePath = path.join(dir, encryptedFilename);
        
        const readStream = fs.createReadStream(tempFilePath);
        const writeStream = fs.createWriteStream(encryptedFilePath);
        await new Promise((resolve, reject) => {
            readStream.pipe(cipher).pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });

        const authTag = cipher.getAuthTag().toString('hex');
        fs.unlinkSync(tempFilePath);

        return {
            filename: encryptedFilename,
            originalname,
            iv: iv.toString('hex'),
            authTag,
            sender
        };
    } catch (error) {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        throw error;
    }
}

// --- API ENDPOINTS ---

app.get('/api/session', async (req, res) => {
    try {
        const sessionId = uuidv4();
        const accessKey = generateAccessKey();
        const encryptionKey = crypto.createHash('sha256').update(sessionId + ENCRYPTION_SECRET).digest('hex');
        
        await new Session({
            sessionId,
            accessKey,
            encryptionKey: Buffer.from(encryptionKey, 'hex').toString('hex'),
        }).save();
        const uploadUrl = `${req.protocol}://${req.get('host')}/upload?sessionId=${sessionId}`;
        const qr = await QRCode.toDataURL(uploadUrl);
        res.json({ sessionId, key: accessKey, qr });
    } catch (error) {
        console.error('Session creation error:', error);
        res.status(500).json({ error: 'Failed to create session' });
    }
});

app.post('/api/upload', (req, res) => {
    const uploader = upload.single('file');
    uploader(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        
        const { sessionId } = req.query;
        if (!req.file) {
            return res.status(400).json({ error: 'No file was uploaded.' });
        }

        try {
            const session = await Session.findOne({ sessionId });
            if (!session) {
                throw new Error("Session not found");
            }
            if (session.files.length > 0) {
                return res.status(403).json({ error: 'This session has already been used.' });
            }

            const tempFilePath = req.file.path;
            const encKeyBuffer = Buffer.from(session.encryptionKey, 'hex');
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, encKeyBuffer, iv);
            const encryptedFilename = uuidv4() + '.enc';
            const encryptedFilePath = path.join(req.file.destination, encryptedFilename);

            const readStream = fs.createReadStream(tempFilePath);
            const writeStream = fs.createWriteStream(encryptedFilePath);
            await new Promise((resolve, reject) => {
                readStream.pipe(cipher).pipe(writeStream);
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });
            const authTag = cipher.getAuthTag().toString('hex');
            fs.unlinkSync(tempFilePath);

            const fileData = {
                filename: encryptedFilename,
                originalname: req.file.originalname,
                iv: iv.toString('hex'),
                authTag,
                sender: { platform: 'Web', name: 'Web User' }
            };

            session.files.push(fileData);
            await session.save();

            if (wsClients[sessionId]) {
                wsClients[sessionId].send(JSON.stringify({ type: 'FILE_UPLOADED' }));
            }
            res.json({ success: true, message: 'File uploaded and encrypted.' });
        } catch (error) {
            console.error(`[Web] Upload processing error:`, error);
            if(req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            res.status(500).json({ error: error.message || 'Internal server error.' });
        }
    });
});

app.get('/api/search/:key', async (req, res) => {
    const accessKey = req.params.key.toUpperCase();
    const session = await Session.findOne({ accessKey });
    if (!session) return res.status(404).json({ error: 'Key not found or expired.' });
    
    const files = session.files.map(f => ({
        originalname: f.originalname,
        sender: f.sender,
        downloadUrl: `/api/download/${session.sessionId}/${f.filename}`
    }));
    res.json({ files });
});

app.get('/api/download/:sessionId/:filename', async (req, res) => {
    const { sessionId, filename } = req.params;
    const providedKey = (req.headers['x-access-key'] || '').toUpperCase();

    try {
        const session = await Session.findOne({ sessionId });
        if (!session) return res.status(404).send('Session or file expired.');

        if (session.accessKey !== providedKey) {
            return res.status(403).send('Access denied: Invalid or missing access key.');
        }

        const fileInfo = session.files.find(f => f.filename === filename);
        if (!fileInfo) return res.status(404).send('File not found in session.');

        const filePath = path.join(__dirname, 'uploads', sessionId, filename);
        if (!fs.existsSync(filePath)) return res.status(404).send('File not found on disk.');

        const encryptionKey = Buffer.from(session.encryptionKey, 'hex');
        const iv = Buffer.from(fileInfo.iv, 'hex');
        const authTag = Buffer.from(fileInfo.authTag, 'hex');
        const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, encryptionKey, iv);
        decipher.setAuthTag(authTag);

        res.setHeader('Content-Disposition', `attachment; filename="${fileInfo.originalname}"`);
        fs.createReadStream(filePath).pipe(decipher).pipe(res);
    } catch (error) {
        console.error('Decryption error:', error);
        res.status(500).send('Could not decrypt or download the file.');
    }
});


// --- PLATFORM INTEGRATIONS ---
const lineRawMiddleware = express.raw({ type: '*/*' });
const lineClient = new line.Client({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });

app.post('/line-webhook', lineRawMiddleware, line.middleware(lineClient.config), async (req, res) => {
    try {
        for (const event of req.body.events) {
            if (event.type === 'message' && ['image', 'file', 'video', 'audio'].includes(event.message.type)) {
                const messageId = event.message.id;
                const profile = await lineClient.getProfile(event.source.userId);
                const stream = await lineClient.getMessageContent(messageId);

                // 🔍 ตรวจประเภทไฟล์จาก Content-Type ของ response
                const contentType = stream.headers['content-type'];
                const getExtension = (type) => {
                    const map = {
                        'image/jpeg': '.jpg',
                        'image/png': '.png',
                        'image/gif': '.gif',
                        'video/mp4': '.mp4',
                        'audio/mpeg': '.mp3',
                        'audio/mp4': '.m4a',
                        'application/pdf': '.pdf',
                    };
                    return map[type] || '.bin';
                };
                const ext = getExtension(contentType);

                const originalname = event.message.fileName || `line_${messageId}${ext}`;
                const sessionId = `line-${event.source.userId}-${Date.now()}`;
                const encryptionKey = crypto.createHash('sha256').update(sessionId + ENCRYPTION_SECRET).digest('hex');

                try {
                    const fileData = await processAndSaveFile(
                        stream,
                        originalname,
                        sessionId,
                        encryptionKey,
                        { platform: 'LINE', name: profile.displayName }
                    );
                    const accessKey = generateAccessKey();
                    await new Session({ sessionId, accessKey, encryptionKey, files: [fileData] }).save();

                    await lineClient.replyMessage(event.replyToken, {
                        type: 'text',
                        text: `✅ Upload successful! Your key is: ${accessKey}`
                    });
                } catch (err) {
                    console.error('LINE file processing error:', err);
                    await lineClient.replyMessage(event.replyToken, {
                        type: 'text',
                        text: `❌ Upload failed: ${err.message}`
                    });
                }
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('LINE Webhook Error:', error.originalError?.response?.data || error);
        res.sendStatus(500);
    }
});


const discordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel]
});
discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || message.channel.type !== 1 || message.attachments.size === 0) return;

    for (const [, attachment] of message.attachments) {
        const sessionId = `discord-${message.author.id}-${Date.now()}`;
        const encryptionKey = crypto.createHash('sha256').update(sessionId + ENCRYPTION_SECRET).digest('hex');
        
        try {
            const response = await axios({ url: attachment.url, method: 'GET', responseType: 'stream' });
            const fileData = await processAndSaveFile(
                response.data,
                attachment.name,
                sessionId,
                encryptionKey,
                { platform: 'Discord', name: message.author.tag }
            );
            const accessKey = generateAccessKey();
            await new Session({ sessionId, accessKey, encryptionKey, files: [fileData] }).save();
            await message.reply(`✅ Upload successful! Your key is: ${accessKey}`);
        } catch (error) {
            console.error('Discord attachment processing error:', error);
            await message.reply(`❌ Failed to process your attachment: ${error.message}`);
        }
    }
});
discordClient.login(DISCORD_BOT_TOKEN);

// --- PERIODIC CLEANUP ---
// cron.schedule('0 */1 * * *', () => { // 1 hour cleanup
cron.schedule('*/5 * * * *', () => { // every 5 minutes cleanup
    console.log('Running scheduled cleanup for orphaned folders (every 5 minutes)...');
    const uploadsDir = path.join(__dirname, 'uploads');
    fs.readdir(uploadsDir, (err, sessionDirs) => {
        if (err) return console.error('Failed to read uploads directory for cleanup:', err);
        sessionDirs.forEach(async (sessionId) => {
            const session = await Session.findOne({ sessionId });
            if (!session) {
                const dirPath = path.join(uploadsDir, sessionId);
                fs.rm(dirPath, { recursive: true, force: true }, (rmErr) => {
                    if (rmErr) console.error(`Failed to delete orphaned directory: ${dirPath}`, rmErr);
                    else console.log(`Cleaned up orphaned directory: ${sessionId}`);
                });
            }
        });
    });
});

// --- WEBSOCKET SERVER ---
const server = app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
    let associatedSessionId = null;
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'REGISTER_SESSION' && data.sessionId) {
                associatedSessionId = data.sessionId;
                wsClients[data.sessionId] = ws;
                console.log(`WebSocket registered for session: ${data.sessionId}`);
            }
        } catch (e) { console.warn('Received invalid WebSocket message'); }
    });
    ws.on('close', () => {
        if (associatedSessionId && wsClients[associatedSessionId] === ws) {
            delete wsClients[associatedSessionId];
            console.log(`WebSocket disconnected for session: ${associatedSessionId}`);
        }
    });
});