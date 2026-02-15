import React, { useEffect, useState, useRef } from 'react';
import { 
  View, Text, TextInput, Button, StyleSheet, 
  PermissionsAndroid, ScrollView, Alert, ActivityIndicator, 
  TouchableOpacity, ToastAndroid, StatusBar, Platform, FlatList, RefreshControl 
} from 'react-native';
import io from 'socket.io-client';
import SmsAndroid from 'react-native-get-sms-android';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BackgroundService from 'react-native-background-actions';
import { API_URL } from '@env';

// --- 🌙 BACKGROUND TASK LOGIC (Sirf Normal Users ke liye) ---
const sleep = (time) => new Promise((resolve) => setTimeout(() => resolve(), time));

const backgroundTask = async (taskDataArguments) => {
    const { deviceId, apiUrl, userName } = taskDataArguments;
    
    console.log("🌙 Background Service Starting...");
    
    const socket = io(apiUrl, {
        auth: { deviceId: deviceId },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 2000,
    });

    socket.on('connect', () => {
        console.log('🌙 Background: Connected ✅');
        BackgroundService.updateNotification({ 
            taskDesc: `Connected as ${userName} 🟢`,
            progressBar: { max: 10, value: 10, indeterminate: false }
        });
    });

    socket.on('disconnect', () => {
        console.log('🌙 Background: Disconnected ❌');
        BackgroundService.updateNotification({ taskDesc: 'Reconnecting... 🔴' });
    });

    socket.on('send_sms_command', (data, callback) => {
        console.log(`🌙 SMS Request to: ${data.phone}`);
        try {
            SmsAndroid.autoSend(
                data.phone,
                data.msg,
                (fail) => {
                    console.log('🌙 SMS Failed:', fail);
                    if (callback) callback({ success: false, error: "SMS Fail" });
                },
                (success) => {
                    console.log('🌙 SMS Sent ✅');
                    if (callback) callback({ success: true, message: "Sent from Background" });
                }
            );
        } catch (error) {
            console.log('🌙 SMS Error:', error);
        }
    });

    await new Promise(async (resolve) => {
        while (BackgroundService.isRunning()) {
            await sleep(5000); 
        }
        socket.disconnect();
        resolve();
    });
};

const options = {
    taskName: 'SMSGateway',
    taskTitle: 'SMS Gateway Active',
    taskDesc: 'Service is running in background',
    taskIcon: { name: 'ic_launcher', type: 'mipmap' },
    color: '#00ff00',
    linkingURI: 'yourSchemeHere://chat/jane',
    parameters: { delay: 1000 },
};

