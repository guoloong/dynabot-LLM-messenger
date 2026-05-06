// index.js
require('dotenv').config({ path: './env' });
const { startHeartbeat } = require('./utils/keepAlive');
const { initWhatsAppBot } = require('./bot/whatsappBot');

if (!process.env.DEEPSEEK_API_KEY) {
    console.error('❌ DEEPSEEK_API_KEY missing in .env');
    process.exit(1);
}
console.log('🔑 DeepSeek API key loaded');
startHeartbeat(120000);
console.log('🤖 Starting Dyna-Nutrition WhatsApp bot with live search...');
initWhatsAppBot();

process.on('SIGINT', () => {
    console.log('🛑 Shutting down...');
    process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));