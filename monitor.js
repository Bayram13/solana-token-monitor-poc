const http = require("http");
const { Connection } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const Redis = require('redis');

// RPC list for rotation (to avoid 429 errors)
const RPCs = [
  process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com",
  "https://solana-api.projectserum.com"
];
let currentRpc = 0;
function getConnection() {
  currentRpc = (currentRpc + 1) % RPCs.length;
  return new Connection(RPCs[currentRpc], 'confirmed');
}

// Env
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('TELEGRAM_TOKEN and TELEGRAM_CHAT_ID required in env');
  process.exit(1);
}

let connection = getConnection();
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// Redis — Upstash TLS dəstəyi
const redisClient = Redis.createClient({
  url: REDIS_URL,
  socket: REDIS_URL.startsWith('rediss://') ? { tls: true } : {},
});

redisClient.on('error', (e) => console.error('Redis error', e));

(async () => {
  await redisClient.connect();
  console.log('Redis connected');

  console.log('Subscribing to logs...');

  connection.onLogs('all', async (logs) => {
    try {
      const sig = logs.signature;
      if (!sig) return;
      const logStr = (logs.logs || []).join(' ');

      if (!/InitializeMint|create_account|initialize_mint/i.test(logStr)) return;

      const seenSig = await redisClient.get(`sig:${sig}`);
      if (seenSig) return;
      await redisClient.set(`sig:${sig}`, '1', { EX: 60 * 60 * 6 });

      // ✅ Fix: maxSupportedTransactionVersion added
      let tx;
      try {
        tx = await connection.getTransaction(sig, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
      } catch (rpcErr) {
        console.error("getTransaction failed, switching RPC:", rpcErr.message);
        connection = getConnection(); // switch RPC
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
          const supplyResp = await connection.getTokenSupply(candMint);
          supply = supplyResp?.value?.uiAmount || 0;
        } catch (e) {}

        let largest = [];
        try {
          const largestResp = await connection.getTokenLargestAccounts(candMint);
          largest = largestResp?.value || [];
        } catch (e) {}

        const top1 = largest[0]?.uiAmount || 0;
        const top10 = largest.slice(0, 10).reduce((s, v) => s + (v?.uiAmount || 0), 0);
        const top1Pct = supply ? (top1 / supply) * 100 : 0;
        const top10Pct = supply ? (top10 / supply) * 100 : 0;

        const score = (top1Pct * 0.6) + (top10Pct * 0.3) + (supply < 1e9 ? 0.1 : 0);

        const text = `New token detected | Mint: ${candMint}\nSupply: ${supply}\nTop1: ${top1Pct.toFixed(2)}% | Top10: ${top10Pct.toFixed(2)}%\nRisk score: ${score.toFixed(3)}\nTx: https://explorer.solana.com/tx/${sig}`;

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
  }, 'confirmed');
})();
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Solana monitor is running\n");
}).listen(PORT, () => {
  console.log(`Healthcheck server running on port ${PORT}`);
});
