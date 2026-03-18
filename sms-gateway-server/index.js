require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const qrcode = require('qrcode'); // ✅ REQUIRED: npm install qrcode
const pino = require('pino');

// --- 🟢 BAILEYS IMPORTS ---
const { 
    default: makeWASocket, 
    DisconnectReason, 
    initAuthCreds, 
    BufferJSON, 
    proto, 
    Browsers,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

// --- 🌍 CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || "*"; // Allow all for App

// --- 👑 ADMIN CREDENTIALS ---
const ADMIN_EMAIL = "admin@gmail.com";
const ADMIN_PASS = "admin";

const app = express();
const server = http.createServer(app);

// --- 🛡️ PROXY FIX FOR RATE LIMIT ON RENDER ---
app.set('trust proxy', 1);

// --- 🛡️ SECURITY MIDDLEWARE ---
app.use(helmet()); 

const corsOptions = {
    origin: "*", // Allow connections from React Native
    methods: ["GET", "POST", "DELETE"], 
    credentials: true 
};

app.use(cors(corsOptions)); 
app.use(express.json());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100 
});
app.use('/auth', limiter);

// ---> CHANGED: API RATE LIMITER FOR SEND-MESSAGE (Security)
const sendMessageLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // Max 60 requests per minute per IP
    message: { success: false, message: "Too many requests. Please wait a minute." }
});

// --- 🔌 SOCKET.IO SETUP (Mobile Optimized) ---
const io = new Server(server, {
    cors: { 
        origin: "*", 
        methods: ["GET", "POST"] 
    },
    pingTimeout: 60000, 
    pingInterval: 25000, 
    transports: ['websocket', 'polling'] 
});

// 1. USER SCHEMA
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    apiKey: { type: String, unique: true },
    deviceId: { type: String, unique: true },
    lastSeen: { type: Date, default: Date.now },
    waStatus: { type: String, default: 'Disconnected' }, // Disconnected, QR_Ready, Connected
    waQr: { type: String, default: null } // Stores the Base64 QR Image
});
const User = mongoose.model('User', UserSchema);

// 2. MESSAGE SCHEMA
const MessageSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    phone: { type: String, required: true },
    content: { type: String, required: true },
    type: { type: String, enum: ['sms', 'whatsapp', 'both'], default: 'sms' },
    // --- NEW CHANGES: Added mediaUrls array for WhatsApp photos ---
    mediaUrls: [{ type: String }], 
    status: { type: String, enum: ['Pending', 'Processing', 'Sent', 'Failed', 'Partial'], default: 'Pending' },
    errorMessage: { type: String }, 
    webhookUrl: { type: String },
    createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

// 3. WHATSAPP AUTH SCHEMA
const WaAuthSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    key: { type: String, required: true },
    value: { type: String, required: true }
});
WaAuthSchema.index({ userId: 1, key: 1 }, { unique: true });
const WaAuth = mongoose.model('WaAuth', WaAuthSchema);

// --- 🗄️ DATABASE & SERVER START ---
mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log("✅ MongoDB Connected");
        
        // 1. Reset Stuck Messages
        await Message.updateMany({ status: 'Processing' }, { $set: { status: 'Pending' } });
        
        // 2. Reset Stuck WhatsApp Statuses (Crucial for QR Fix)
        await User.updateMany(
            { waStatus: 'QR_Ready' }, 
            { $set: { waStatus: 'Disconnected', waQr: null } }
        );
        console.log("🔄 System State Cleaned (Messages & WA Status)");

        server.listen(PORT, () => console.log(`🚀 Production Server running on Port ${PORT}`));
    })
    .catch(err => {
        console.error("❌ MongoDB Error:", err);
        process.exit(1); 
    });

const deviceSocketMap = new Map(); 
const deviceUserMap = new Map();
const deviceCooldowns = new Map();
const waSockets = new Map();

// --- 🟢 MONGODB AUTH ADAPTER FOR BAILEYS ---
const useMongoDBAuthState = async (userId) => {
    const writeData = async (data, key) => {
        try {
            const value = JSON.stringify(data, BufferJSON.replacer);
            await WaAuth.findOneAndUpdate(
                { userId, key },
                { value },
                { upsert: true, new: true } 
            );
        } catch(e) { console.error("Auth Write Error", e); }
    };

    const readData = async (key) => {
        try {
            const doc = await WaAuth.findOne({ userId, key });
            if (doc) return JSON.parse(doc.value, BufferJSON.reviver);
        } catch(e) { return null; }
        return null;
    };

    const removeData = async (key) => {
        await WaAuth.deleteOne({ userId, key });
    };

    let creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
};

