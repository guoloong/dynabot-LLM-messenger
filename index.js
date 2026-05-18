// index.js
// Main entry point for the WhatsApp bot

require('dotenv').config({ path: './env' });
const { startHeartbeat } = require('./utils/keepAlive');
const { initWhatsAppBot } = require('./bot/whatsappBot');

if (!process.env.DEEPSEEK_API_KEY) {
    console.error('[MAIN] DEEPSEEK_API_KEY missing in .env');
    process.exit(1);
}
console.log('[MAIN] DeepSeek API key loaded');
startHeartbeat(120000);
console.log('[MAIN] Starting Dyna-Nutrition WhatsApp bot with LLM routing...');
initWhatsAppBot();

process.on('SIGINT', () => {
    console.log('[MAIN] Shutting down...');
    process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));