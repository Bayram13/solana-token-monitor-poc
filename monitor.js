// monitor.js
const seenSig = await redisClient.get(`sig:${sig}`);
if (seenSig) return;
await redisClient.set(`sig:${sig}`, '1', { EX: 60 * 60 * 6 }); // 6h


// Fetch transaction
const tx = await connection.getTransaction(sig, { commitment: 'confirmed' });
if (!tx) return;


// Inspect instructions to find candidate mint account(s)
const message = tx.transaction.message;
const instructions = message.instructions || [];


const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';


for (const ix of instructions) {
const programId = message.accountKeys[ix.programIdIndex]?.toString();
if (programId !== TOKEN_PROGRAM_ID) continue;


// candidate mint often is the first account in instruction.keys
const mintIndex = ix.accounts && ix.accounts.length > 0 ? ix.accounts[0] : null;
if (mintIndex === null) continue;
const candMint = message.accountKeys[mintIndex].toString();


// dedupe by mint
const seenMint = await redisClient.get(`mint:${candMint}`);
if (seenMint) continue;
await redisClient.set(`mint:${candMint}`, '1', { EX: 60 * 60 * 12 });


// Gather some token info
let supply = 0;
try {
const supplyResp = await connection.getTokenSupply(candMint);
supply = supplyResp?.value?.uiAmount || 0;
} catch (e) {
// ignore
}


let largest = [];
try {
const largestResp = await connection.getTokenLargestAccounts(candMint);
largest = largestResp?.value || [];
} catch (e) {
// ignore
}


const top1 = largest[0]?.uiAmount || 0;
const top10 = largest.slice(0, 10).reduce((s, v) => s + (v?.uiAmount || 0), 0);
const top1Pct = supply ? (top1 / supply) * 100 : 0;
const top10Pct = supply ? (top10 / supply) * 100 : 0;


// Simple heuristic score
const score = (top1Pct * 0.6) + (top10Pct * 0.3) + (supply < 1e9 ? 0.1 : 0);


// Build alert text (compact)
const text = `New token detected | Mint: ${candMint}\nSupply: ${supply}\nTop1: ${top1Pct.toFixed(2)}% | Top10: ${top10Pct.toFixed(2)}%\nRisk score: ${score.toFixed(3)}\nTx: https://explorer.solana.com/tx/${sig}`;


// send if score above threshold
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