// --- 🟢 BAILEYS LOGIC (QR FIX APPLIED) ---
async function startBaileysConnection(userIdStr, userDoc) {
    console.log(`[WA] ⏳ Initializing for ${userDoc.email}`);
    
    const { state, saveCreds } = await useMongoDBAuthState(userIdStr);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true, 
        browser: Browsers.macOS("Desktop"), // ✅ More stable than default
        logger: pino({ level: 'silent' }),
        connectTimeoutMs: 60000,
        syncFullHistory: false
    });

    waSockets.set(userIdStr, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[WA] ✨ QR Generated for ${userDoc.email}`);
            try {
                // ✅ CONVERT QR TEXT TO IMAGE URL
                const qrDataURL = await qrcode.toDataURL(qr); 
                await User.findByIdAndUpdate(userIdStr, { waQr: qrDataURL, waStatus: 'QR_Ready' });
            } catch (error) {
                console.error("[WA] ❌ QR Gen Error:", error);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            // Reconnect if NOT logged out (401) or Banned/Bad Request (403/405)
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut 
                && statusCode !== 401 
                && statusCode !== 403
                && statusCode !== 405; 
            
            console.log(`[WA] 🔴 Closed: ${statusCode}. Reconnect: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                setTimeout(() => startBaileysConnection(userIdStr, userDoc), 4000);
            } else {
                console.log(`[WA] 🗑️ Session invalid. Cleaning up.`);
                await User.findByIdAndUpdate(userIdStr, { waQr: null, waStatus: 'Disconnected' });
                await WaAuth.deleteMany({ userId: userIdStr }); // Wipe bad session data
                waSockets.delete(userIdStr);
            }
        } else if (connection === 'open') {
            console.log(`[WA] 🟢 Connected: ${userDoc.email}`);
            await User.findByIdAndUpdate(userIdStr, { waQr: null, waStatus: 'Connected' });
        }
    });
}

// --- 🏠 ROUTES ---
app.get('/', (req, res) => {
    res.send(`<h1>Gateway Server Running 🚀</h1>`);
});

// --- 🔐 AUTH ---
app.post('/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if(!name || !email || !password) return res.status(400).json({message: "All fields required"});
        
        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ message: "User already exists" });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const apiKey = uuidv4(); 
        const deviceId = `device_${uuidv4().split('-')[0]}`;

        const newUser = new User({ name, email, password: hashedPassword, apiKey, deviceId });
        await newUser.save();

        res.status(201).json({ success: true, message: "User Registered!", apiKey, deviceId });
    } catch (err) {
        res.status(500).json({ error: "Server Error" });
    }
});

app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
            return res.json({
                success: true, role: 'admin', token: 'admin-token',
                user: { name: 'Admin', email: ADMIN_EMAIL }
            });
        }
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ message: "User not found" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: "Invalid Credentials" });

        const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });

        res.json({ 
            success: true, role: 'user', token, 
            user: { name: user.name, apiKey: user.apiKey, deviceId: user.deviceId } 
        });
    } catch (err) {
        res.status(500).json({ error: "Server Error" });
    }
});

