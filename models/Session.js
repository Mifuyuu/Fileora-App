const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
    filename: { type: String, required: true },
    originalname: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    sender: {
        platform: { type: String, enum: ['Web', 'LINE', 'Discord'], required: true },
        name: { type: String, required: true }
    }
}, { _id: false });

const sessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true, index: true },
    accessKey: { type: String, required: true, unique: true, index: true },
    encryptionKey: { type: String, required: true },
    files: [fileSchema],
    createdAt: { type: Date, default: Date.now, expires: '10m' }
});

const Session = mongoose.model('Session', sessionSchema);

module.exports = Session;