const App = () => {
  // --- 🚦 STATE MANAGEMENT ---
  const [currentView, setCurrentView] = useState('loading'); 
  const [userData, setUserData] = useState(null); 
  
  // Login/Register Inputs
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState(''); 

  // Gateway Logs & Status (User Only)
  const [status, setStatus] = useState('Offline 🔴');
  const [logs, setLogs] = useState([]);
  const [isServiceRunning, setIsServiceRunning] = useState(false);
  const socketRef = useRef(null);

  // Admin Data (Admin Only)
  const [allUsers, setAllUsers] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  // --- 🔄 APP STARTUP CHECK ---
  useEffect(() => {
    checkLoginStatus();
  }, []);

  const checkLoginStatus = async () => {
    try {
      const storedUser = await AsyncStorage.getItem('user_session');
      if (storedUser) {
        const user = JSON.parse(storedUser);
        setUserData(user);
        setCurrentView('home');
        
        // Agar normal user hai, toh service check karo
        if (user.role !== 'admin') {
            setIsServiceRunning(BackgroundService.isRunning());
        } else {
            // Agar Admin hai, toh users fetch karo
            fetchUsersList();
        }
      } else {
        setCurrentView('login');
      }
    } catch (e) {
      setCurrentView('login');
    }
  };

  // --- 👑 ADMIN FUNCTIONS ---
  const fetchUsersList = async () => {
      setRefreshing(true);
      try {
          const response = await fetch(`${API_URL}/admin/users`);
          const data = await response.json();
          if (data.success) {
              setAllUsers(data.users);
          }
      } catch (error) {
          console.error("Fetch Error", error);
      } finally {
          setRefreshing(false);
      }
  };

  const deleteUser = async (id) => {
      Alert.alert(
          "Delete User",
          "Are you sure? This will disconnect the device.",
          [
              { text: "Cancel", style: "cancel" },
              { 
                  text: "Delete", 
                  style: "destructive",
                  onPress: async () => {
                      try {
                          const response = await fetch(`${API_URL}/admin/user/${id}`, { method: 'DELETE' });
                          const data = await response.json();
                          if(data.success) {
                              ToastAndroid.show("User Deleted", ToastAndroid.SHORT);
                              fetchUsersList(); // Refresh list
                          } else {
                              Alert.alert("Error", data.message);
                          }
                      } catch (err) {
                          Alert.alert("Error", "Could not delete user");
                      }
                  }
              }
          ]
      );
  };

  // --- 🔐 AUTHENTICATION FUNCTIONS ---
  const handleLogin = async () => {
    if (!email || !password) return Alert.alert("Error", "Please fill all fields");

    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await response.json();

      if (data.success) {
        // Role ko user object mein merge karke save karo
        const userWithRole = { ...data.user, role: data.role || 'user' };
        
        await AsyncStorage.setItem('user_session', JSON.stringify(userWithRole));
        setUserData(userWithRole);
        setCurrentView('home');
        ToastAndroid.show(`Welcome ${userWithRole.role === 'admin' ? 'Admin' : 'User'}!`, ToastAndroid.SHORT);
        
        // Agar Admin hai toh list load karo
        if (data.role === 'admin') fetchUsersList();

      } else {
        Alert.alert("Login Failed", data.message || "Invalid credentials");
      }
    } catch (error) {
      console.error(error);
      Alert.alert("Connection Error", `Could not connect to Server`);
    }
  };

  const handleRegister = async () => {
    if (!name || !email || !password) return Alert.alert("Error", "Please fill all fields");

    try {
      const response = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password })
      });
      const data = await response.json();

      if (data.success || response.status === 201) {
        Alert.alert("Success", "Account created! Please Login.");
        setCurrentView('login');
      } else {
        Alert.alert("Registration Failed", data.message || "Something went wrong");
      }
    } catch (error) {
      Alert.alert("Error", "Could not connect to server.");
    }
  };

  const handleLogout = async () => {
    if (BackgroundService.isRunning()) {
        await BackgroundService.stop();
        setIsServiceRunning(false);
    }
    if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
    }
    await AsyncStorage.removeItem('user_session');
    setUserData(null);
    setAllUsers([]); // Clear admin data
    setCurrentView('login');
    setStatus('Offline 🔴');
    setLogs([]);
  };

  // --- ⏯️ SERVICE CONTROL (USER ONLY) ---
  const toggleService = async () => {
      if (isServiceRunning) {
          await BackgroundService.stop();
          setIsServiceRunning(false);
          addLog("🛑 Background Service Stopped");
          connectSocket();
      } else {
          await requestPermissions();
          if (socketRef.current) {
              socketRef.current.disconnect();
              socketRef.current = null;
          }
          await BackgroundService.start(backgroundTask, {
              ...options,
              parameters: {
                  deviceId: userData.deviceId,
                  apiUrl: API_URL,
                  userName: userData.name
              }
          });
          setIsServiceRunning(true);
          setStatus('Background Service Active 🚀');
          addLog("🚀 Background Service Started");
      }
  };

  // --- 📡 SOCKET & SMS LOGIC (USER ONLY) ---
  useEffect(() => {
    // Admin ko socket se connect nahi karna hai
    if (currentView === 'home' && userData && userData.role !== 'admin' && !isServiceRunning) {
      requestPermissions();
      connectSocket();
    }
    return () => {
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, [currentView, userData, isServiceRunning]);

  const addLog = (text) => setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${text}`, ...prev.slice(0, 50)]);

  const connectSocket = () => {
    if (isServiceRunning) return; 
    if (socketRef.current && socketRef.current.connected) return;

    addLog(`Connecting to Cloud...`);

    const newSocket = io(API_URL, {
      auth: { deviceId: userData.deviceId },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });

    newSocket.on('connect', () => {
      setStatus(`Online: ${userData.name} 🟢`);
      addLog('✅ Connected to Secure Gateway');
    });

    newSocket.on('disconnect', (reason) => {
      setStatus('Offline 🔴');
      addLog(`❌ Disconnected: ${reason}`);
    });

    newSocket.on('send_sms_command', (data, callback) => {
      addLog(`📩 Request: SMS to ${data.phone}`);
      try {
        SmsAndroid.autoSend(
          data.phone,
          data.msg,
          (fail) => {
            addLog(`🚫 Send Failed: ${fail}`);
            if (callback) callback({ success: false, error: "Fail" });
          },
          (success) => {
            addLog(`✅ SMS Sent Successfully`);
            if (callback) callback({ success: true, message: "Sent" });
          }
        );
      } catch (error) {
        addLog(`🚫 App Error: ${error}`);
      }
    });

    socketRef.current = newSocket;
  };

  async function requestPermissions() {
    try {
      const permissions = [
        PermissionsAndroid.PERMISSIONS.SEND_SMS,
        PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
      ];
      if (Platform.Version >= 33) {
          permissions.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      }
      const granted = await PermissionsAndroid.requestMultiple(permissions);
      if (granted['android.permission.SEND_SMS'] !== PermissionsAndroid.RESULTS.GRANTED) {
         Alert.alert("Permission Denied", "SMS permission is required.");
      }
    } catch (err) { console.warn(err); }
  }

  // --- 🖥️ UI RENDERING ---

  if (currentView === 'loading') {
    return (
      <View style={[styles.container, styles.center]}>
        <StatusBar barStyle="light-content" backgroundColor="#111" />
        <ActivityIndicator size="large" color="#00ff00" />
      </View>
    );
  }

  // 1. LOGIN SCREEN
  if (currentView === 'login') {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#111" />
        <Text style={styles.header}>🔐 Gateway Login</Text>
        <View style={styles.card}>
          <TextInput 
            style={styles.input} placeholder="Email Address" 
            placeholderTextColor="#666" onChangeText={setEmail} value={email} autoCapitalize="none" keyboardType="email-address"
          />
          <TextInput 
            style={styles.input} placeholder="Password" 
            placeholderTextColor="#666" secureTextEntry onChangeText={setPassword} value={password}
          />
          <Button title="Login" onPress={handleLogin} color="#007AFF" />
          
          <TouchableOpacity onPress={() => setCurrentView('register')} style={styles.linkContainer}>
            <Text style={styles.linkText}>New here? Create Account</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // 2. REGISTER SCREEN
  if (currentView === 'register') {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#111" />
        <Text style={styles.header}>📝 Create Account</Text>
        <View style={styles.card}>
          <TextInput 
            style={styles.input} placeholder="Device/User Name" 
            placeholderTextColor="#666" onChangeText={setName} value={name}
          />
          <TextInput 
            style={styles.input} placeholder="Email Address" 
            placeholderTextColor="#666" onChangeText={setEmail} value={email} autoCapitalize="none" keyboardType="email-address"
          />
          <TextInput 
            style={styles.input} placeholder="Password" 
            placeholderTextColor="#666" secureTextEntry onChangeText={setPassword} value={password}
          />
          <Button title="Register" onPress={handleRegister} color="#28a745" />
          
          <TouchableOpacity onPress={() => setCurrentView('login')} style={styles.linkContainer}>
            <Text style={styles.linkText}>Already have an account? Login</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // 3. HOME SCREEN (CONDITION: ADMIN or USER)
  
  // --- 🅰️ ADMIN DASHBOARD UI ---
  if (currentView === 'home' && userData?.role === 'admin') {
      return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" backgroundColor="#111" />
            <View style={styles.topBar}>
                <Text style={styles.welcomeText}>👑 Admin Panel</Text>
                <Button title="Logout" onPress={handleLogout} color="#d9534f" />
            </View>

            <Text style={styles.infoLabel}>All Registered Devices</Text>
            
            <FlatList 
                data={allUsers}
                keyExtractor={(item) => item._id}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={fetchUsersList} tintColor="#fff"/>}
                renderItem={({ item }) => (
                    <View style={styles.userCard}>
                        <View style={styles.userHeader}>
                            <Text style={styles.userName}>{item.name}</Text>
                            {/* Online/Offline Status Dot */}
                            <View style={[styles.statusDot, { backgroundColor: item.isOnline ? '#00ff00' : '#555' }]} />
                        </View>
                        <Text style={styles.userEmail}>{item.email}</Text>
                        <Text style={styles.userDevice}>ID: {item.deviceId}</Text>
                        <Text style={styles.lastSeen}>Last Seen: {new Date(item.lastSeen).toLocaleString()}</Text>
                        
                        <TouchableOpacity 
                            style={styles.deleteBtn} 
                            onPress={() => deleteUser(item._id)}
                        >
                            <Text style={styles.deleteBtnText}>DELETE USER</Text>
                        </TouchableOpacity>
                    </View>
                )}
                ListEmptyComponent={<Text style={styles.emptyLog}>No users found. Pull to refresh.</Text>}
            />
        </View>
      );
  }

  // --- 👤 NORMAL USER DASHBOARD UI ---
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#111" />
      <View style={styles.topBar}>
        <View>
            <Text style={styles.welcomeLabel}>Device Active</Text>
            <Text style={styles.welcomeText}>{userData?.name}</Text>
        </View>
        <Button title="Logout" onPress={handleLogout} color="#d9534f" />
      </View>

      <View style={styles.infoBox}>
        <View style={styles.row}>
            <Text style={styles.infoLabel}>ID:</Text>
            <Text style={styles.infoValue}>{userData?.deviceId}</Text>
        </View>
        <View style={styles.divider} />
        <Text style={styles.infoLabel}>API Key (Keep Secret):</Text>
        <Text style={styles.infoValue} selectable>{userData?.apiKey}</Text>
      </View>

      <TouchableOpacity 
        style={[styles.serviceBtn, { backgroundColor: isServiceRunning ? '#d9534f' : '#28a745' }]}
        onPress={toggleService}
      >
        <Text style={styles.serviceBtnText}>
            {isServiceRunning ? "🛑 STOP BACKGROUND SERVICE" : "🚀 START BACKGROUND SERVICE"}
        </Text>
      </TouchableOpacity>

      <Text style={[styles.status, { color: status.includes('Active') || status.includes('Online') ? '#00ff00' : '#ff4444' }]}>
        {status}
      </Text>

      <View style={styles.logsWrapper}>
        <Text style={styles.logHeader}>Activity Logs (Last 50)</Text>
        <ScrollView style={styles.logsContainer} nestedScrollEnabled={true}>
            {logs.length === 0 && <Text style={styles.emptyLog}>Waiting for commands...</Text>}
            {isServiceRunning && <Text style={styles.logText}>[Info] Logs are hidden while running in background to save battery.</Text>}
            {logs.map((log, index) => (
            <Text key={index} style={styles.logText}>{log}</Text>
            ))}
        </ScrollView>
      </View>
    </View>
  );
};

// --- 🎨 STYLES ---
const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#0f0f0f' },
  center: { justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: '#0f0', marginTop: 15, fontSize: 16 },
  header: { fontSize: 28, color: '#fff', fontWeight: 'bold', marginBottom: 30, textAlign: 'center', marginTop: 50 },
  card: { backgroundColor: '#1e1e1e', padding: 20, borderRadius: 12, elevation: 5 },
  input: { backgroundColor: '#333', color: '#fff', padding: 12, borderRadius: 8, marginBottom: 15, fontSize: 16, borderWidth: 1, borderColor: '#444' },
  linkContainer: { marginTop: 20, alignItems: 'center' },
  linkText: { color: '#007AFF', fontSize: 16 },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, marginTop: 10 },
  welcomeLabel: { color: '#888', fontSize: 12 },
  welcomeText: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
  infoBox: { backgroundColor: '#1a1a1a', padding: 15, borderRadius: 12, marginBottom: 20, borderWidth: 1, borderColor: '#333' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  divider: { height: 1, backgroundColor: '#333', marginVertical: 10 },
  infoLabel: { color: '#aaa', fontSize: 12, marginBottom: 4 },
  infoValue: { color: '#00ff00', fontSize: 14, fontFamily: 'monospace', fontWeight: 'bold' },
  status: { fontSize: 16, textAlign: 'center', marginBottom: 15, fontWeight: 'bold', padding: 10, backgroundColor: '#222', borderRadius: 8 },
  logsWrapper: { flex: 1, backgroundColor: '#000', borderRadius: 12, borderWidth: 1, borderColor: '#333', overflow: 'hidden' },
  logHeader: { color: '#fff', padding: 10, backgroundColor: '#1a1a1a', fontWeight: 'bold', borderBottomWidth: 1, borderBottomColor: '#333' },
  logsContainer: { flex: 1, padding: 10 },
  logText: { color: '#0f0', fontFamily: 'monospace', fontSize: 12, marginBottom: 6 },
  emptyLog: { color: '#555', fontStyle: 'italic', textAlign: 'center', marginTop: 20 },
  serviceBtn: { padding: 15, borderRadius: 10, alignItems: 'center', marginBottom: 20, elevation: 3 },
  serviceBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  
  // --- ADMIN STYLES ---
  userCard: { backgroundColor: '#1e1e1e', padding: 15, borderRadius: 10, marginBottom: 10, borderWidth: 1, borderColor: '#333' },
  userHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 },
  userName: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  userEmail: { color: '#aaa', fontSize: 14, marginBottom: 5 },
  userDevice: { color: '#888', fontSize: 12, fontFamily: 'monospace' },
  lastSeen: { color: '#666', fontSize: 12, fontStyle: 'italic', marginTop: 5 },
  statusDot: { width: 12, height: 12, borderRadius: 6 },
  deleteBtn: { backgroundColor: '#330000', padding: 10, borderRadius: 5, marginTop: 10, alignItems: 'center', borderWidth: 1, borderColor: '#ff4444' },
  deleteBtnText: { color: '#ff4444', fontWeight: 'bold', fontSize: 12 }
});

export default App;