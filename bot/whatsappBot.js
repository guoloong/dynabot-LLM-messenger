// bot/whatsappBot.js
// WhatsApp bot with LLM-based routing to priceApi, storeLocator, and general responses

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const {
    generateResponse
} = require('../services/deepseek');
const { analyzeImage } = require('../services/imageAnalyzer');
const { routeMessage } = require('../services/messageRouter');
const { getPriceResponse } = require('../services/priceApi');
const { getStoreResponse } = require('../services/storeLocator');
const { splitIntoChunks } = require('../utils/llmMessageSplitter');
const { getHistory, addMessage, hasProductBeenShown, markProductAsShown } = require('../utils/memory');
const { setContact, getPhoneNumber } = require('../utils/contactCache');
const { stripMarkdownFormatting } = require('../utils/stripMarkdown');
const { PLATFORM_WHATSAPP } = require('../utils/humanHandoff');
const { getQuickActionsText, isQuickActionResponse, formatProductDisplayName } = require('./quickReplyButtons');
const { getContext, updateMentionedProduct } = require('../services/contextManager');
const { translateWithHistory } = require('../utils/translateWithHistory');
const { MessageQueue, PLATFORM_WHATSAPP: QUEUE_PLATFORM_WHATSAPP } = require('../utils/messageQueue');

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

// Message queue for handling rapid messages
const messageQueue = new MessageQueue({
    combineWindowMs: 2000,
    maxQueueSize: 10,
    minMessageLength: 1
});

// Legacy cooldown tracking (kept for reference during transition)
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

// Initialize message queue with bot-specific implementations
messageQueue.sendTypingIndicator = async (userId) => {
    try {
        const chat = await client.getChatById(userId);
        await chat.sendStateTyping();
    } catch (e) {
        console.warn('[WA-QUEUE] Typing indicator failed:', e.message);
    }
};

messageQueue.sendMessage = async (userId, text) => {
    try {
        await client.sendMessage(userId, text);
    } catch (e) {
        console.error('[WA-QUEUE] Send message failed:', e.message);
    }
};

/**
 * Handle a price query using priceApi with translation
 */
