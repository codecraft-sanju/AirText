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
const qrcode = require('qrcode');
const pino = require('pino');

// --- 🟢 BAILEYS IMPORTS ---
const { 
    default: makeWASocket, 
    DisconnectReason, 
    initAuthCreds, 
    BufferJSON, 
    proto, 
    Browsers 
} = require('@whiskeysockets/baileys');

// --- 🌍 CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL;

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
    origin: FRONTEND_URL, 
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

// --- 🗄️ DATABASE ---
mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log("✅ MongoDB Connected");
        await Message.updateMany({ status: 'Processing' }, { $set: { status: 'Pending' } });
        console.log("🔄 Reset any stuck processing messages to Pending");
    })
    .catch(err => console.error("❌ MongoDB Error:", err));

// 1. USER SCHEMA
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    apiKey: { type: String, unique: true },
    deviceId: { type: String, unique: true },
    lastSeen: { type: Date, default: Date.now },
    waStatus: { type: String, default: 'Disconnected' },
    waQr: { type: String, default: null }
});
const User = mongoose.model('User', UserSchema);

// 2. MESSAGE SCHEMA
const MessageSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    phone: { type: String, required: true },
    content: { type: String, required: true },
    type: { type: String, enum: ['sms', 'whatsapp', 'both'], default: 'sms' },
    status: { type: String, enum: ['Pending', 'Processing', 'Sent', 'Failed', 'Partial'], default: 'Pending' },
    errorMessage: { type: String }, 
    webhookUrl: { type: String },
    createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

// 3. WHATSAPP AUTH SCHEMA (New for Baileys Session Management)
const WaAuthSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    key: { type: String, required: true },
    value: { type: String, required: true }
});
WaAuthSchema.index({ userId: 1, key: 1 }, { unique: true });
const WaAuth = mongoose.model('WaAuth', WaAuthSchema);

const deviceSocketMap = new Map(); 
const deviceUserMap = new Map();
const deviceCooldowns = new Map();
const waSockets = new Map();

// --- 🟢 MONGODB AUTH ADAPTER FOR BAILEYS ---
const useMongoDBAuthState = async (userId) => {
    const writeData = async (data, key) => {
        const value = JSON.stringify(data, BufferJSON.replacer);
        await WaAuth.findOneAndUpdate(
            { userId, key },
            { value },
            { upsert: true, new: true }
        );
    };

    const readData = async (key) => {
        const doc = await WaAuth.findOne({ userId, key });
        if (doc) return JSON.parse(doc.value, BufferJSON.reviver);
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

// --- 🏠 BASIC ROUTE ---
app.get('/', (req, res) => {
    res.send(`<h1>Gateway Server Running 🚀 (Baileys Engine)</h1>`);
});

// --- 🔐 AUTH ROUTES ---
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
        console.error("Register Error:", err);
        res.status(500).json({ error: "Server Error" });
    }
});

app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
            return res.json({
                success: true,
                role: 'admin', 
                token: 'admin-super-secret-token',
                user: { name: 'Admin', email: ADMIN_EMAIL }
            });
        }

        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ message: "User not found" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: "Invalid Credentials" });

        const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });

        res.json({ 
            success: true, 
            role: 'user',
            token, 
            user: { name: user.name, apiKey: user.apiKey, deviceId: user.deviceId } 
        });

    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ error: "Server Error" });
    }
});