// --- 🌐 WHATSAPP MANAGEMENT (FIXED) ---
app.get('/whatsapp/start', async (req, res) => {
    try {
        const { apiKey, force } = req.query; // ✅ Added force param
        if (!apiKey) return res.status(400).json({ success: false, message: "API Key required" });

        const user = await User.findOne({ apiKey });
        if (!user) return res.status(401).json({ success: false, message: "Invalid API Key" });

        const userIdStr = user._id.toString();

        // ✅ FORCE RESET LOGIC
        if (force === 'true') {
            console.log(`[WA] ⚠️ Force Restarting ${user.email}`);
            if (waSockets.has(userIdStr)) {
                try { waSockets.get(userIdStr).end(undefined); } catch(e){}
                waSockets.delete(userIdStr);
            }
            await WaAuth.deleteMany({ userId: userIdStr }); // Clear DB Session
            await User.findByIdAndUpdate(userIdStr, { waQr: null, waStatus: 'Disconnected' });
        } else if (waSockets.has(userIdStr)) {
            // If already running, return status
            return res.json({ success: true, message: "Client active", status: user.waStatus, qr: user.waQr });
        }

        // Start New Connection
        startBaileysConnection(userIdStr, user);

        res.json({ success: true, message: "Initialization started", status: 'Initializing' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 🚀 MESSAGING API ---
// ---> CHANGED: Added sendMessageLimiter middleware here
app.post('/send-message', sendMessageLimiter, async (req, res) => {
    try {
        // --- NEW CHANGES: Extract mediaUrls from request body ---
        const { apiKey, phone, msg, webhookUrl, type = 'sms', mediaUrls = [] } = req.body;

        if(!apiKey || !phone || !msg) 
            return res.status(400).json({ success: false, message: "Missing parameters" });

        const user = await User.findOne({ apiKey });
        if (!user) return res.status(401).json({ success: false, message: "Invalid API Key" });

        // --- NEW CHANGES: Ensure max 10 URLs just to be safe on the backend ---
        const finalMediaUrls = Array.isArray(mediaUrls) ? mediaUrls.slice(0, 10) : [];

        const newMessage = new Message({
            userId: user._id, phone, content: msg, type,
            status: 'Pending', webhookUrl: webhookUrl || null,
            mediaUrls: finalMediaUrls // --- NEW CHANGES: Save to DB ---
        });
        await newMessage.save();

        res.status(202).json({ success: true, message: "Message Queued", messageId: newMessage._id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/user/messages', async (req, res) => {
    try {
        const { apiKey } = req.query; 
        const user = await User.findOne({ apiKey });
        if (!user) return res.status(401).json({ success: false });
        const messages = await Message.find({ userId: user._id }).sort({ createdAt: -1 }).limit(50);
        res.json({ success: true, messages });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/users', async (req, res) => {
    const users = await User.find({}).sort({ lastSeen: -1 });
    const userList = users.map(u => ({
        ...u._doc,
        isOnline: deviceSocketMap.has(u.deviceId)
    }));
    res.json({ success: true, users: userList });
});

app.delete('/admin/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deletedUser = await User.findByIdAndDelete(id);
        if (deletedUser) {
            // Clean up sockets & auth
            const socketId = deviceSocketMap.get(deletedUser.deviceId);
            if (socketId) io.to(socketId).disconnectSockets();
            if (waSockets.has(id)) { waSockets.get(id).end(undefined); waSockets.delete(id); }
            await WaAuth.deleteMany({ userId: id });
            
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 🔌 DEVICE SOCKET ---
io.on('connection', async (socket) => {
    const { deviceId } = socket.handshake.auth;
    if (!deviceId) return socket.disconnect();

    const user = await User.findOne({ deviceId });
    if (!user) return socket.disconnect();

    console.log(`✅ Device Online: ${user.name}`);
    deviceSocketMap.set(deviceId, socket.id);
    deviceUserMap.set(deviceId, user._id);
    
    user.lastSeen = new Date();
    await user.save();

    socket.on('disconnect', () => {
        deviceSocketMap.delete(deviceId);
        deviceUserMap.delete(deviceId);
    });
});

// --- 🔄 QUEUE PROCESSOR ---
async function processQueue() {
    const pendingMessages = await Message.find({ status: 'Pending' }).sort({ createdAt: 1 }).limit(50);

    for (const msg of pendingMessages) {
        const user = await User.findById(msg.userId);
        if (!user) continue;

        // Expired OTP Logic
        const EXPIRY_TIME_MS = 3 * 60 * 1000;
        if (Date.now() - new Date(msg.createdAt).getTime() > EXPIRY_TIME_MS) {
            msg.status = 'Failed';
            msg.errorMessage = 'Expired (Older than 3 mins)';
            await msg.save();
            
            if (msg.webhookUrl) {
                try {
                    await fetch(msg.webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            messageId: msg._id, phone: msg.phone, type: msg.type,
                            status: msg.status, errorMessage: msg.errorMessage
                        })
                    });
                } catch (e) { console.error("Webhook Fail", e.message); }
            }
            continue; 
        }

        msg.status = 'Processing';
        await msg.save();

        let smsResult = { sent: false, error: null };
        let waResult = { sent: false, error: null };
        let requiresCooldown = false;

        // 1. Send via WhatsApp
        if (msg.type === 'whatsapp' || msg.type === 'both') {
            const sock = waSockets.get(user._id.toString());
            if (sock && user.waStatus === 'Connected') {
                try {
                    let formattedPhone = msg.phone.replace(/[^0-9]/g, '');
                    if (!formattedPhone.endsWith('@s.whatsapp.net')) formattedPhone += '@s.whatsapp.net';
                    
                    // ---> CHANGED: WHATSAPP ANTI-BAN RANDOM DELAY
                    // WhatsApp message bhejne se pehle 2 se 5 second ka gap (Human Behavior)
                    const randomDelay = Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000;
                    await new Promise(resolve => setTimeout(resolve, randomDelay));

                    // --- NEW CHANGES: Media Sending Logic ---
                    if (msg.mediaUrls && msg.mediaUrls.length > 0) {
                        // Send the first image with the text message as a caption
                        await sock.sendMessage(formattedPhone, { 
                            image: { url: msg.mediaUrls[0] }, 
                            caption: msg.content 
                        });

                        // If there are more images, send them without a caption
                        for (let i = 1; i < msg.mediaUrls.length; i++) {
                            // Add a small 1.5 second delay between multiple photos to avoid WhatsApp treating it as spam
                            await new Promise(resolve => setTimeout(resolve, 1500));
                            await sock.sendMessage(formattedPhone, { 
                                image: { url: msg.mediaUrls[i] } 
                            });
                        }
                    } else {
                        // Regular text message if no media URLs exist
                        await sock.sendMessage(formattedPhone, { text: msg.content });
                    }
                    // --- END NEW CHANGES ---

                    waResult.sent = true;
                } catch (err) { waResult.error = err.message; }
            } else { waResult.error = 'WhatsApp not connected'; }
        }

        // 2. Send via SMS (Android)
        if (msg.type === 'sms' || msg.type === 'both') {
            const deviceId = user.deviceId;
            const socketId = deviceSocketMap.get(deviceId);
            const cooldown = deviceCooldowns.get(deviceId) || 0;

            if (socketId) {
                if (Date.now() < cooldown) {
                    msg.status = 'Pending'; await msg.save(); continue;
                }
                requiresCooldown = true;
                const targetSocket = io.sockets.sockets.get(socketId);
                
                try {
                    const response = await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error('Timeout')), 15000);
                        targetSocket.emit('send_sms_command', { phone: msg.phone, msg: msg.content, id: msg._id }, (res) => {
                            clearTimeout(timeout); resolve(res);
                        });
                    });
                    if (response && response.success) smsResult.sent = true;
                    else smsResult.error = response ? response.error : "Failed";
                } catch (err) { smsResult.error = err.message; }
            } else { smsResult.error = 'Device Offline'; }
        }

        if (requiresCooldown) deviceCooldowns.set(user.deviceId, Date.now() + 500);

        // 3. Final Status Update
        let finalStatus = 'Failed';
        let errorMessages = [];

        if (msg.type === 'whatsapp') {
            finalStatus = waResult.sent ? 'Sent' : 'Failed';
            if (waResult.error) errorMessages.push(`WA: ${waResult.error}`);
        } else if (msg.type === 'sms') {
            finalStatus = smsResult.sent ? 'Sent' : 'Failed';
            if (smsResult.error) errorMessages.push(`SMS: ${smsResult.error}`);
        } else if (msg.type === 'both') {
            if (smsResult.sent && waResult.sent) finalStatus = 'Sent';
            else if (smsResult.sent || waResult.sent) finalStatus = 'Partial';
            else finalStatus = 'Failed';
            if (smsResult.error) errorMessages.push(`SMS: ${smsResult.error}`);
            if (waResult.error) errorMessages.push(`WA: ${waResult.error}`);
        }

        msg.status = finalStatus;
        if (errorMessages.length > 0) msg.errorMessage = errorMessages.join(' | ');
        await msg.save();

        // 4. Webhook Trigger
        if (msg.webhookUrl) {
            try {
                await fetch(msg.webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messageId: msg._id, phone: msg.phone, type: msg.type,
                        status: msg.status, errorMessage: msg.errorMessage
                    })
                });
            } catch (e) { console.error("Webhook Fail", e.message); }
        }
    }
}

setInterval(processQueue, 1000);