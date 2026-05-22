// bot/whatsappBot.js
// WhatsApp bot with LLM-based routing to priceApi, storeLocator, and general responses

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { generateResponse } = require('../services/deepseek');
const { routeMessage } = require('../services/messageRouter');
const { getProductPrice, formatPriceResponse } = require('../services/priceApi');
const { findStores } = require('../services/storeLocator');
const { splitIntoChunks } = require('../utils/llmMessageSplitter');
const { getHistory, addMessage, hasProductBeenShown, markProductAsShown } = require('../utils/memory');
const { setContact, getPhoneNumber } = require('../utils/contactCache');
const { stripMarkdownFormatting } = require('../utils/stripMarkdown');

// Helper function to decode WhatsApp LID to actual phone number
function decodeLIDtoPhone(lid) {
    if (!lid) return null;
    const cleanLid = lid.replace(/[^0-9]/g, '');
    if (cleanLid.length < 7) return cleanLid;
    const last10 = cleanLid.slice(-10);
    const last9 = cleanLid.slice(-9);
    const last8 = cleanLid.slice(-8);
    const singaporePattern = /^[89]/;
    if (singaporePattern.test(last10)) return last10;
    if (singaporePattern.test(last9)) return last9;
    if (singaporePattern.test(last8)) return last8;
    return last10;
}

// Get fresh handoff module instance
function getHandoff() {
    delete require.cache[require.resolve('../utils/humanHandoff')];
    return require('../utils/humanHandoff');
}

