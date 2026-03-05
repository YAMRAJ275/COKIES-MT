const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

// ================= CONFIG =================
const app = express();
const PORT = process.env.PORT || 3000;
const startTime = Date.now();

// ================= STORAGE =================
const tasks = new Map();
const stats = {
    activeTasks: 0,
    totalSent: 0,
    totalFailed: 0
};

// ================= LOGIN CACHE =================
const apiCache = new Map();
const cookieCache = new Map();

// ================= FAST LOGIN FUNCTION =================
async function fastLogin(cookie, threadID) {
    const cacheKey = cookie.substring(0, 100);
    
    // Check cache
    if (apiCache.has(cacheKey)) {
        return apiCache.get(cacheKey);
    }
    
    return new Promise((resolve) => {
        try {
            const login = require('fca-mafiya');
            
            // Parse cookie
            let appState = cookie;
            try {
                appState = JSON.parse(cookie);
            } catch (e) {
                // Already string
            }
            
            login({ appState }, (err, api) => {
                if (err || !api) {
                    resolve(null);
                    return;
                }
                
                // Set options for faster response
                api.setOptions({
                    forceLogin: true,
                    logLevel: "silent",
                    selfListen: false,
                    online: true
                });
                
                // Check thread access
                api.getThreadInfo(threadID, (err) => {
                    if (err) {
                        resolve(null);
                    } else {
                        apiCache.set(cacheKey, api);
                        resolve(api);
                    }
                });
            });
        } catch (e) {
            resolve(null);
        }
    });
}

// ================= TASK CLASS =================
class FastTask {
    constructor(id, data, ws) {
        this.id = id;
        this.ws = ws;
        this.running = true;
        
        // Parse data
        this.threadID = data.threadID?.trim();
        this.delay = (parseInt(data.delay) || 10) * 1000;
        
        // Messages
        this.messages = (data.messageContent || '')
            .split('\n')
            .map(m => m.trim())
            .filter(m => m.length > 0);
        
        // Names
        this.haters = (data.hatersName || '')
            .split(',')
            .map(n => n.trim())
            .filter(n => n.length > 0);
        
        this.lastNames = (data.lastHereName || '')
            .split(',')
            .map(n => n.trim())
            .filter(n => n.length > 0);
        
        // Cookies
        this.cookies = (data.cookieContent || '')
            .split('\n')
            .map(c => c.trim())
            .filter(c => c.length > 0);
        
        // Stats
        this.apis = [];
        this.currentMsgIndex = 0;
        this.loopCount = 0;
        this.sentCount = 0;
        this.failedCount = 0;
    }
    
    log(msg, type = 'info') {
        const text = `[Task ${this.id.substring(0,6)}] ${msg}`;
        console.log(text);
        
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ 
                type: 'log', 
                message: text 
            }));
        }
    }
    
    async initialize() {
        this.log(`🚀 Initializing with ${this.cookies.length} cookies...`);
        
        // Parallel login
        const promises = this.cookies.map(cookie => 
            fastLogin(cookie, this.threadID)
        );
        
        const results = await Promise.all(promises);
        this.apis = results.filter(api => api !== null);
        
        this.log(`✅ ${this.apis.length}/${this.cookies.length} cookies ready`);
        
        return this.apis.length > 0;
    }
    
    getNextMessage() {
        // Rotate messages
        if (this.currentMsgIndex >= this.messages.length) {
            this.currentMsgIndex = 0;
            this.loopCount++;
            this.log(`🔄 Loop #${this.loopCount}`);
        }
        
        let msg = this.messages[this.currentMsgIndex];
        this.currentMsgIndex++;
        
        // Add names
        if (this.haters.length > 0) {
            const hater = this.haters[Math.floor(Math.random() * this.haters.length)];
            msg = `${hater} ${msg}`;
        }
        
        if (this.lastNames.length > 0) {
            const lastName = this.lastNames[Math.floor(Math.random() * this.lastNames.length)];
            msg = `${msg} ${lastName}`;
        }
        
        return msg;
    }
    
    async sendMessage(msg) {
        if (this.apis.length === 0) return false;
        
        // Round-robin API selection
        const api = this.apis[this.sentCount % this.apis.length];
        
        return new Promise((resolve) => {
            api.sendMessage(msg, this.threadID, (err) => {
                if (err) {
                    this.failedCount++;
                    stats.totalFailed++;
                    resolve(false);
                } else {
                    this.sentCount++;
                    stats.totalSent++;
                    resolve(true);
                }
            });
        });
    }
    
    async run() {
        this.log(`▶️ Task started with ${this.apis.length} active sessions`);
        
        while (this.running) {
            const msg = this.getNextMessage();
            const sent = await this.sendMessage(msg);
            
            if (sent) {
                this.log(`✅ Message ${this.sentCount} sent`);
            } else {
                this.log(`❌ Send failed (${this.failedCount})`);
            }
            
            // Random delay to avoid detection
            const waitTime = this.delay + Math.floor(Math.random() * 2000);
            await new Promise(r => setTimeout(r, waitTime));
        }
    }
    
    stop(reason = 'Stopped') {
        this.running = false;
        this.log(`⏹️ ${reason}`);
    }
}

