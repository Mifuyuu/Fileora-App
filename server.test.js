const request = require('supertest');
const app = require('./server');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Session = require('./models/Session');
const FileType = require('file-type');

jest.mock('file-type');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DUMMY_FILE_PATH = path.join(__dirname, 'test-file.txt');
const FORBIDDEN_FILE_PATH = path.join(__dirname, 'test-file.html');

beforeAll(() => {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(DUMMY_FILE_PATH, 'This is a test file.');
    fs.writeFileSync(FORBIDDEN_FILE_PATH, '<h1>This is a forbidden file type</h1>');
});

afterAll(async () => {
    fs.unlinkSync(DUMMY_FILE_PATH);
    fs.unlinkSync(FORBIDDEN_FILE_PATH);
    if (fs.existsSync(UPLOADS_DIR)) {
        fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
    }
    await mongoose.connection.close();
});

afterEach(async () => {
    await Session.deleteMany({});
    if (fs.existsSync(UPLOADS_DIR)) {
        const sessionDirs = fs.readdirSync(UPLOADS_DIR);
        for (const dir of sessionDirs) {
            fs.rmSync(path.join(UPLOADS_DIR, dir), { recursive: true, force: true });
        }
    }
    jest.clearAllMocks();
});

describe('GET /', () => {
  it('should return 200 OK and the main page title', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toEqual(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('<title>Fileora by Seksun</title>');
  });
});

describe('GET /a-random-nonexistent-route', () => {
  it('should return 404 Not Found', async () => {
    const res = await request(app).get('/a-random-nonexistent-route');
    expect(res.statusCode).toEqual(404);
  });
});

describe('GET /api/session/init', () => {
    it('should return a session ID and a QR code data URL', async () => {
        const res = await request(app).get('/api/session/init');
        expect(res.statusCode).toEqual(200);
        expect(res.body).toHaveProperty('sessionId');
        expect(res.body).toHaveProperty('qr');
        expect(res.body.qr).toMatch(/^data:image\/png;base64,/);
    });
});

describe('POST /api/upload', () => {
    it('should upload a file successfully when MIME type is allowed', async () => {
        FileType.fromFile.mockResolvedValue({ mime: 'text/plain' });

        const sessionRes = await request(app).get('/api/session');
        const { sessionId } = sessionRes.body;

        const res = await request(app)
            .post(`/api/upload?sessionId=${sessionId}`)
            .attach('file', DUMMY_FILE_PATH);

        expect(res.statusCode).toEqual(200);
        expect(res.body.success).toBe(true);
    });

    it('should reject upload of a disallowed MIME type', async () => {
        FileType.fromFile.mockResolvedValue({ mime: 'text/html' });

        const sessionRes = await request(app).get('/api/session');
        const { sessionId } = sessionRes.body;

        const res = await request(app)
            .post(`/api/upload?sessionId=${sessionId}`)
            .attach('file', FORBIDDEN_FILE_PATH);
        
        expect(res.statusCode).toEqual(400);
        expect(res.body.error).toContain('Disallowed MIME type: text/html');
    });

    it('should reject upload if fromFile cannot determine file type', async () => {
        FileType.fromFile.mockResolvedValue(undefined);

        const sessionRes = await request(app).get('/api/session');
        const { sessionId } = sessionRes.body;

        const res = await request(app)
            .post(`/api/upload?sessionId=${sessionId}`)
            .attach('file', DUMMY_FILE_PATH);

        expect(res.statusCode).toEqual(400);
        expect(res.body.error).toEqual('Unable to determine file type.');
    });


    it('should reject upload if a file has already been uploaded to the session', async () => {
        FileType.fromFile.mockResolvedValue({ mime: 'text/plain' });

        const sessionRes = await request(app).get('/api/session');
        const { sessionId } = sessionRes.body;
        await request(app)
            .post(`/api/upload?sessionId=${sessionId}`)
            .attach('file', DUMMY_FILE_PATH);

        const res = await request(app)
            .post(`/api/upload?sessionId=${sessionId}`)
            .attach('file', DUMMY_FILE_PATH);

        expect(res.statusCode).toEqual(403);
        expect(res.body.error).toEqual('This session has already been used.');
    });
});

describe('/api/search/:key and /api/download/...', () => {
    it('should allow searching for and downloading a file with the correct key', async () => {
        FileType.fromFile.mockResolvedValue({ mime: 'text/plain' });

        const sessionRes = await request(app).get('/api/session');
        const { sessionId, key } = sessionRes.body;
        await request(app)
            .post(`/api/upload?sessionId=${sessionId}`)
            .attach('file', DUMMY_FILE_PATH);

        const searchRes = await request(app).get(`/api/search/${key}`);
        expect(searchRes.statusCode).toEqual(200);
        expect(searchRes.body.files).toHaveLength(1);
        
        const downloadUrl = searchRes.body.files[0].downloadUrl;

        const downloadRes = await request(app).get(downloadUrl);
        expect(downloadRes.statusCode).toEqual(200);
        expect(downloadRes.text).toBe('This is a test file.');
    });
});
