import WebSocket from 'ws';
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import redis from 'redis';
import { Connection, PublicKey } from '@solana/web3.js';

// ================== Config ==================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HELIUS_WS = process.env.HELIUS_WS;  // Helius WebSocket
const PORT = process.env.PORT || 10000;
const REDIS_URL = process.env.REDIS_URL;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !HELIUS_WS || !REDIS_URL) {
  console.error('TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, HELIUS_WS, REDIS_URL required in env');
  process.exit(1);
}

// Telegram bot
const bot = new TelegramBot(TELEGRAM_TOKEN);

// Redis client
const redisClient = redis.createClient({ url: REDIS_URL });
redisClient.connect()
  .then(() => console.log("Redis connected"))
  .catch(console.error);

// Express healthcheck server
const app = express();
app.get('/', (req, res) => res.send('✅ Solana Token Monitor running'));
app.listen(PORT, () => console.log(`Healthcheck server running on port ${PORT}`));

// Telegram app aktiv mesaj
bot.sendMessage(TELEGRAM_CHAT_ID, '✅ Token monitor app is now active!');

// ================== Helius WS ==================
let ws;
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed"); // fallback RPC for getTransaction

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
      if (parsed.method !== 'logsNotification') return;

      const logsValue = parsed.params.result.value;
      const logs = logsValue.logs;
      const sig = logsValue.signature;

      if (!logs || !sig) return;

      const seenSig = await redisClient.get(`sig:${sig}`);
      if (seenSig) return;
      await redisClient.set(`sig:${sig}`, '1', { EX: 60 * 60 * 6 });

      // Only process mint-related logs
      if (!/InitializeMint|create_account|initialize_mint/i.test(logs.join(' '))) return;

      // Fetch transaction for deeper analysis
      let tx;
      try {
        tx = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      } catch (rpcErr) {
        console.error("getTransaction failed:", rpcErr.message);
        return;
      }
      if (!tx) return;

      const message = tx.transaction.message;
      const instructions = message.instructions || [];
      const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

      for (const ix of instructions) {
        const programId = message.accountKeys[ix.programIdIndex]?.toString();
        if (programId !== TOKEN_PROGRAM_ID) continue;

        const mintIndex = ix.accounts && ix.accounts.length > 0 ? ix.accounts[0] : null;
        if (mintIndex === null) continue;
        const candMint = message.accountKeys[mintIndex].toString();

        const seenMint = await redisClient.get(`mint:${candMint}`);
        if (seenMint) continue;
        await redisClient.set(`mint:${candMint}`, '1', { EX: 60 * 60 * 12 });

        let supply = 0;
        try {
          const supplyResp = await connection.getTokenSupply(new PublicKey(candMint));
          supply = supplyResp?.value?.uiAmount || 0;
        } catch (e) {}

        let largest = [];
        try {
          const largestResp = await connection.getTokenLargestAccounts(new PublicKey(candMint));
          largest = largestResp?.value || [];
        } catch (e) {}

        const top1 = largest[0]?.uiAmount || 0;
        const top10 = largest.slice(0, 10).reduce((s, v) => s + (v?.uiAmount || 0), 0);
        const top1Pct = supply ? (top1 / supply) * 100 : 0;
        const top10Pct = supply ? (top10 / supply) * 100 : 0;
        const score = (top1Pct * 0.6) + (top10Pct * 0.3) + (supply < 1e9 ? 0.1 : 0);

        const text = `🆕 New token detected\nMint: ${candMint}\nSupply: ${supply}\nTop1: ${top1Pct.toFixed(2)}% | Top10: ${top10Pct.toFixed(2)}%\nRisk score: ${score.toFixed(3)}\nTx: https://explorer.solana.com/tx/${sig}`;

        if (score > 0.5) {
          try {
            await bot.sendMessage(TELEGRAM_CHAT_ID, text);
            console.log('Alert sent for', candMint);
          } catch (e) {
            console.error('Telegram send error', e);
          }
        } else {
          console.log('Token found but score low', candMint, score.toFixed(3));
        }
      }

    } catch (err) {
      console.error('onLogs err', err);
    }
  });

  ws.on('error', (err) => console.error('WebSocket error:', err));
  ws.on('close', () => {
    console.log('WebSocket closed. Reconnecting in 5s...');
    setTimeout(connectWS, 5000);
  });
}

connectWS();