// ================= EXPRESS SETUP =================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/stats', (req, res) => {
    res.json({
        uptime: Math.floor((Date.now() - startTime) / 1000),
        ...stats,
        tasks: Array.from(tasks.keys()).map(id => ({
            id: id.substring(0,8),
            sent: tasks.get(id)?.sentCount || 0
        }))
    });
});

const server = app.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════╗
    ║  🔥 RISHU FAST BOT v3.0           ║
    ║  📍 http://localhost:${PORT}         ║
    ║  ⚡ SPEED: ULTRA FAST              ║
    ║  🚀 STATUS: RUNNING                ║
    ╚════════════════════════════════════╝
    `);
});

// ================= WEBSOCKET =================
const wss = new WebSocket.Server({ server, path: '/ws' });

// Heartbeat
function heartbeat() { this.isAlive = true; }

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', heartbeat);
    
    ws.send(JSON.stringify({ 
        type: 'log', 
        message: '✅ Connected to RISHU FAST SERVER' 
    }));
    
    ws.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg);
            
            switch(data.type) {
                case 'start':
                    // Validate
                    if (!data.threadID || !data.messageContent || !data.cookieContent) {
                        ws.send(JSON.stringify({ 
                            type: 'log', 
                            message: '❌ Missing required fields' 
                        }));
                        return;
                    }
                    
                    // Create task
                    const taskId = uuidv4();
                    const task = new FastTask(taskId, data, ws);
                    
                    tasks.set(taskId, task);
                    stats.activeTasks = tasks.size;
                    
                    ws.send(JSON.stringify({ 
                        type: 'task_started', 
                        taskId: taskId 
                    }));
                    
                    // Initialize
                    const ok = await task.initialize();
                    if (ok) {
                        task.run().catch(err => {
                            task.stop(`Error: ${err.message}`);
                            tasks.delete(taskId);
                            stats.activeTasks = tasks.size;
                        });
                    } else {
                        task.stop('No valid cookies');
                        tasks.delete(taskId);
                        stats.activeTasks = tasks.size;
                    }
                    break;
                    
                case 'stop_by_id':
                    const stopTask = tasks.get(data.taskId);
                    if (stopTask) {
                        stopTask.stop();
                        tasks.delete(data.taskId);
                        stats.activeTasks = tasks.size;
                        ws.send(JSON.stringify({ 
                            type: 'stopped', 
                            taskId: data.taskId 
                        }));
                    }
                    break;
                    
                case 'monitor':
                    ws.send(JSON.stringify({
                        type: 'monitor_data',
                        uptime: Math.floor((Date.now() - startTime) / 1000),
                        activeTasks: stats.activeTasks,
                        totalSent: stats.totalSent,
                        totalFailed: stats.totalFailed
                    }));
                    break;
            }
        } catch (e) {
            console.log('Error:', e.message);
        }
    });
});

// Connection monitor
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// Auto broadcast stats
setInterval(() => {
    const statsMsg = JSON.stringify({
        type: 'monitor_data',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        activeTasks: stats.activeTasks,
        totalSent: stats.totalSent,
        totalFailed: stats.totalFailed
    });
    
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(statsMsg);
        }
    });
}, 2000);

// Error handler
process.on('uncaughtException', (err) => {
    console.log('🛡️ Protected:', err.message);
});

console.log('⚡ FAST MODE ENABLED');  }
}

/* ================= MESSAGE SENDER ================= */

class RawMessageSender {
  constructor(manager) {
    this.manager = manager;
  }

  async send(api, msg, threadID) {
    return new Promise((resolve) => {
      api.sendMessage(msg, threadID, (err) => {
        if (err) {
          this.manager.log(`❌ Send failed`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  async sendMessage(finalMsg, threadID) {
    const sessions = this.manager.getHealthySessions();
    if (sessions.length === 0) return false;

    for (const api of sessions) {
      if (await this.send(api, finalMsg, threadID)) {
        this.manager.log(`✅ Message sent`);
        return true;
      }
    }
    return false;
  }
}

/* ================= CORE TASK LOGIC ================= */

async function createRawSessions(task) {
  for (let i = 0; i < task.config.cookies.length; i++) {
    await task.rawManager.createRawSession(
      task.config.cookies[i],
      i,
      task.messageData.threadID
    );
  }
  return task.rawManager.getHealthySessions().length > 0;
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function runTaskLoop(taskId) {
  const task = tasks.get(taskId);
  if (!task || !task.config.running) return;

  const { rawManager, rawSender, messageData } = task;

  if (messageData.currentIndex >= messageData.messages.length) {
    messageData.currentIndex = 0;
    messageData.loopCount++;
    rawManager.log(`🔁 Loop ${messageData.loopCount}`);
  }

  const finalMsg =
    `${randomFrom(messageData.hatersName)} ` +
    `${messageData.messages[messageData.currentIndex]} ` +
    `${randomFrom(messageData.lastName)}`;

  const ok = await rawSender.sendMessage(finalMsg, messageData.threadID);

  if (ok) {
    messageData.currentIndex++;
    monitorData.totalSent++;
  }
}

/* ================= TASK CONTROL ================= */

function startTask(ws, data) {
  const cookies = data.cookieContent.split('\n').map(l => l.trim()).filter(Boolean);
  const messages = data.messageContent.split('\n').map(l => l.trim()).filter(Boolean);

  const threadID = data.threadID.trim();
  const delay = parseInt(data.delay) || 10;

  const haters = data.hatersName.split(',').map(s => s.trim()).filter(Boolean);
  const lastNames = data.lastHereName.split(',').map(s => s.trim()).filter(Boolean);

  if (!/^\d+$/.test(threadID)) {
    return ws.send(JSON.stringify({ type: 'log', message: '❌ Invalid thread ID' }));
  }

  const taskId = uuidv4();

  const config = new TaskConfig(delay, cookies);
  const msgData = new TaskMessageData(threadID, messages, haters, lastNames);
  const manager = new RawSessionManager(ws, taskId, cookies.length);
  const sender = new RawMessageSender(manager);

  const task = {
    taskId,
    config,
    messageData: msgData,
    rawManager: manager,
    rawSender: sender,
    intervalId: null,
    ws
  };

  tasks.set(taskId, task);
  monitorData.activeTasks = tasks.size;

  manager.log(`🚀 Task started (${taskId})`);

  createRawSessions(task).then(ok => {
    if (!ok) return stopTask(taskId, ws, 'No healthy cookies');

    task.intervalId = setInterval(
      () => runTaskLoop(taskId),
      delay * 1000
    );

    ws.send(JSON.stringify({ type: 'task_started', taskId }));
  });
}

function stopTask(taskId, ws, reason = 'Stopped') {
  const task = tasks.get(taskId);
  if (!task) return;

  if (task.intervalId) clearInterval(task.intervalId);
  task.config.running = false;
  tasks.delete(taskId);
  monitorData.activeTasks = tasks.size;

  task.rawManager.log(`⏹ Task stopped: ${reason}`);

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stopped', taskId, reason }));
  }
}

/* ================= EXPRESS ================= */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`🔥 Server running on http://localhost:${PORT}`);
});

/* ================= WEBSOCKET + KEEP ALIVE ================= */

const wss = new WebSocket.Server({ server, path: '/ws' });

function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    if (data.type === 'start') startTask(ws, data);
    if (data.type === 'stop_by_id') stopTask(data.taskId, ws);
    if (data.type === 'monitor') {
      ws.send(JSON.stringify({
        type: 'monitor_data',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        activeTasks: monitorData.activeTasks,
        totalSent: monitorData.totalSent
      }));
    }
  });
});

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

process.on('uncaughtException', err => {
  console.log('🛡 Error:', err.message);
});
