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

beforeAll(() => {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(DUMMY_FILE_PATH, 'This is a test file for failure scenarios.');
});

afterAll(async () => {
    if (fs.existsSync(DUMMY_FILE_PATH)) fs.unlinkSync(DUMMY_FILE_PATH);
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
            const dirPath = path.join(UPLOADS_DIR, dir);
            if (fs.existsSync(dirPath)) {
                fs.rmSync(dirPath, { recursive: true, force: true });
            }
        }
    }
    jest.clearAllMocks();
});

describe('Server Failure Scenarios during Upload', () => {
    
    describe('File Type Detection Failure', () => {
        it('should handle FileType.fromFile throwing an error', async () => {
            // Mock FileType.fromFile to throw an error (simulating corruption/crash)
            FileType.fromFile.mockRejectedValue(new Error('File system error'));

            const sessionRes = await request(app).get('/api/session');
            const { sessionId } = sessionRes.body;

            const res = await request(app)
                .post(`/api/upload?sessionId=${sessionId}`)
                .attach('file', DUMMY_FILE_PATH);

            expect(res.statusCode).toEqual(500);
            expect(res.body.error).toContain('File system error');

            // Verify temp file cleanup
            const sessionDir = path.join(UPLOADS_DIR, sessionId);
            if (fs.existsSync(sessionDir)) {
                const files = fs.readdirSync(sessionDir);
                // Should not have any unencrypted files left
                expect(files.filter(f => !f.endsWith('.enc'))).toHaveLength(0);
            }
        });
    });

    describe('Database Connection Failure', () => {
        it('should handle database save failure during upload', async () => {
            FileType.fromFile.mockResolvedValue({ mime: 'text/plain' });
            
            // Mock Session.save to fail
            const originalSave = Session.prototype.save;
            Session.prototype.save = jest.fn().mockRejectedValue(new Error('Database connection lost'));

            const sessionRes = await request(app).get('/api/session');
            const { sessionId } = sessionRes.body;

            const res = await request(app)
                .post(`/api/upload?sessionId=${sessionId}`)
                .attach('file', DUMMY_FILE_PATH);

            expect(res.statusCode).toEqual(500);
            expect(res.body.error).toContain('Database connection lost');

            // Verify temp file cleanup
            const sessionDir = path.join(UPLOADS_DIR, sessionId);
            if (fs.existsSync(sessionDir)) {
                const files = fs.readdirSync(sessionDir);
                expect(files.filter(f => !f.endsWith('.enc'))).toHaveLength(0);
            }

            // Restore original save method
            Session.prototype.save = originalSave;
        });
    });

    describe('File System Failure', () => {
        it('should handle file write permission errors', async () => {
            FileType.fromFile.mockResolvedValue({ mime: 'text/plain' });

            const sessionRes = await request(app).get('/api/session');
            const { sessionId } = sessionRes.body;

            // Mock fs.createWriteStream to simulate permission error
            const originalCreateWriteStream = fs.createWriteStream;
            fs.createWriteStream = jest.fn().mockImplementation(() => {
                const stream = require('stream');
                const mockStream = new stream.Writable();
                mockStream._write = (chunk, encoding, callback) => {
                    callback(new Error('EACCES: permission denied'));
                };
                return mockStream;
            });

            const res = await request(app)
                .post(`/api/upload?sessionId=${sessionId}`)
                .attach('file', DUMMY_FILE_PATH);

            expect(res.statusCode).toEqual(500);
            expect(res.body.error).toContain('EACCES: permission denied');

            // Restore original method
            fs.createWriteStream = originalCreateWriteStream;
        });
    });

    describe('Session Expiry During Upload', () => {
        it('should handle session that expires during upload process', async () => {
            FileType.fromFile.mockResolvedValue({ mime: 'text/plain' });

            // Create session
            const sessionRes = await request(app).get('/api/session');
            const { sessionId } = sessionRes.body;

            // Manually delete the session to simulate expiry
            await Session.deleteOne({ sessionId });

            const res = await request(app)
                .post(`/api/upload?sessionId=${sessionId}`)
                .attach('file', DUMMY_FILE_PATH);

            expect(res.statusCode).toEqual(403);
            expect(res.body.error).toEqual('This session has already been used.');
        });
    });

    describe('Orphaned Files Cleanup', () => {
        it('should leave orphaned directories when session creation fails', async () => {
            // This test simulates the scenario where directories are created 
            // but session is not saved to database due to server crash
            
            const sessionId = 'test-orphaned-session';
            const sessionDir = path.join(UPLOADS_DIR, sessionId);
            
            // Create directory manually (simulating multer creating it)
            if (!fs.existsSync(sessionDir)) {
                fs.mkdirSync(sessionDir, { recursive: true });
            }
            
            // Create a test file in the directory
            const testFile = path.join(sessionDir, 'orphaned-file.txt');
            fs.writeFileSync(testFile, 'This is an orphaned file');

            // Verify the orphaned directory exists
            expect(fs.existsSync(sessionDir)).toBe(true);
            expect(fs.existsSync(testFile)).toBe(true);

            // Verify no session exists in database
            const session = await Session.findOne({ sessionId });
            expect(session).toBeNull();

            // This test demonstrates the cleanup scenario
            // In real application, cron job would clean this up
            console.log(`Orphaned directory created at: ${sessionDir}`);
        });
    });

    describe('Memory and Resource Leaks', () => {
        it('should not leak file descriptors on upload failure', async () => {
            FileType.fromFile.mockRejectedValue(new Error('Simulated crash'));

            const sessionRes = await request(app).get('/api/session');
            const { sessionId } = sessionRes.body;

            // Track initial file descriptor count (if available)
            const initialFds = process.platform !== 'win32' ? 
                fs.readdirSync('/proc/self/fd').length : 0;

            const res = await request(app)
                .post(`/api/upload?sessionId=${sessionId}`)
                .attach('file', DUMMY_FILE_PATH);

            expect(res.statusCode).toEqual(500);

            // Allow some time for cleanup
            await new Promise(resolve => setTimeout(resolve, 100));

            // Check file descriptors haven't increased significantly
            if (process.platform !== 'win32') {
                const finalFds = fs.readdirSync('/proc/self/fd').length;
                expect(finalFds - initialFds).toBeLessThan(5); // Allow some tolerance
            }
        });
    });

    describe('Concurrent Upload Failure', () => {
        it('should handle multiple simultaneous uploads to same session', async () => {
            FileType.fromFile.mockResolvedValue({ mime: 'text/plain' });

            const sessionRes = await request(app).get('/api/session');
            const { sessionId } = sessionRes.body;

            // Start two uploads simultaneously
            const upload1 = request(app)
                .post(`/api/upload?sessionId=${sessionId}`)
                .attach('file', DUMMY_FILE_PATH);

            const upload2 = request(app)
                .post(`/api/upload?sessionId=${sessionId}`)
                .attach('file', DUMMY_FILE_PATH);

            const [res1, res2] = await Promise.all([upload1, upload2]);

            // One should succeed, one should fail with "already used"
            const responses = [res1, res2];
            const successCount = responses.filter(r => r.statusCode === 200).length;
            const failureCount = responses.filter(r => r.statusCode === 403).length;

            expect(successCount).toBe(1);
            expect(failureCount).toBe(1);

            const failedResponse = responses.find(r => r.statusCode === 403);
            expect(failedResponse.body.error).toEqual('This session has already been used.');
        });
    });
});

describe('Recovery and Cleanup Tests', () => {
    describe('Session TTL Behavior', () => {
        it('should verify session expires after creation', async () => {
            const sessionRes = await request(app).get('/api/session');
            const { sessionId, key } = sessionRes.body;

            // Session should exist initially
            let session = await Session.findOne({ sessionId });
            expect(session).not.toBeNull();

            // Check session has TTL
            expect(session.createdAt).toBeDefined();
            
            // Note: In real test environment, we can't wait 5 minutes
            // This test verifies the TTL field is set correctly
            const ttlIndex = await Session.collection.indexInformation();
            expect(ttlIndex).toHaveProperty('createdAt_1');
        }, 10000);
    });
});