// Split long messages into chunks (WhatsApp limit ~4096 chars)
async function sendLongMessage(msg, text, apiKey = null, delayMs = 800) {
    const chatId = msg.id.remote;

    if (!text || text.length === 0) return;

    // Strip markdown formatting before sending
    const cleanText = stripMarkdownFormatting(text);

    // Use LLM-based splitting for intelligent chunking
    const chunks = await splitIntoChunks(cleanText, apiKey);

    console.log(`[BOT] Splitting message into ${chunks.length} parts`);
    for (let i = 0; i < chunks.length; i++) {
        try {
            await client.sendMessage(chatId, chunks[i]);
        } catch (sendErr) {
            console.error(`[BOT] Failed to send chunk ${i + 1}:`, sendErr.message);
            await msg.reply(chunks[i]);
        }
        if (i < chunks.length - 1) {
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
}

let client = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;
const userCooldowns = new Map();
const COOLDOWN_MS = 2000;

// ==================== Human Handoff Functions ====================

async function sendAsHuman(userId, message) {
    if (!client) {
        console.error('[BOT] Client not initialized');
        return false;
    }
    try {
        await client.sendMessage(userId, message);
        console.log(`[BOT] Human sent to ${userId}: "${message}"`);
        return true;
    } catch (err) {
        console.error('[BOT] Failed to send human message:', err.message);
        return false;
    }
}

function enableHumanMode(userId, agentId = 'default') {
    const { setHumanMode } = getHandoff();
    setHumanMode(userId, agentId);
}

function disableHumanMode(userId) {
    const { setBotMode } = getHandoff();
    setBotMode(userId, 'human_complete');
}

function getBotStatus(userId) {
    const handoff = getHandoff();
    const session = handoff.getSession(userId);
    return {
        mode: session ? session.mode : 'bot',
        agentId: session?.agentId || null,
        sessionActive: !!session
    };
}

// Cleanup expired cooldown entries every 60 seconds
setInterval(() => {
    const now = Date.now();
    const EXPIRY_MS = 300000;
    for (const [userId, lastTime] of userCooldowns.entries()) {
        if (now - lastTime > EXPIRY_MS) {
            userCooldowns.delete(userId);
        }
    }
}, 60000);

/**
 * Handle a price query using priceApi
 */
async function handlePriceQuery(msg, productName, currency, phoneNumber, apiKey) {
    console.log(`[BOT] Processing price query: product=${productName}, currency=${currency}`);

    if (!productName) {
        await msg.reply('Which product would you like to know the price of?');
        return;
    }

    try {
        const priceInfo = await getProductPrice(productName, phoneNumber, apiKey, currency);

        if (priceInfo) {
            const response = formatPriceResponse(productName, priceInfo, currency);
            await sendLongMessage(msg, response, apiKey);
        } else {
            await msg.reply(`I'm sorry, I couldn't find pricing information for ${productName}. Please contact our support team.`);
        }
    } catch (err) {
        console.error(`[BOT] Price query error: ${err.message}`);
        await msg.reply('Sorry, I encountered an error looking up the price. Please try again.');
    }
}

/**
 * Handle a store locator query
 */
async function handleStoreQuery(msg, userMessage, apiKey, routeParams = {}) {
    console.log(`[BOT] Processing store query`);

    try {
        const storeResult = await findStores(userMessage, apiKey, routeParams);

        if (storeResult.needsLocation) {
            await sendLongMessage(msg, storeResult.text, apiKey);
            return;
        }

        if (storeResult.success) {
            if (storeResult.noStoresInArea) {
                await sendLongMessage(msg, storeResult.text, apiKey);
            } else {
                await sendLongMessage(msg, storeResult.text, apiKey);
            }
        } else {
            await sendLongMessage(msg, storeResult.text, apiKey);
        }
    } catch (err) {
        console.error(`[BOT] Store query error: ${err.message}`);
        await msg.reply('Sorry, I encountered an error finding stores. Please try again.');
    }
}

function initWhatsAppBot() {
    if (client) { client.destroy().catch(() => {}); }

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: './session-data' }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        },
        qrMaxRetries: 3
    });

    client.on('qr', qr => {
        console.log('Scan QR:');
        qrcode.generate(qr, { small: true });
        reconnectAttempts = 0;
    });

    client.on('ready', () => {
        console.log('[BOT] Bot ready');
        reconnectAttempts = 0;
    });

    client.on('auth_failure', msg => console.error('[BOT] Auth failed:', msg));

    client.on('disconnected', async (reason) => {
        console.log(`[BOT] Disconnected: ${reason}`);
        if (reconnectAttempts < MAX_RECONNECT) {
            reconnectAttempts++;
            const delay = 5000 * reconnectAttempts;
            console.log(`[BOT] Reconnecting in ${delay / 1000}s...`);
            setTimeout(() => initWhatsAppBot(), delay);
        }
    });

    client.on('message', async (msg) => {
        const msgBody = msg.body.trim();
        const userId = msg.from;

        console.log(`\n[BOT] Incoming from ${userId}: "${msgBody}"`);
        console.log(`     msg.fromMe=${msg.fromMe}, msg.type=${msg.type}`);

        // Cache contact info
        try {
            const contact = await msg.getContact();
            if (contact) {
                const storedPhone = contact.id?.user || contact.number;
                setContact(userId, storedPhone, contact.pushname || null);
            }
        } catch (e) {
            // Silently ignore
        }

        const lowerMsg = msgBody.toLowerCase();

        // ========================================
        // SPECIAL COMMANDS
        // ========================================

        if (lowerMsg === '!bot') {
            console.log(`[BOT] !bot command detected`);
            const handoff = getHandoff();
            handoff.setBotMode(userId, 'user_request');
            await msg.reply('Bot is now active. How can I help you?');
            return;
        }

        if (lowerMsg === '!status') {
            console.log(`[BOT] !status command detected`);
            const handoff = getHandoff();
            const sessions = handoff.getActiveSessions();
            const count = Object.keys(sessions).length;

            if (count === 0) {
                await msg.reply('No active human sessions.');
            } else {
                let reply = `Active human sessions (${count}):\n\n`;
                let index = 1;

                for (const [uid, session] of Object.entries(sessions)) {
                    let phoneDisplay = session.phoneNumber || uid;
                    if (!session.phoneNumber) {
                        phoneDisplay = uid.replace(/@.*$/, '').replace(/[^0-9]/g, '');
                    }
                    const minsAgo = Math.round((Date.now() - session.lastHumanMessage) / 60000);
                    const cmdPhone = phoneDisplay.replace(/[^0-9]/g, '');
                    reply += `[${index}] ${phoneDisplay} | Agent: ${session.agentId} | Last: ${minsAgo} min ago\n   Command: !close ${cmdPhone}\n\n`;
                    index++;
                }
                reply += `Copy the command above to close a session.`;
                await msg.reply(reply);
            }
            return;
        }

        if (lowerMsg === '!closeall') {
            console.log(`[BOT] !closeall command detected`);
            const handoff = getHandoff();
            const allSessions = handoff.getActiveSessions();
            const sessionIds = Object.keys(allSessions);
            const count = sessionIds.length;

            if (count === 0) {
                await msg.reply('No active sessions.');
            } else {
                for (const uid of sessionIds) {
                    handoff.setBotMode(uid, 'agent_closed');
                }
                await msg.reply(`Closed ${count} session(s).`);
            }
            return;
        }

        if (lowerMsg.startsWith('!close ')) {
            console.log(`[BOT] !close command detected`);
            const parts = msgBody.trim().split(/\s+/);
            let searchPhone = parts.length > 1 ? parts.slice(1).join(' ').replace(/^[\s@]+/, '') : null;

            const handoff = getHandoff();
            const allSessions = handoff.getActiveSessions();

            if (!searchPhone) {
                await msg.reply('Usage: !close <phone_number>');
                return;
            }

            const cleanSearch = searchPhone.replace(/[^0-9]/g, '');
            let targetUserId = null;

            for (const [uid, session] of Object.entries(allSessions)) {
                if (session.phoneNumber) {
                    const sessionPhone = session.phoneNumber.replace(/[^0-9]/g, '');
                    if (sessionPhone === cleanSearch || sessionPhone.includes(cleanSearch) || cleanSearch.includes(sessionPhone)) {
                        targetUserId = uid;
                        break;
                    }
                }

                if (!targetUserId) {
                    const cleanUid = uid.replace(/[^0-9]/g, '');
                    if (cleanUid.includes(cleanSearch) || cleanSearch.includes(cleanUid.slice(-8))) {
                        targetUserId = uid;
                        break;
                    }
                }
            }

            if (!targetUserId) {
                await msg.reply(`No session found for: ${searchPhone}`);
                return;
            }

            if (handoff.isHumanMode(targetUserId)) {
                handoff.setBotMode(targetUserId, 'agent_closed');
                await msg.reply(`Session closed for ${searchPhone}.`);
            } else {
                await msg.reply('No active human session for that user.');
            }
            return;
        }

        // ========================================
        // REGULAR MESSAGES
        // ========================================

        if (msg.fromMe) {
            console.log(`[BOT] Filtered: own message`);
            return;
        }

        if (msg.type === 'notification') {
            console.log(`[BOT] Filtered: notification`);
            return;
        }

        if (msgBody.startsWith('!')) {
            console.log(`[BOT] Filtered: other command`);
            return;
        }

        const handoff = getHandoff();
        console.log(`[BOT] Mode check: ${handoff.isHumanMode(userId) ? 'HUMAN' : 'BOT'}`);

        if (handoff.isHumanMode(userId)) {
            console.log(`[BOT] User ${userId} in HUMAN mode - ignoring`);
            return;
        }

        if (handoff.shouldEscalate(msgBody)) {
            console.log(`[BOT] Escalation triggered: "${msgBody}"`);

            if (!handoff.isWithinWorkingHours()) {
                const hoursMessage = handoff.getWorkingHoursMessage();
                await msg.reply(hoursMessage);
                return;
            }

            let phoneNumber = null;

            try {
                const contact = await msg.getContact();
                if (contact) {
                    const storedPhone = contact.id?.user || contact.number;
                    setContact(userId, storedPhone, contact.pushname || null);

                    if (contact.id?.user) {
                        const userPart = contact.id.user.replace(/[^0-9]/g, '');
                        if (userPart.length >= 7 && userPart.length <= 15) {
                            phoneNumber = userPart;
                        }
                    }

                    if (!phoneNumber && contact.number) {
                        const cleaned = contact.number.replace(/[^0-9]/g, '');
                        if (cleaned.length >= 7 && cleaned.length <= 15 && /^[89]/.test(cleaned)) {
                            phoneNumber = cleaned;
                        }
                    }
                }
            } catch (e) {
                console.log(`[BOT] Could not get contact: ${e.message}`);
            }

            if (!phoneNumber) {
                const cachedPhone = getPhoneNumber(userId);
                if (cachedPhone) phoneNumber = cachedPhone;
            }

            if (!phoneNumber) {
                phoneNumber = decodeLIDtoPhone(userId);
            }

            if (!phoneNumber) {
                phoneNumber = userId.replace(/@.*$/, '').replace(/[^0-9]/g, '');
            }

            handoff.setHumanMode(userId, 'escalation', phoneNumber);
            await msg.reply('Connecting to human agent...');
            return;
        }

        const now = Date.now();
        const lastMsgTime = userCooldowns.get(userId) || 0;
        if (now - lastMsgTime < COOLDOWN_MS) return;
        userCooldowns.set(userId, now);

        try {
            if (msgBody.length < 2) return;

            // Show typing indicator
            try {
                const chat = await msg.getChat();
                await chat.sendStateTyping();
            } catch (e) {
                console.warn('[BOT] Could not send typing indicator:', e.message);
            }

            // Get phone number for currency detection
            const phoneNumber = getPhoneNumber(userId) || decodeLIDtoPhone(userId);

            // Get conversation history for context
            const history = getHistory(userId);

            // ========================================
            // NEW: LLM-based Routing (with history for context)
            // ========================================
            console.log(`[BOT] Routing message with LLM (history: ${history.length} messages)...`);
            const route = await routeMessage(msgBody, userId, phoneNumber, process.env.DEEPSEEK_API_KEY, history);
            console.log(`[BOT] Routed to: ${route.handler}`, route.params);

            // Clear typing indicator
            try {
                const chat = await msg.getChat();
                await chat.clearState();
            } catch (e) {
                // ignore
            }

            // Handle based on route
            if (route.handler === 'priceApi') {
                await handlePriceQuery(
                    msg,
                    route.params.productName,
                    route.params.currency,
                    route.params.phoneNumber || phoneNumber,
                    process.env.DEEPSEEK_API_KEY
                );
                addMessage(userId, "user", msgBody);
                addMessage(userId, "assistant", "[Price Query]");
                return;
            }

            if (route.handler === 'storeLocator') {
                await handleStoreQuery(msg, msgBody, process.env.DEEPSEEK_API_KEY, route.params);
                addMessage(userId, "user", msgBody);
                addMessage(userId, "assistant", "[Store Query]");
                return;
            }

            // Default: General LLM response
            console.log(`[BOT] Routing to deepseek (general response)`);

            // history already declared above (line 428)
            const response = await generateResponse(
                msgBody,
                '',
                process.env.DEEPSEEK_API_KEY,
                history
            );

            const finalReply = response.text || 'I\'m having trouble responding. Please try again or contact support.';
            const imageUrl = response.imageUrl;
            const productName = response.productName;

            await sendLongMessage(msg, finalReply, process.env.DEEPSEEK_API_KEY);

            // Send product image if applicable
            const imageKeywords = ['image', 'photo', 'picture', 'show', 'send image', 'send photo'];
            const isImageRequest = imageKeywords.some(k => msgBody.toLowerCase().includes(k));
            const shouldSendImage = imageUrl && (isImageRequest || !hasProductBeenShown(userId, productName));

            if (shouldSendImage) {
                console.log(`[BOT] Sending product image for "${productName}"`);
                try {
                    const media = await MessageMedia.fromUrl(imageUrl, { unsafeMimeType: true });
                    await msg.reply(media, msg.chatId, { caption: `Here's the image of ${productName}` });
                    markProductAsShown(userId, productName);
                } catch (err) {
                    console.error('[BOT] Failed to send product image:', err.message);
                }
            }

            addMessage(userId, "user", msgBody);
            addMessage(userId, "assistant", finalReply);

        } catch (err) {
            console.error('[BOT] Message handling error:', err);
            try {
                const chat = await msg.getChat();
                await chat.clearState();
            } catch (e) {
                // ignore
            }
            await msg.reply('Something went wrong. Please try again later.');
        }
    });

    client.initialize().catch(err => console.error('[BOT] Init error:', err));
}

module.exports = {
    initWhatsAppBot,
    sendAsHuman,
    enableHumanMode,
    disableHumanMode,
    getBotStatus
};