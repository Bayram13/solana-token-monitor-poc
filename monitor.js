import WebSocket from 'ws';
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import redis from 'redis';

// ================== Config ==================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HELIUS_WS = process.env.HELIUS_WS;  // Helius WebSocket
const PORT = process.env.PORT || 10000;
const REDIS_URL = process.env.REDIS_URL;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !HELIUS_WS) {
  console.error('TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, HELIUS_WS required in env');
  process.exit(1);
}
// ============================================

// Telegram bot
const bot = new TelegramBot(TELEGRAM_TOKEN);

// Redis client
const redisClient = redis.createClient({ url: REDIS_URL });
redisClient.connect().then(() => console.log("Redis connected")).catch(console.error);

// Express healthcheck server (Render port bind)
const app = express();
app.get('/', (req, res) => res.send('✅ Token monitor is running'));
app.listen(PORT, () => console.log(`Healthcheck server running on port ${PORT}`));

// Telegram app aktiv mesaj
bot.sendMessage(TELEGRAM_CHAT_ID, '✅ Token monitor app is now active!');

// ================== Helius WS ==================
let ws;

function connectWS() {
  ws = new WebSocket(HELIUS_WS);

  ws.on('open', () => {
    console.log("Connected to Helius WebSocket");

    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [{ mentions: [] }, { commitment: "confirmed" }]
    }));
  });

  ws.on('message', async (data) => {
    try {
      const parsed = JSON.parse(data);
      if (parsed.method === 'logsNotification') {
        const logs = parsed.params.result.value.logs;
        const slot = parsed.params.result.value.slot;
        const sig = parsed.params.result.value.signature;

        const seenSig = await redisClient.get(`sig:${sig}`);
        if (seenSig) return;
        await redisClient.set(`sig:${sig}`, '1', { EX: 60 * 60 * 6 });

        const tokenLog = { sig, slot, logs };
        console.log('Token detected:', tokenLog);

        // Telegram alert
        await bot.sendMessage(TELEGRAM_CHAT_ID, `🆕 New token detected:\n${JSON.stringify(tokenLog, null, 2)}`);

        // Redis save
        await redisClient.set(`token:${slot}`, JSON.stringify(tokenLog));
      }
    } catch (err) {
      console.error('Message parsing error:', err);
    }
  });

  ws.on('error', (err) => console.error('WebSocket error:', err));
  ws.on('close', () => {
    console.log('WebSocket closed. Reconnecting in 5s...');
    setTimeout(connectWS, 5000);
  });
}

// Start WS
connectWS();