async function handlePriceQuery(msg, productName, currency, phoneNumber, apiKey, currentMessage) {
    console.log(`[BOT] Processing price query: product=${productName}, currency=${currency}`);

    if (!productName) {
        await msg.reply('Which product would you like to know the price of?');
        return;
    }

    try {
        const response = await getPriceResponse(productName, phoneNumber, apiKey, currentMessage, currency);

        if (response) {
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
 * Handle a store locator query with translation
 */
async function handleStoreQuery(msg, userMessage, apiKey, routeParams, currentMessage) {
    console.log(`[BOT] Processing store query`);

    try {
        const storeResult = await getStoreResponse(userMessage, apiKey, routeParams, currentMessage);

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

/**
 * Process a queued message - called by messageQueue when ready to handle queued messages
 * This extracts the core message processing logic so it can be reused for queued messages
 */
async function processQueuedMessage(userId, combinedMessage, messageCount, platform, imageAnalysisResult) {
    console.log(`[WA-QUEUE] Processing queued message for ${userId}: "${combinedMessage.substring(0, 50)}..."`);

    try {
        // Get phone number for currency detection
        const phoneNumber = getPhoneNumber(userId) || decodeLIDtoPhone(userId);

        // Get conversation history for context
        const history = getHistory(userId);

        // Show typing indicator
        try {
            const chat = await client.getChatById(userId);
            await chat.sendStateTyping();
        } catch (e) {
            console.warn('[WA-QUEUE] Typing indicator failed:', e.message);
        }

        // Route message with LLM
        console.log(`[WA-QUEUE] Routing message with LLM (history: ${history.length} messages)...`);
        const route = await routeMessage(combinedMessage, userId, phoneNumber, process.env.DEEPSEEK_API_KEY, history);
        console.log(`[WA-QUEUE] Routed to: ${route.handler}`, route.params);

        // Clear typing indicator
        try {
            const chat = await client.getChatById(userId);
            await chat.clearState();
        } catch (e) {
            // ignore
        }

        // Handle based on route
        if (route.handler === 'priceApi') {
            // Create a mock msg object for handlePriceQuery
            const mockMsg = {
                id: { remote: userId },
                reply: async (text) => {
                    try {
                        await client.sendMessage(userId, text);
                    } catch (e) {
                        console.error('[WA-QUEUE] Reply failed:', e.message);
                    }
                }
            };
            await handlePriceQuery(
                mockMsg,
                route.params.productName,
                route.params.currency,
                route.params.phoneNumber || phoneNumber,
                process.env.DEEPSEEK_API_KEY,
                combinedMessage
            );
            addMessage(userId, "user", combinedMessage);
            addMessage(userId, "assistant", "[Price Query]");
            return;
        }

        if (route.handler === 'storeLocator') {
            // Create a mock msg object for handleStoreQuery
            const mockMsg = {
                id: { remote: userId },
                reply: async (text) => {
                    try {
                        await client.sendMessage(userId, text);
                    } catch (e) {
                        console.error('[WA-QUEUE] Reply failed:', e.message);
                    }
                }
            };
            await handleStoreQuery(mockMsg, combinedMessage, process.env.DEEPSEEK_API_KEY, route.params, combinedMessage);
            addMessage(userId, "user", combinedMessage);
            addMessage(userId, "assistant", "[Store Query]");
            return;
        }

        // Default: General LLM response
        console.log(`[WA-QUEUE] Routing to deepseek (general response)`);

        const detectedProductForMedia = route.params.intentProduct || null;

        const response = await generateResponse(
            combinedMessage,
            '',
            process.env.DEEPSEEK_API_KEY,
            history,
            route.params,
            detectedProductForMedia,
            imageAnalysisResult
        );

        const finalReply = response.text || 'I\'m having trouble responding. Please try again or contact support.';
        const responseImageUrl = response.imageUrl;
        const productName = response.productName;

        // Update context
        if (productName) {
            updateMentionedProduct(userId, productName);
            console.log(`[WA-QUEUE] Context updated to: ${productName}`);
        }

        // Send response using sendLongMessage with mock msg
        const mockMsg = {
            id: { remote: userId },
            reply: async (text) => {
                try {
                    await client.sendMessage(userId, text);
                } catch (e) {
                    console.error('[WA-QUEUE] Reply failed:', e.message);
                }
            },
            chatId: userId
        };
        await sendLongMessage(mockMsg, finalReply, process.env.DEEPSEEK_API_KEY);

        // Send product image if applicable (skip for B2B retail partnership)
        const isRetailPartnership = route.params.isRetailPartnership || false;
        const imageKeywords = ['image', 'photo', 'picture', 'show', 'send image', 'send photo'];
        const isImageRequest = imageKeywords.some(k => combinedMessage.toLowerCase().includes(k));
        const shouldSendImage = responseImageUrl && !isRetailPartnership && (isImageRequest || !hasProductBeenShown(userId, productName));

        if (shouldSendImage && productName) {
            console.log(`[WA-QUEUE] Sending product image for "${productName}"`);
            try {
                const media = await MessageMedia.fromUrl(responseImageUrl, { unsafeMimeType: true });
                await client.sendMessage(userId, media, { caption: `Here's the image of ${productName}` });
                markProductAsShown(userId, productName);
            } catch (err) {
                console.error('[WA-QUEUE] Failed to send product image:', err.message);
            }
        }

        // Send quick action menu if product was mentioned (skip for B2B retail partnership)
        if (productName && !isRetailPartnership) {
            try {
                const menuResult = await getQuickActionsText(combinedMessage, process.env.DEEPSEEK_API_KEY, productName);
                const mockMsgForMenu = {
                    id: { remote: userId },
                    reply: async (text) => {
                        try {
                            await client.sendMessage(userId, text);
                        } catch (e) {
                            console.error('[WA-QUEUE] Menu reply failed:', e.message);
                        }
                    }
                };
                await sendLongMessage(mockMsgForMenu, menuResult.text, process.env.DEEPSEEK_API_KEY, 500);
            } catch (err) {
                console.error('[WA-QUEUE] Failed to send quick action menu:', err.message);
            }
        }

        addMessage(userId, "user", combinedMessage);
        addMessage(userId, "assistant", finalReply);

    } catch (err) {
        console.error('[WA-QUEUE] Message processing error:', err);
        try {
            await client.sendMessage(userId, 'Something went wrong. Please try again later.');
        } catch (e) {
            console.error('[WA-QUEUE] Error reply failed:', e.message);
        }
    }
}

// Assign the processMessage function to the messageQueue
messageQueue.processMessage = processQueuedMessage;

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

        // ========================================
        // IMAGE MESSAGE HANDLING
        // ========================================
        let imageAnalysisResult = null;
        let effectiveMessageText = msgBody;

        if (msg.type === 'image') {
            console.log('[BOT] Image message detected, downloading media...');
            try {
                const media = await msg.downloadMedia();
                if (media && media.data) {
                    console.log(`[BOT] Media downloaded: mimetype=${media.mimetype}, size=${media.data.length}`);

                    // Analyze image using imageAnalyzer
                    try {
                        console.log(`[BOT] Analyzing image with MiniMax Vision API...`);
                        imageAnalysisResult = await analyzeImage(media);
                        console.log(`[BOT] Image analysis complete`);
                        console.log(`[BOT] Description: ${imageAnalysisResult.description.substring(0, 100)}...`);

                        // Use image context - prepend to message if there's text, or use as message if no text
                        const imageContext = `\n[User sent a photo]\nImage description: ${imageAnalysisResult.description}\n`;
                        if (msgBody && msgBody.trim()) {
                            // User sent image with a message - prepend image context
                            effectiveMessageText = imageContext + msgBody;
                        } else {
                            // User sent only an image - use image context as the message
                            effectiveMessageText = imageContext;
                        }
                    } catch (err) {
                        console.error('[BOT] Image analysis failed:', err.message);
                        // Continue without image analysis
                        imageAnalysisResult = null;
                    }
                }
            } catch (err) {
                console.error('[BOT] Failed to download image:', err.message);
            }
        }

        // If no message body and no image analysis, skip
        if (!effectiveMessageText && !imageAnalysisResult) {
            console.log('[BOT] No text or valid image in message, skipping');
            return;
        }

        // Use placeholder if no text but has image
        if (!effectiveMessageText && imageAnalysisResult) {
            effectiveMessageText = `[User sent an image: ${imageAnalysisResult.description}]`;
        }

        const lowerMsg = effectiveMessageText.toLowerCase();

        // ========================================
        // QUICK ACTION RESPONSE HANDLING (1, 2, 3)
        // NEW APPROACH: Translate button text, then pass to normal flow
        // ========================================

        const quickAction = isQuickActionResponse(msgBody);
        if (quickAction) {
            // Get conversation history for language detection (not just "1")
            const history = getHistory(userId);
            const lastUserMessage = history.length > 0
                ? history[history.length - 1].content
                : msgBody;

            // Button templates (English)
            const BUTTON_TEMPLATES = {
                price: 'May I know the price?',
                buyOnline: 'I want to buy online.',
                retailStore: 'I want to buy from a retail store.'
            };

            // Translate button text to user's language
            const englishTemplate = BUTTON_TEMPLATES[quickAction];
            let translatedMsg = englishTemplate;

            if (lastUserMessage && lastUserMessage.length > 2) {
                try {
                    translatedMsg = await translateWithHistory(
                        englishTemplate,
                        lastUserMessage, // Use conversation context, not "1"
                        [],
                        process.env.DEEPSEEK_API_KEY
                    );
                    console.log(`[BOT] Quick action translated: "${englishTemplate}" → "${translatedMsg}"`);
                } catch (err) {
                    console.error('[BOT] Translation failed, using English:', err.message);
                }
            }

            // Pass translated message to normal flow (routeMessage)
            // This ensures the response is in the same language as the translated message
            console.log(`[BOT] Passing translated message to routeMessage: "${translatedMsg}"`);

            // Use the translated message as input to routeMessage
            const phoneNumber = getPhoneNumber(userId) || decodeLIDtoPhone(userId);

            // Route the translated message
            const route = await routeMessage(translatedMsg, userId, phoneNumber, process.env.DEEPSEEK_API_KEY, history);
            console.log(`[BOT] Routed to: ${route.handler}`, route.params);

            // Handle based on route (same as normal flow)
            if (route.handler === 'priceApi') {
                await handlePriceQuery(
                    msg,
                    route.params.productName,
                    route.params.currency,
                    route.params.phoneNumber || phoneNumber,
                    process.env.DEEPSEEK_API_KEY,
                    translatedMsg // Use translated message for language detection
                );
                addMessage(userId, "user", translatedMsg);
                addMessage(userId, "assistant", "[Price Query]");
                return;
            }

            if (route.handler === 'storeLocator') {
                await handleStoreQuery(msg, translatedMsg, process.env.DEEPSEEK_API_KEY, route.params, translatedMsg);
                addMessage(userId, "user", translatedMsg);
                addMessage(userId, "assistant", "[Store Query]");
                return;
            }

            // Default: General LLM response
            const response = await generateResponse(
                translatedMsg,
                '',
                process.env.DEEPSEEK_API_KEY,
                history,
                route.params,
                route.params.productName
            );

            await sendLongMessage(msg, response.text, process.env.DEEPSEEK_API_KEY);
            addMessage(userId, "user", translatedMsg);
            addMessage(userId, "assistant", response.text);
            return;
        }

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
        // !escalate - Admin manually trigger human mode (bypasses working hours)
        // Uses SAME phone extraction logic as user-initiated escalation
        // ========================================
        if (lowerMsg.startsWith('!escalate ')) {
            console.log(`[BOT] !escalate command detected`);
            const parts = msgBody.trim().split(/\s+/);
            const searchPhone = parts.length > 1 ? parts.slice(1).join(' ').replace(/^[\s@]+/, '') : null;

            if (!searchPhone) {
                await msg.reply('Usage: !escalate <phone_number>');
                return;
            }

            console.log(`[BOT] !escalate searching for: ${searchPhone}`);
            const handoff = getHandoff();
            const allSessions = handoff.getActiveSessions();
            const cleanSearch = searchPhone.replace(/[^0-9]/g, '');
            console.log(`[BOT] !escalate cleanSearch: ${cleanSearch}, active sessions: ${Object.keys(allSessions).length}`);

            // Find matching session (same logic as !close)
            let targetUserId = null;
            let targetPhone = cleanSearch;

            for (const [uid, session] of Object.entries(allSessions)) {
                console.log(`[BOT] !escalate checking session: ${uid}, phone: ${session.phoneNumber}, platform: ${session.platform}`);
                // Only WhatsApp sessions
                if (session.platform !== PLATFORM_WHATSAPP) continue;

                // First try: match by stored phoneNumber
                if (session.phoneNumber) {
                    const sessionPhone = session.phoneNumber.replace(/[^0-9]/g, '');
                    console.log(`[BOT] !escalate comparing storedPhone: ${sessionPhone} vs cleanSearch: ${cleanSearch}`);
                    if (sessionPhone === cleanSearch || sessionPhone.includes(cleanSearch) || cleanSearch.includes(sessionPhone)) {
                        targetUserId = uid;
                        targetPhone = session.phoneNumber;
                        console.log(`[BOT] !escalate MATCHED by phoneNumber!`);
                        break;
                    }
                }

                // Second try: match by userId itself (phone@c.us format)
                if (!targetUserId) {
                    const cleanUid = uid.replace(/[^0-9]/g, '');
                    console.log(`[BOT] !escalate comparing userId: ${cleanUid} vs cleanSearch: ${cleanSearch}`);
                    if (cleanUid.includes(cleanSearch) || cleanSearch.includes(cleanUid.slice(-8))) {
                        targetUserId = uid;
                        targetPhone = cleanSearch;
                        console.log(`[BOT] !escalate MATCHED by userId!`);
                        break;
                    }
                }
            }

            console.log(`[BOT] !escalate targetUserId: ${targetUserId}`);

            // Check if user already in human mode (using same userId)
            if (targetUserId && handoff.isHumanMode(targetUserId)) {
                await msg.reply(`User ${searchPhone} is already in human mode.`);
                return;
            }

            // User not found in active sessions - check if user exists in contact cache
            if (!targetUserId) {
                // Load contact cache to find user
                let cachedContacts = {};
                try {
                    const cachePath = path.join(__dirname, '..', 'contact_cache.json');
                    if (fs.existsSync(cachePath)) {
                        cachedContacts = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
                    }
                } catch (e) {
                    console.log(`[BOT] !escalate - failed to load contact cache: ${e.message}`);
                }

                console.log(`[BOT] !escalate - contactCache entries: ${Object.keys(cachedContacts).length}`);

                // Search contact cache for matching phone
                let actualUserId = null;
                let actualPhone = cleanSearch;

                for (const [cachedUserId, contact] of Object.entries(cachedContacts)) {
                    if (contact && contact.phoneNumber) {
                        const cachedPhone = contact.phoneNumber.replace(/[^0-9]/g, '');
                        console.log(`[BOT] !escalate - checking cache: userId=${cachedUserId}, phone=${cachedPhone} vs search=${cleanSearch}`);
                        if (cachedPhone === cleanSearch || cleanSearch.includes(cachedPhone) || cachedPhone.includes(cleanSearch)) {
                            actualUserId = cachedUserId;
                            actualPhone = cachedPhone;
                            console.log(`[BOT] !escalate - FOUND in contact cache! userId=${actualUserId}, phone=${actualPhone}`);
                            break;
                        }
                    }
                }

                // If user not in sessions AND not in contact cache, cannot escalate
                if (!actualUserId) {
                    await msg.reply(`User ${searchPhone} not found. They must message the bot first before you can escalate.`);
                    return;
                }

                // User found in contact cache - escalate
                targetUserId = actualUserId;
                console.log(`[BOT] !escalate - setting human mode for userId=${targetUserId}, phone=${actualPhone}`);

                // Set human mode with admin escalation
                handoff.setHumanMode(targetUserId, 'admin_escalation', actualPhone, PLATFORM_WHATSAPP, null);

                // Notify the user being escalated
                try {
                    await client.sendMessage(targetUserId, 'Connecting you to a human agent. Please wait...');
                } catch (e) {
                    console.log(`[BOT] Could not notify user: ${e.message}`);
                }

                await msg.reply(`User ${searchPhone} has been escalated to human mode.`);
                return;
            }

            // User found in active sessions and not in human mode - escalate
            if (targetUserId) {
                // Use the same userId as stored in session
                handoff.setHumanMode(targetUserId, 'admin_escalation', targetPhone, PLATFORM_WHATSAPP, null);

                // Notify the user being escalated
                try {
                    await client.sendMessage(targetUserId, 'Connecting you to a human agent. Please wait...');
                } catch (e) {
                    console.log(`[BOT] Could not notify user: ${e.message}`);
                }

                await msg.reply(`User ${searchPhone} has been escalated to human mode.`);
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

            handoff.setHumanMode(userId, 'escalation', phoneNumber, PLATFORM_WHATSAPP, null);
            await msg.reply('Connecting to human agent...');
            return;
        }

        // ========================================
        // QUEUE MESSAGES - Handle rapid message sending
        // Replaces cooldown logic - queues messages for sequential processing
        // ========================================

        // Skip very short/empty messages
        if (msgBody.length < 2 && effectiveMessageText.length < 2) {
            console.log(`[BOT] Message too short, skipping`);
            return;
        }

        // Queue the message - this handles rapid messages by combining them
        // and processing sequentially
        await messageQueue.enqueue(userId, effectiveMessageText, QUEUE_PLATFORM_WHATSAPP, imageAnalysisResult);
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