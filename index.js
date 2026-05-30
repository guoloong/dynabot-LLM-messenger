// index.js
// Main entry point for Dyna-Nutrition Bot (WhatsApp & Messenger)

// CRITICAL: Load dotenv BEFORE importing any modules that use process.env
require('dotenv').config({ path: './env' });

// Import LLM provider factory for validation (after dotenv loads)
const { getStatus, getProviderName } = require('./services/llm');
const { startHeartbeat } = require('./utils/keepAlive');
const { initWhatsAppBot } = require('./bot/whatsappBot');
const { initMessengerBot } = require('./bot/messengerBot');

// Platform configuration
const PLATFORM = process.env.PLATFORM || 'messenger';
const PORT = process.env.PORT || 3000;

// Validate required environment variables
function validateEnv() {
    const errors = [];

    // Validate LLM provider configuration
    const llmStatus = getStatus();
    if (!llmStatus.configured) {
        errors.push(`LLM Provider (${getProviderName()}) API key is missing`);
    }
    if (!llmStatus.isValid) {
        llmStatus.errors.forEach(err => errors.push(err));
    }

    if (PLATFORM === 'messenger') {
        if (!process.env.PAGE_ACCESS_TOKEN) {
            errors.push('PAGE_ACCESS_TOKEN is missing (required for Messenger)');
        }
        if (!process.env.VERIFY_TOKEN) {
            errors.push('VERIFY_TOKEN is missing (required for Messenger)');
        }
    }

    if (errors.length > 0) {
        console.error('[MAIN] Configuration errors:');
        errors.forEach(e => console.error(`  - ${e}`));
        console.error('\n[MESSENGER] Please update your .env file');
        return false;
    }

    return true;
}

// Start WhatsApp bot
async function startWhatsApp() {
    console.log('[MAIN] Starting Dyna-Nutrition WhatsApp bot...');
    initWhatsAppBot();
}

// Start Messenger bot
async function startMessenger() {
    console.log('[MAIN] Starting Dyna-Nutrition Facebook Messenger bot...');
    await initMessengerBot();
}

// Main startup
async function main() {
    console.log('===========================================');
    console.log('  Dyna-Nutrition Bot v5.0');
    console.log('===========================================');
    console.log(`[MAIN] Platform: ${PLATFORM.toUpperCase()}`);
    console.log(`[MAIN] Port: ${PORT}`);

    // Show LLM provider status
    const llmStatus = getStatus();
    console.log(`[MAIN] LLM Provider: ${llmStatus.provider}`);
    console.log(`[MAIN] LLM Configured: ${llmStatus.configured ? 'Yes' : 'NO - Missing API key'}`);
    if (llmStatus.warnings.length > 0) {
        console.log(`[MAIN] LLM Warnings: ${llmStatus.warnings.join(', ')}`);
    }

    if (PLATFORM === 'messenger') {
        console.log('[MAIN] Facebook Messenger: Configured');
    } else if (PLATFORM === 'whatsapp') {
        console.log('[MAIN] WhatsApp Web.js: Configured');
    }

    console.log('===========================================\n');

    // Validate environment
    if (!validateEnv()) {
        process.exit(1);
    }

    // Start heartbeat for keep-alive
    if (PLATFORM === 'messenger') {
        startHeartbeat(120000);
    }

    // Start the appropriate platform
    if (PLATFORM === 'messenger') {
        await startMessenger();
    } else if (PLATFORM === 'whatsapp') {
        startWhatsApp();
    } else {
        console.error(`[MAIN] Unknown platform: ${PLATFORM}`);
        console.error('[MAIN] Set PLATFORM=messenger or PLATFORM=whatsapp in .env');
        process.exit(1);
    }
}

// Handle shutdown
process.on('SIGINT', () => {
    console.log('\n[MAIN] Shutting down...');
    process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));

// Start the bot
main().catch(err => {
    console.error('[MAIN] Startup error:', err);
    process.exit(1);
});
