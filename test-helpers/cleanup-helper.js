const fs = require('fs');
const path = require('path');
const Session = require('./models/Session');

// Test helper สำหรับ cleanup system
class CleanupTestHelper {
    constructor() {
        this.uploadsDir = path.join(__dirname, 'uploads');
    }

    // สร้าง orphaned directories สำหรับทดสอบ
    createOrphanedDirectories(count = 3) {
        const orphanedSessions = [];
        
        for (let i = 0; i < count; i++) {
            const sessionId = `orphaned-session-${Date.now()}-${i}`;
            const sessionDir = path.join(this.uploadsDir, sessionId);
            
            if (!fs.existsSync(sessionDir)) {
                fs.mkdirSync(sessionDir, { recursive: true });
            }
            
            // สร้างไฟล์ dummy
            const dummyFile = path.join(sessionDir, `file-${i}.enc`);
            fs.writeFileSync(dummyFile, `Dummy encrypted content ${i}`);
            
            orphanedSessions.push(sessionId);
        }
        
        return orphanedSessions;
    }

    // ตรวจสอบว่า directory ยังอยู่หรือไม่
    checkDirectoryExists(sessionId) {
        const sessionDir = path.join(this.uploadsDir, sessionId);
        return fs.existsSync(sessionDir);
    }

    // นับจำนวนไฟล์ในแต่ละ session directory
    countFilesInSession(sessionId) {
        const sessionDir = path.join(this.uploadsDir, sessionId);
        if (!fs.existsSync(sessionDir)) return 0;
        
        return fs.readdirSync(sessionDir).length;
    }

    // ทำความสะอาด test environment
    cleanup() {
        if (fs.existsSync(this.uploadsDir)) {
            fs.rmSync(this.uploadsDir, { recursive: true, force: true });
        }
    }

    // จำลองการทำงานของ cron job cleanup
    simulateCleanupJob() {
        return new Promise((resolve) => {
            if (!fs.existsSync(this.uploadsDir)) {
                fs.mkdirSync(this.uploadsDir, { recursive: true });
                resolve({ cleaned: 0, errors: [] });
                return;
            }

            const results = { cleaned: 0, errors: [] };
            
            fs.readdir(this.uploadsDir, async (err, sessionDirs) => {
                if (err) {
                    results.errors.push(`Failed to read uploads directory: ${err.message}`);
                    resolve(results);
                    return;
                }

                for (const sessionId of sessionDirs) {
                    try {
                        const session = await Session.findOne({ sessionId });
                        if (!session) {
                            const dirPath = path.join(this.uploadsDir, sessionId);
                            fs.rmSync(dirPath, { recursive: true, force: true });
                            results.cleaned++;
                        }
                    } catch (cleanupError) {
                        results.errors.push(`Failed to cleanup ${sessionId}: ${cleanupError.message}`);
                    }
                }
                
                resolve(results);
            });
        });
    }
}

module.exports = CleanupTestHelper;
