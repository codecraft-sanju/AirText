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

// --- 🛡️ SECURITY MIDDLEWARE ---
app.use(helmet()); 

const corsOptions = {
    origin: FRONTEND_URL, 
    methods: ["GET", "POST", "DELETE"], 
    credentials: true 
};

app.use(cors(corsOptions)); 
app.use(express.json());

// Limit API calls
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
    pingTimeout: 60000, // 60s wait karega disconnect se pehle
    pingInterval: 25000, // 25s heartbeat
    transports: ['websocket', 'polling'] 
});

// --- 🗄️ DATABASE ---
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Error:", err));

// 1. USER SCHEMA
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    apiKey: { type: String, unique: true },
    deviceId: { type: String, unique: true },
    lastSeen: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);

// 2. MESSAGE SCHEMA (🆕 NEW ADDITION)
const MessageSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    phone: { type: String, required: true },
    content: { type: String, required: true },
    status: { type: String, enum: ['Pending', 'Sent', 'Failed'], default: 'Pending' },
    errorMessage: { type: String }, // Agar fail hua toh reason
    createdAt: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', MessageSchema);

const deviceSocketMap = new Map(); 

// --- 🏠 BASIC ROUTE ---
app.get('/', (req, res) => {
    res.send(`<h1>SMS Gateway Server Running 🚀</h1>`);
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

        // --- 👑 ADMIN LOGIN CHECK ---
        if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
            return res.json({
                success: true,
                role: 'admin', 
                token: 'admin-super-secret-token',
                user: { name: 'Admin', email: ADMIN_EMAIL }
            });
        }

        // Normal User Login
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

// 1. Get All Users (With Online Status)
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
                isOnline: isOnline 
            };
        });

        res.json({ success: true, users: userList });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Delete User
app.delete('/admin/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deletedUser = await User.findByIdAndDelete(id);
        
        if (deletedUser) {
            // Agar online hai toh disconnect karo
            const socketId = deviceSocketMap.get(deletedUser.deviceId);
            if (socketId) {
                io.to(socketId).disconnectSockets(); 
                deviceSocketMap.delete(deletedUser.deviceId);
            }
            res.json({ success: true, message: "User Deleted Successfully" });
        } else {
            res.status(404).json({ success: false, message: "User not found" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 📜 GET MESSAGE HISTORY (🆕 NEW ROUTE) ---
app.get('/user/messages', async (req, res) => {
    try {
        const { apiKey } = req.query; // API Key query params mein bhejo
        if (!apiKey) return res.status(400).json({ success: false, message: "API Key required" });

        const user = await User.findOne({ apiKey });
        if (!user) return res.status(401).json({ success: false, message: "Invalid API Key" });

        // Last 50 messages fetch karo
        const messages = await Message.find({ userId: user._id })
            .sort({ createdAt: -1 }) // Newest first
            .limit(50);

        res.json({ success: true, messages });
    } catch (err) {
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
    
    user.lastSeen = new Date();
    await user.save();

    socket.on('disconnect', () => {
        console.log(`❌ Offline: ${user.name}`);
        deviceSocketMap.delete(deviceId);
    });
});

// --- 🚀 SEND SMS API (UPDATED WITH LOGS) ---
app.post('/send-sms', async (req, res) => {
    try {
        const { apiKey, phone, msg } = req.body;

        if(!apiKey || !phone || !msg) 
            return res.status(400).json({ success: false, message: "Missing parameters" });
        
        // 1. User Validate
        const user = await User.findOne({ apiKey });
        if (!user) return res.status(401).json({ success: false, message: "Invalid API Key" });

        // 2. Message ko Database mein save karo (Status: Pending)
        const newMessage = new Message({
            userId: user._id,
            phone,
            content: msg,
            status: 'Pending'
        });
        await newMessage.save();

        // 3. Device Check
        const socketId = deviceSocketMap.get(user.deviceId);
        if (!socketId) {
            // Agar device offline hai, toh DB update karo aur error return karo
            newMessage.status = 'Failed';
            newMessage.errorMessage = 'Device Offline';
            await newMessage.save();
            return res.status(404).json({ success: false, message: "Device Offline", messageId: newMessage._id });
        }

        // 4. Timeout Logic
        let responseSent = false;
        const timeout = setTimeout(async () => {
            if(!responseSent) {
                responseSent = true;
                // Timeout ho gaya, DB update karo
                newMessage.status = 'Failed';
                newMessage.errorMessage = 'Device Timeout (No response from app)';
                await newMessage.save();
                res.status(408).json({success: false, message: "Device Timeout", messageId: newMessage._id});
            }
        }, 15000);

        // 5. Socket Event Send
        io.to(socketId).emit('send_sms_command', { phone, msg, id: newMessage._id }, async (response) => {
            if(!responseSent) {
                clearTimeout(timeout);
                responseSent = true;
                
                // 6. Mobile App se Response aane par DB update
                if(response.success) {
                    newMessage.status = 'Sent';
                } else {
                    newMessage.status = 'Failed';
                    newMessage.errorMessage = response.error || "App reported failure";
                }
                await newMessage.save();

                res.json({ ...response, messageId: newMessage._id }); 
            }
        });

    } catch (err) {
        console.error("SMS API Error:", err);
        res.status(500).json({ error: err.message });
    }
});

server.listen(PORT, () => console.log(`🚀 Production Server running on Port ${PORT}`));