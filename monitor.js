// monitor.js
const { Connection } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const Redis = require('redis');


// Environment
const RPC = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // channel id or chat id
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';


if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
console.error('TELEGRAM_TOKEN and TELEGRAM_CHAT_ID required in env');
process.exit(1);
}


const connection = new Connection(RPC, 'confirmed');
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });


// Redis client — Upstash rediss:// dəstəyi üçün socket TLS enable edilir
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
})();