// --- 👑 ADMIN ROUTES ---
app.get('/admin/users', async (req, res) => {
    try {
        const users = await User.find({}).sort({ lastSeen: -1 }); 
        
        const userList = users.map(user => {
            const isOnline = deviceSocketMap.has(user.deviceId);
            return {
                _id: user._id,
                name: user.name,
                email: user.email,
                deviceId: user.deviceId,
                apiKey: user.apiKey,
                lastSeen: user.lastSeen,
                isOnline: isOnline,
                waStatus: user.waStatus
            };
        });

        res.json({ success: true, users: userList });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/admin/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deletedUser = await User.findByIdAndDelete(id);
        
        if (deletedUser) {
            const socketId = deviceSocketMap.get(deletedUser.deviceId);
            if (socketId) {
                io.to(socketId).disconnectSockets(); 
                deviceSocketMap.delete(deletedUser.deviceId);
                deviceUserMap.delete(deletedUser.deviceId);
                deviceCooldowns.delete(deletedUser.deviceId);
            }
            if (waSockets.has(id)) {
                const sock = waSockets.get(id);
                sock.logout();
                waSockets.delete(id);
            }
            // Clear WhatsApp Auth data for deleted user
            await WaAuth.deleteMany({ userId: id });
            
            res.json({ success: true, message: "User Deleted Successfully" });
        } else {
            res.status(404).json({ success: false, message: "User not found" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 📜 GET MESSAGE HISTORY ---
app.get('/user/messages', async (req, res) => {
    try {
        const { apiKey } = req.query; 
        if (!apiKey) return res.status(400).json({ success: false, message: "API Key required" });

        const user = await User.findOne({ apiKey });
        if (!user) return res.status(401).json({ success: false, message: "Invalid API Key" });

        const messages = await Message.find({ userId: user._id })
            .sort({ createdAt: -1 }) 
            .limit(50);

        res.json({ success: true, messages });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 🟢 BAILEYS INITIALIZATION LOGIC ---
async function startBaileysConnection(userIdStr, userDoc) {
    console.log(`[WA DEBUG] ⏳ Starting Baileys for user: ${userDoc.email}`);
    
    const { state, saveCreds } = await useMongoDBAuthState(userIdStr);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
        logger: pino({ level: 'silent' }), // Hides extra logs
        syncFullHistory: false // Saves RAM
    });

    waSockets.set(userIdStr, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[WA DEBUG] 🟩 QR Code Generated for ${userDoc.email}`);
            try {
                const qrDataURL = await qrcode.toDataURL(qr);
                await User.findByIdAndUpdate(userIdStr, { waQr: qrDataURL, waStatus: 'QR_Ready' });
            } catch (error) {
                console.error("[WA DEBUG] ❌ QR Generation Error:", error);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`[WA DEBUG] 🔌 Connection closed. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                // Wait briefly before reconnecting
                setTimeout(() => startBaileysConnection(userIdStr, userDoc), 5000);
            } else {
                console.log(`[WA DEBUG] 🚪 User Logged out: ${userDoc.email}`);
                await User.findByIdAndUpdate(userIdStr, { waQr: null, waStatus: 'Disconnected' });
                await WaAuth.deleteMany({ userId: userIdStr });
                waSockets.delete(userIdStr);
            }
        } else if (connection === 'open') {
            console.log(`[WA DEBUG] ✅ WhatsApp Ready for User: ${userDoc.email}`);
            await User.findByIdAndUpdate(userIdStr, { waQr: null, waStatus: 'Connected' });
        }
    });
}

// --- 🌐 WHATSAPP START ROUTE ---
app.get('/whatsapp/start', async (req, res) => {
    try {
        const { apiKey } = req.query;
        if (!apiKey) return res.status(400).json({ success: false, message: "API Key required" });

        const user = await User.findOne({ apiKey });
        if (!user) return res.status(401).json({ success: false, message: "Invalid API Key" });

        const userIdStr = user._id.toString();

        // 🚨 YAHAN FIX KIYA HAI: Naya QR mangne par doosra socket nahi banayega agar purana QR de raha hai.
        if (waSockets.has(userIdStr)) {
            return res.json({ success: true, message: "Client exists", status: user.waStatus, qr: user.waQr });
        }

        // Initialize connection
        await startBaileysConnection(userIdStr, user);

        res.json({ success: true, message: "WhatsApp initialization started via Baileys" });
    } catch (err) {
        console.error("[WA DEBUG] API Error in /whatsapp/start:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- 🔌 SOCKET CONNECTION LOGIC ---
io.on('connection', async (socket) => {
    const { deviceId } = socket.handshake.auth;
    
    if (!deviceId) return socket.disconnect();

    const user = await User.findOne({ deviceId });
    if (!user) {
        console.log(`🚫 Unknown Device: ${deviceId}`);
        return socket.disconnect();
    }

    console.log(`✅ Online: ${user.name} (${deviceId})`);
    deviceSocketMap.set(deviceId, socket.id);
    deviceUserMap.set(deviceId, user._id);
    
    user.lastSeen = new Date();
    await user.save();

    socket.on('disconnect', () => {
        console.log(`❌ Offline: ${user.name}`);
        deviceSocketMap.delete(deviceId);
        deviceUserMap.delete(deviceId);
    });
});

// --- 🚀 SEND SMS API ---
app.post('/send-message', async (req, res) => {
    try {
        const { apiKey, phone, msg, webhookUrl, type = 'sms' } = req.body;

        if(!apiKey || !phone || !msg) 
            return res.status(400).json({ success: false, message: "Missing parameters" });

        if (!['sms', 'whatsapp', 'both'].includes(type)) {
            return res.status(400).json({ success: false, message: "Invalid type. Use sms, whatsapp, or both" });
        }
        
        const user = await User.findOne({ apiKey });
        if (!user) return res.status(401).json({ success: false, message: "Invalid API Key" });

        const newMessage = new Message({
            userId: user._id,
            phone,
            content: msg,
            type,
            status: 'Pending',
            webhookUrl: webhookUrl || null
        });
        await newMessage.save();

        res.status(202).json({ success: true, message: "Message Queued", messageId: newMessage._id });

    } catch (err) {
        console.error("API Error:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

async function processQueue() {
    const pendingMessages = await Message.find({ status: 'Pending' }).sort({ createdAt: 1 }).limit(10);

    for (const msg of pendingMessages) {
        const user = await User.findById(msg.userId);
        if (!user) continue;

        msg.status = 'Processing';
        await msg.save();

        let smsResult = { sent: false, error: null };
        let waResult = { sent: false, error: null };
        let requiresCooldown = false;

        // 🟢 BAILEYS MESSAGE SENDING LOGIC
        if (msg.type === 'whatsapp' || msg.type === 'both') {
            const sock = waSockets.get(user._id.toString());
            if (sock && user.waStatus === 'Connected') {
                try {
                    let formattedPhone = msg.phone.replace(/[^0-9]/g, '');
                    // Baileys needs '@s.whatsapp.net' for individuals
                    if (!formattedPhone.endsWith('@s.whatsapp.net')) {
                        formattedPhone += '@s.whatsapp.net';
                    }
                    
                    await sock.sendMessage(formattedPhone, { text: msg.content });
                    waResult.sent = true;
                } catch (err) {
                    waResult.error = err.message;
                }
            } else {
                waResult.error = 'WhatsApp not connected';
            }
        }

        if (msg.type === 'sms' || msg.type === 'both') {
            const deviceId = user.deviceId;
            const socketId = deviceSocketMap.get(deviceId);
            const cooldown = deviceCooldowns.get(deviceId) || 0;

            if (socketId) {
                if (Date.now() < cooldown) {
                    msg.status = 'Pending';
                    await msg.save();
                    continue; 
                }

                requiresCooldown = true;
                const targetSocket = io.sockets.sockets.get(socketId);
                
                if (targetSocket) {
                    try {
                        const response = await new Promise((resolve, reject) => {
                            const timeout = setTimeout(() => reject(new Error('Device Timeout')), 15000);
                            targetSocket.emit('send_sms_command', { phone: msg.phone, msg: msg.content, id: msg._id }, (res) => {
                                clearTimeout(timeout);
                                resolve(res);
                            });
                        });
                        
                        if (response && response.success) {
                            smsResult.sent = true;
                        } else {
                            smsResult.error = response ? response.error : "App reported failure";
                        }
                    } catch (err) {
                        smsResult.error = err.message;
                    }
                } else {
                    smsResult.error = 'Device Disconnected before sending';
                }
            } else {
                smsResult.error = 'Device Offline';
            }
        }

        if (requiresCooldown) {
            deviceCooldowns.set(user.deviceId, Date.now() + 20000);
        }

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

        if (msg.webhookUrl) {
            try {
                await fetch(msg.webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messageId: msg._id,
                        phone: msg.phone,
                        type: msg.type,
                        status: msg.status,
                        errorMessage: msg.errorMessage
                    })
                });
            } catch (webhookError) {
                console.error("Webhook Error:", webhookError.message);
            }
        }
    }
}

setInterval(processQueue, 2000);

server.listen(PORT, () => console.log(`🚀 Production Server running on Port ${PORT}`));