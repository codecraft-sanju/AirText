const mongoose = require('mongoose');

// Apne MongoDB ka URL yahan dalein (Localhost ya MongoDB Atlas)
const MONGO_URI = "mongodb://localhost:27017/sms-gateway";

mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log("Connected to DB...");

        // Schema wahi same hona chahiye
        const UserSchema = new mongoose.Schema({
            name: String,
            apiKey: String,
            deviceId: String,
            isActive: Boolean
        });
        const User = mongoose.model('User', UserSchema);

        // Purana data saaf karein (Optional)
        await User.deleteMany({});

        // Naya User Create karein
        await User.create({
            name: "Admin User",
            apiKey: "my_secret_key_123",  // Isko API call me use karoge
            deviceId: "user_1",           // Ye App me daloge
            isActive: true
        });

        console.log("✅ User Added! Now run index.js");
        process.exit();
    })
    .catch(err => console.log(err));