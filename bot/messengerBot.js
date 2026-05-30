// bot/messengerBot.js
// Facebook Messenger bot with DeepSeek AI integration and human handoff support

const express = require('express');
const axios = require('axios');
const { generateResponse } = require('../services/deepseek');
const { analyzeImage } = require('../services/imageAnalyzer');
const { routeMessage } = require('../services/messageRouter');
const { getPriceResponse } = require('../services/priceApi');
const { getStoreResponse } = require('../services/storeLocator');
const { updateMentionedProduct } = require('../services/contextManager');
const { getHistory, addMessage } = require('../utils/memory');
const { splitIntoChunks } = require('../utils/llmMessageSplitter');
const { stripMarkdownFormatting } = require('../utils/stripMarkdown');
const {
    isHumanMode, setHumanMode, setBotMode,
    getActiveSessions, getSessionDisplayName,
    closeSessionByName, closeSessionByPhone,
    shouldEscalate, isWithinWorkingHours, getWorkingHoursMessage,
    PLATFORM_MESSENGER
} = require('../utils/humanHandoff');
const { setFacebookUser, getPsidByFacebookName } = require('../utils/contactCache');
const { getQuickActions, getQuickReplyButtons, getQuickReplyPrompt, isQuickActionResponse, formatProductDisplayName, CLICK_TEMPLATES } = require('./quickReplyButtons');
const { MessageQueue, PLATFORM_MESSENGER: QUEUE_PLATFORM_MESSENGER } = require('../utils/messageQueue');

// Get fresh handoff module instance
function getHandoff() {
    delete require.cache[require.resolve('../utils/humanHandoff')];
    return require('../utils/humanHandoff');
}

// Messenger Bot class
class MessengerBot {
    constructor() {
        this.app = express();
        this.app.use(express.json());
        this.PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
        this.VERIFY_TOKEN = process.env.VERIFY_TOKEN;

        // Message queue for handling rapid messages
        this.messageQueue = new MessageQueue({
            combineWindowMs: 2000,
            maxQueueSize: 10,
            minMessageLength: 1
        });

        // Legacy cooldown tracking (kept for reference during transition)
        this.userCooldowns = new Map();
        this.COOLDOWN_MS = 2000;

        this.setupRoutes();

        // Initialize message queue with bot-specific implementations
        this.initMessageQueue();

        // Cleanup expired cooldown entries every 60 seconds
        setInterval(() => {
            const now = Date.now();
            const EXPIRY_MS = 300000;
            for (const [userId, lastTime] of this.userCooldowns.entries()) {
                if (now - lastTime > EXPIRY_MS) {
                    this.userCooldowns.delete(userId);
                }
            }
        }, 60000);
    }

    // Initialize message queue with Messenger-specific implementations
    initMessageQueue() {
        const self = this;

        this.messageQueue.sendTypingIndicator = async (userId) => {
            try {
                await axios.post(
                    `https://graph.facebook.com/v21.0/me/messages`,
                    {
                        recipient: { id: userId },
                        sender_action: "typing_on"
                    },
                    { params: { access_token: self.PAGE_ACCESS_TOKEN } }
                );
            } catch (e) {
                console.warn('[FB-QUEUE] Typing indicator failed:', e.message);
            }
        };

        this.messageQueue.sendMessage = async (userId, text) => {
            try {
                await axios.post(
                    `https://graph.facebook.com/v21.0/me/messages`,
                    {
                        recipient: { id: userId },
                        message: { text: text }
                    },
                    {
                        params: { access_token: self.PAGE_ACCESS_TOKEN },
                        headers: { 'Content-Type': 'application/json' }
                    }
                );
            } catch (e) {
                console.error('[FB-QUEUE] Send message failed:', e.message);
            }
        };

        this.messageQueue.processMessage = async (userId, combinedMessage, messageCount, platform, imageAnalysisResult) => {
            await self.processQueuedMessage(userId, combinedMessage, messageCount, imageAnalysisResult);
        };
    }

    // Process queued messages - called by messageQueue
    async processQueuedMessage(senderPsid, combinedMessage, messageCount, imageAnalysisResult) {
        console.log(`[FB-QUEUE] Processing queued message for ${senderPsid}: "${combinedMessage.substring(0, 50)}..."`);

        try {
            // Get conversation history for context
            const history = getHistory(senderPsid);

            // Route message to appropriate handler
            console.log(`[FB-QUEUE] Routing message with history: ${history.length} messages`);
            const route = await routeMessage(combinedMessage, senderPsid, null, process.env.DEEPSEEK_API_KEY, history);
            console.log(`[FB-QUEUE] Routed to: ${route.handler}`, route.params);

            // Handle based on route
            if (route.handler === 'priceApi') {
                await this.handlePriceQuery(senderPsid, route.params.productName, route.params.currency, combinedMessage);
                return;
            }

            if (route.handler === 'storeLocator') {
                await this.handleStoreQuery(senderPsid, combinedMessage, route.params, combinedMessage);
                return;
            }

            // Default: Generate DeepSeek response
            console.log(`[FB-QUEUE] Routing to DeepSeek (general response)`);

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

            const finalReply = response.text || "I'm having trouble responding. Please try again.";
            const responseImageUrl = response.imageUrl;
            const productName = response.productName;

            // Update context
            if (productName) {
                updateMentionedProduct(senderPsid, productName);
                console.log(`[FB-QUEUE] Context updated to: ${productName}`);
            }

            // Send response
            await this.sendLongMessage(senderPsid, finalReply);

            // Send product image if applicable
            if (responseImageUrl && productName) {
                try {
                    await this.sendImageUrl(senderPsid, responseImageUrl, productName);
                } catch (err) {
                    console.error('[FB-QUEUE] Failed to send product image:', err.message);
                }
            }

            // Send quick action buttons if product was mentioned
            if (productName) {
                try {
                    await this.sendQuickReplyButtons(senderPsid, combinedMessage, productName);
                } catch (err) {
                    console.error('[FB-QUEUE] Failed to send quick reply buttons:', err.message);
                }
            }

            // Save to history
            addMessage(senderPsid, 'user', combinedMessage);
            addMessage(senderPsid, 'assistant', finalReply);

        } catch (err) {
            console.error('[FB-QUEUE] Error handling message:', err);
            await this.sendMessage(senderPsid, "Something went wrong. Please try again later.");
        }
    }

    setupRoutes() {
        // GET webhook - Facebook verification
        this.app.get('/webhook', (req, res) => {
            const mode = req.query['hub.mode'];
            const token = req.query['hub.verify_token'];
            const challenge = req.query['hub.challenge'];

            console.log('[MESSENGER] Webhook verification request received');
            console.log(`[MESSENGER] mode=${mode}, token=${token ? 'provided' : 'missing'}`);

            if (mode === 'subscribe' && token === this.VERIFY_TOKEN) {
                console.log('[MESSENGER] WEBHOOK_VERIFIED');
                res.status(200).send(challenge);
            } else {
                console.log('[MESSENGER] Verification failed - token mismatch');
                res.sendStatus(403);
            }
        });

        // POST webhook - Receive messages
        this.app.post('/webhook', async (req, res) => {
            const body = req.body;

            // Must be a page subscription
            if (body.object !== 'page') {
                console.log('[MESSENGER] Not a page subscription, ignoring');
                res.sendStatus(404);
                return;
            }

            // Process each entry
            body.entry.forEach(entry => {
                const webhookEvent = entry.messaging[0];
                const senderPsid = webhookEvent.sender.id;

                console.log(`[MESSENGER] Event from ${senderPsid}`);

                // Check if this is a message or postback
                if (webhookEvent.message) {
                    this.handleMessage(senderPsid, webhookEvent.message);
                } else if (webhookEvent.postback) {
                    this.handlePostback(senderPsid, webhookEvent.postback);
                }
            });

            // Return 200 OK immediately
            res.status(200).send('EVENT_RECEIVED');
        });

        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.status(200).json({ status: 'ok', platform: 'messenger' });
        });
    }

    // Fetch Facebook user profile (full display name)
    async fetchFacebookUserName(psid) {
        try {
            const response = await axios.get(
                `https://graph.facebook.com/v21.0/${psid}`,
                {
                    params: {
                        fields: 'name',
                        access_token: this.PAGE_ACCESS_TOKEN
                    }
                }
            );
            return response.data.name || null;
        } catch (err) {
            console.error('[MESSENGER] Failed to fetch user name:', err.message);
            return null;
        }
    }

    // Handle incoming text message
    async handleMessage(senderPsid, receivedMessage) {
        // Skip echoes
        if (receivedMessage.is_echo) {
            console.log('[MESSENGER] Skipping echo message');
            return;
        }

        // Get message text
        const messageText = receivedMessage.text ? receivedMessage.text.trim() : null;

        // Check for image attachments
        const attachments = receivedMessage.attachments;
        let imageUrl = null;
        let imageAnalysisResult = null;

        if (attachments && attachments.length > 0) {
            const imageAttachment = attachments.find(a => a.type === 'image');
            if (imageAttachment) {
                imageUrl = imageAttachment.payload?.url || imageAttachment.url;
                console.log(`[MESSENGER] Image attachment detected: ${imageUrl}`);

                // Analyze image using imageAnalyzer
                if (imageUrl) {
                    try {
                        console.log(`[MESSENGER] Analyzing image with MiniMax Vision API...`);
                        imageAnalysisResult = await analyzeImage(imageUrl);
                        console.log(`[MESSENGER] Image analysis complete`);
                        console.log(`[MESSENGER] Description: ${imageAnalysisResult.description.substring(0, 100)}...`);
                    } catch (err) {
                        console.error('[MESSENGER] Image analysis failed:', err.message);
                        // Continue without image analysis - will be treated as text-only message
                        imageAnalysisResult = null;
                    }
                }
            }
        }

        // If no text AND no valid image, skip
        if (!messageText && !imageAnalysisResult) {
            console.log('[MESSENGER] No text or valid image in message, skipping');
            return;
        }

        // Build effective message with image context
        let effectiveMessageText = messageText;
        if (imageAnalysisResult) {
            const imageContext = `\n[User sent a photo]\nImage description: ${imageAnalysisResult.description}\n`;
            if (messageText && messageText.trim()) {
                // User sent image with a message - prepend image context
                effectiveMessageText = imageContext + messageText;
            } else {
                // User sent only an image - use image context as the message
                effectiveMessageText = imageContext;
            }
        }

        if (!effectiveMessageText) {
            console.log('[MESSENGER] No text content to process');
            return;
        }

        console.log(`[MESSENGER] Message from ${senderPsid}: "${effectiveMessageText}"`);

        // ========================================
        // ADMIN COMMANDS - Process IMMEDIATELY (not queued)
        // ========================================
        const lowerMsg = effectiveMessageText.toLowerCase();

        // !status - List active sessions (all platforms, like WhatsApp)
        if (lowerMsg === '!status') {
            console.log('[MESSENGER] !status command detected');
            const handoff = getHandoff();
            const sessions = handoff.getActiveSessions();
            const sessionEntries = Object.entries(sessions);

            if (sessionEntries.length === 0) {
                await this.sendMessage(senderPsid, 'No active human sessions.');
            } else {
                let reply = `Active human sessions (${sessionEntries.length}):\n\n`;
                let index = 1;

                for (const [uid, session] of sessionEntries) {
                    const minsAgo = Math.round((Date.now() - session.lastHumanMessage) / 60000);
                    let identifier;
                    let command;

                    if (session.platform === PLATFORM_MESSENGER) {
                        identifier = session.facebookName || 'Unknown';
                        command = `!close ${identifier}`;
                    } else {
                        identifier = session.phoneNumber || uid.replace(/@.*$/, '').replace(/[^0-9]/g, '');
                        command = `!close ${identifier}`;
                    }

                    reply += `[${index}] ${identifier} (${session.platform || 'unknown'}) | Agent: ${session.agentId} | Last: ${minsAgo} min ago\n`;
                    reply += `Command: ${command}\n\n`;
                    index++;
                }
                reply += 'Copy the command above to close a session.';
                await this.sendMessage(senderPsid, reply);
            }
            return;
        }

        // !closeall - Close all sessions (like WhatsApp)
        if (lowerMsg === '!closeall') {
            console.log('[MESSENGER] !closeall command detected');
            const handoff = getHandoff();
            const allSessions = handoff.getActiveSessions();
            const sessionIds = Object.keys(allSessions);
            const count = sessionIds.length;

            if (count === 0) {
                await this.sendMessage(senderPsid, 'No active sessions.');
            } else {
                for (const uid of sessionIds) {
                    handoff.setBotMode(uid, 'agent_closed');
                }
                await this.sendMessage(senderPsid, `Closed ${count} session(s).`);
            }
            return;
        }

        // !close - Close session (works for both WhatsApp and Messenger)
        if (lowerMsg.startsWith('!close')) {
            console.log('[MESSENGER] !close command detected');
            const parts = messageText.trim().split(/\s+/);
            const searchValue = parts.length > 1 ? parts.slice(1).join(' ').trim() : null;

            if (!searchValue) {
                await this.sendMessage(senderPsid, 'Usage: !close <phone_or_name>');
                return;
            }

            const handoff = getHandoff();
            const allSessions = handoff.getActiveSessions();
            let closed = false;
            let closedBy = '';

            // First try Messenger name match
            const messengerClosed = handoff.closeSessionByName(searchValue);
            if (messengerClosed.length > 0) {
                closed = true;
                closedBy = searchValue;
            }

            // Then try WhatsApp phone match
            const phoneClosed = handoff.closeSessionByPhone(searchValue);
            if (phoneClosed.length > 0) {
                closed = true;
                closedBy = searchValue;
            }

            if (closed) {
                await this.sendMessage(senderPsid, `Session closed for ${closedBy}. User has returned to bot mode.`);
            } else {
                await this.sendMessage(senderPsid, `No active session found for: ${searchValue}`);
            }
            return;
        }

        // !escalate - Admin manually trigger human mode (bypasses working hours)
        if (lowerMsg.startsWith('!escalate')) {
            console.log('[MESSENGER] !escalate command detected');
            const parts = messageText.trim().split(/\s+/);
            const searchValue = parts.length > 1 ? parts.slice(1).join(' ').trim() : null;

            // DEBUG: Log PSID and attempt to get Facebook username
            console.log(`[MESSENGER] DEBUG: !escalate from senderPsid=${senderPsid}`);
            try {
                const debugFBName = await this.fetchFacebookUserName(senderPsid);
                console.log(`[MESSENGER] DEBUG: Facebook user name for senderPsid=${senderPsid} is "${debugFBName}"`);
            } catch (e) {
                console.log(`[MESSENGER] DEBUG: Failed to get Facebook name for senderPsid=${senderPsid}: ${e.message}`);
            }

            if (!searchValue) {
                await this.sendMessage(senderPsid, 'Usage: !escalate <facebook_name>');
                return;
            }

            const handoff = getHandoff();
            const allSessions = handoff.getActiveSessions();
            const lowerSearch = searchValue.toLowerCase();

            // Step 1: Find matching Messenger session by facebookName in active sessions
            let targetUserId = null;
            let targetSession = null;
            let targetFacebookName = null;

            for (const [uid, session] of Object.entries(allSessions)) {
                // Only Messenger sessions
                if (session.platform !== PLATFORM_MESSENGER) continue;

                // Match by facebookName (partial match)
                if (session.facebookName && session.facebookName.toLowerCase().includes(lowerSearch)) {
                    targetUserId = uid;
                    targetSession = session;
                    targetFacebookName = session.facebookName;
                    break;
                }
            }

            // Step 2: If not found in active sessions, check contact cache
            if (!targetUserId) {
                console.log(`[MESSENGER] !escalate: Not in active sessions, checking contact cache for "${searchValue}"`);
                const cachedPsid = getPsidByFacebookName(searchValue);
                if (cachedPsid) {
                    console.log(`[MESSENGER] !escalate: Found in cache - PSID=${cachedPsid}`);
                    targetUserId = cachedPsid;
                    targetFacebookName = searchValue; // Use the search value as name
                }
            }

            // Check if user already in human mode
            if (targetUserId && handoff.isHumanMode(targetUserId)) {
                await this.sendMessage(senderPsid, `User "${searchValue}" is already in human mode.`);
                return;
            }

            // User not found in active sessions or cache
            if (!targetUserId) {
                await this.sendMessage(senderPsid, `No active session found for: ${searchValue}. Make sure the user has messaged the bot before escalating.`);
                return;
            }

            // User found and not in human mode - escalate
            if (targetUserId) {
                // Use facebookName from session or from targetFacebookName (from cache lookup)
                const fbName = targetSession ? targetSession.facebookName : targetFacebookName;

                // Set human mode with admin escalation
                handoff.setHumanMode(targetUserId, 'admin_escalation', null, PLATFORM_MESSENGER, fbName);

                // Notify the user being escalated
                await this.sendMessage(targetUserId, 'Connecting you to a human agent. Please wait...');

                await this.sendMessage(senderPsid, `User "${searchValue}" has been escalated to human mode.`);
            }
            return;
        }
        // ========================================

        // ========================================
        // HUMAN HANDOFF INTEGRATION - Process IMMEDIATELY
        // ========================================
        const handoff = getHandoff();

        // Check if user is in human mode - forward to human agent, ignore for bot
        if (handoff.isHumanMode(senderPsid)) {
            console.log(`[MESSENGER] User ${senderPsid} in HUMAN mode - message will be handled by human agent`);
            return;
        }

        // Check if message should trigger escalation
        if (handoff.shouldEscalate(messageText)) {
            console.log(`[MESSENGER] Escalation triggered: "${messageText}"`);

            // DEBUG: Log PSID and Facebook username for escalation debugging
            console.log(`[MESSENGER] DEBUG: Auto-escalation - senderPsid=${senderPsid}`);
            try {
                const debugFBName = await this.fetchFacebookUserName(senderPsid);
                console.log(`[MESSENGER] DEBUG: Facebook user name for senderPsid=${senderPsid} is "${debugFBName}"`);
            } catch (e) {
                console.log(`[MESSENGER] DEBUG: Failed to get Facebook name for senderPsid=${senderPsid}: ${e.message}`);
            }

            // Check if within working hours
            if (!handoff.isWithinWorkingHours()) {
                await this.sendMessage(senderPsid, handoff.getWorkingHoursMessage());
                return;
            }

            // Fetch Facebook user name for the session
            const facebookName = await this.fetchFacebookUserName(senderPsid);
            console.log(`[MESSENGER] User name: ${facebookName || 'Unknown'}`);

            // Set human mode with facebook name
            handoff.setHumanMode(senderPsid, 'escalation', null, PLATFORM_MESSENGER, facebookName);

            // Notify user
            await this.sendMessage(senderPsid, 'Connecting you to a human agent. Please wait...');
            return;
        }
        // ========================================
        // END HUMAN HANDOFF INTEGRATION
        // ========================================

        // ========================================
        // QUEUE REGULAR MESSAGES - Handle rapid message sending
        // Replaces cooldown logic - queues messages for sequential processing
        // ========================================

        // Cache Facebook user name for future !escalate lookups
        try {
            const fbName = await this.fetchFacebookUserName(senderPsid);
            if (fbName) {
                setFacebookUser(senderPsid, fbName);
                console.log(`[MESSENGER] Cached FB user: ${senderPsid} -> ${fbName}`);
            }
        } catch (e) {
            // Silently fail - we don't want to interrupt message handling
        }

        // Queue the message - this handles rapid messages by combining them
        // and processing sequentially
        await this.messageQueue.enqueue(senderPsid, effectiveMessageText, QUEUE_PLATFORM_MESSENGER, imageAnalysisResult);
    }

    // Handle postback (button clicks)
    async handlePostback(senderPsid, receivedPostback) {
        const payload = receivedPostback.payload;
        const title = receivedPostback.title;

        console.log(`[MESSENGER] Postback from ${senderPsid}: "${title}" (${payload})`);

        // Apply cooldown
        const now = Date.now();
        const lastMsgTime = this.userCooldowns.get(senderPsid) || 0;
        if (now - lastMsgTime < this.COOLDOWN_MS) return;
        this.userCooldowns.set(senderPsid, now);

        // Check if user is in human mode
        const handoff = getHandoff();
        if (handoff.isHumanMode(senderPsid)) {
            console.log(`[MESSENGER] User ${senderPsid} in HUMAN mode - ignoring postback`);
            return;
        }

        // Check for admin commands in postback payload
        const postbackText = receivedPostback.payload || '';
        const lowerPayload = postbackText.toLowerCase();

        if (lowerPayload === '!status' || lowerPayload.startsWith('!close') || lowerPayload === '!closeall') {
            const handoff = getHandoff();
            const allSessions = handoff.getActiveSessions();

            if (lowerPayload === '!status') {
                const sessionEntries = Object.entries(allSessions);
                if (sessionEntries.length === 0) {
                    await this.sendMessage(senderPsid, 'No active human sessions.');
                } else {
                    let reply = `Active human sessions (${sessionEntries.length}):\n\n`;
                    let index = 1;
                    for (const [uid, session] of sessionEntries) {
                        const minsAgo = Math.round((Date.now() - session.lastHumanMessage) / 60000);
                        let identifier;
                        if (session.platform === PLATFORM_MESSENGER) {
                            identifier = session.facebookName || 'Unknown';
                        } else {
                            identifier = session.phoneNumber || uid.replace(/@.*$/, '').replace(/[^0-9]/g, '');
                        }
                        reply += `[${index}] ${identifier} (${session.platform || 'unknown'}) | Agent: ${session.agentId} | Last: ${minsAgo} min ago\n`;
                        reply += `Command: !close ${identifier}\n\n`;
                        index++;
                    }
                    await this.sendMessage(senderPsid, reply);
                }
            } else if (lowerPayload === '!closeall') {
                const count = Object.keys(allSessions).length;
                if (count === 0) {
                    await this.sendMessage(senderPsid, 'No active sessions.');
                } else {
                    for (const uid of Object.keys(allSessions)) {
                        handoff.setBotMode(uid, 'agent_closed');
                    }
                    await this.sendMessage(senderPsid, `Closed ${count} session(s).`);
                }
            }
            return;
        }

        try {
            // Handle quick reply button clicks
            const quickAction = isQuickReplyPayload(payload);
            if (quickAction) {
                console.log(`[MESSENGER] Quick reply button clicked: ${quickAction}`);

                // Get conversation history for language detection
                const history = getHistory(senderPsid);
                const lastUserMessage = history.length > 0
                    ? history[history.length - 1].content
                    : '';

                // Use CLICK_TEMPLATES for translation
                const englishTemplate = CLICK_TEMPLATES[quickAction];
                let translatedMsg = englishTemplate;

                if (lastUserMessage && lastUserMessage.length > 2) {
                    try {
                        const { translateWithHistory } = require('../utils/translateWithHistory');
                        translatedMsg = await translateWithHistory(
                            englishTemplate,
                            lastUserMessage, // Use conversation context
                            [],
                            process.env.DEEPSEEK_API_KEY
                        );
                        console.log(`[MESSENGER] Quick action translated: "${englishTemplate}" → "${translatedMsg}"`);
                    } catch (err) {
                        console.error('[MESSENGER] Translation failed, using English:', err.message);
                    }
                }

                // Pass translated message to normal flow (routeMessage) - same as WhatsApp
                console.log(`[MESSENGER] Passing translated message to routeMessage: "${translatedMsg}"`);

                // Route the translated message
                const route = await routeMessage(translatedMsg, senderPsid, null, process.env.DEEPSEEK_API_KEY, history);
                console.log(`[MESSENGER] Routed to: ${route.handler}`, route.params);

                // Handle based on route (same as normal flow)
                if (route.handler === 'priceApi') {
                    await this.handlePriceQuery(senderPsid, route.params.productName, route.params.currency, translatedMsg);
                    addMessage(senderPsid, 'user', translatedMsg);
                    addMessage(senderPsid, 'assistant', '[Price Query]');
                    return;
                }

                if (route.handler === 'storeLocator') {
                    await this.handleStoreQuery(senderPsid, translatedMsg, route.params, translatedMsg);
                    addMessage(senderPsid, 'user', translatedMsg);
                    addMessage(senderPsid, 'assistant', '[Store Query]');
                    return;
                }

                // Default: General LLM response
                const response = await generateResponse(
                    translatedMsg,
                    senderPsid,
                    process.env.DEEPSEEK_API_KEY,
                    history,
                    route.params,
                    route.params.productName
                );

                await this.sendLongMessage(senderPsid, response.text || "I can help you with that!");
                addMessage(senderPsid, 'user', translatedMsg);
                addMessage(senderPsid, 'assistant', response.text);
                return;
            }

            // Handle specific postbacks
            if (payload === 'GET_STARTED') {
                await this.sendMessage(senderPsid,
                    "Hello! I'm DynaBot, your AI assistant for Dynamic Nutrition. How can I help you today?\n\n" +
                    "You can ask me about:\n" +
                    "- Product prices\n" +
                    "- Store locations\n" +
                    "- Product information and benefits\n\n" +
                    "What would you like to know?"
                );
                return;
            }

            // Let DeepSeek handle other postbacks
            const response = await generateResponse(
                `User clicked button: "${title}"`,
                senderPsid,
                process.env.DEEPSEEK_API_KEY,
                getHistory(senderPsid)
            );

            const finalReply = response.text || "I received your selection. How else can I help?";
            await this.sendLongMessage(senderPsid, finalReply);

            addMessage(senderPsid, 'user', `Clicked: ${title}`);
            addMessage(senderPsid, 'assistant', finalReply);

        } catch (err) {
            console.error('[MESSENGER] Error handling postback:', err);
            await this.sendMessage(senderPsid, "Something went wrong. Please try again.");
        }
    }

    // Handle price query with translation
    async handlePriceQuery(senderPsid, productName, currency, currentMessage) {
        console.log(`[MESSENGER] Processing price query: product=${productName}, currency=${currency}`);

        if (!productName) {
            await this.sendMessage(senderPsid, 'Which product would you like to know the price of?');
            return;
        }

        try {
            const response = await getPriceResponse(productName, null, process.env.DEEPSEEK_API_KEY, currentMessage, currency);

            if (response) {
                await this.sendLongMessage(senderPsid, response);
            } else {
                await this.sendMessage(senderPsid,
                    `I'm sorry, I couldn't find pricing information for ${productName}. Please contact our support team.`
                );
            }
        } catch (err) {
            console.error('[MESSENGER] Price query error:', err.message);
            await this.sendMessage(senderPsid, 'Sorry, I encountered an error looking up the price. Please try again.');
        }
    }

    // Handle store locator query with translation
    async handleStoreQuery(senderPsid, userMessage, routeParams, currentMessage) {
        console.log(`[MESSENGER] Processing store query`);

        try {
            const storeResult = await getStoreResponse(userMessage, process.env.DEEPSEEK_API_KEY, routeParams, currentMessage);

            if (storeResult.needsLocation) {
                await this.sendLongMessage(senderPsid, storeResult.text);
            } else if (storeResult.success) {
                await this.sendLongMessage(senderPsid, storeResult.text);
            } else {
                await this.sendLongMessage(senderPsid, storeResult.text);
            }
        } catch (err) {
            console.error('[MESSENGER] Store query error:', err.message);
            await this.sendMessage(senderPsid, 'Sorry, I encountered an error finding stores. Please try again.');
        }
    }

    // Send text message via Facebook Graph API
    async sendMessage(recipientId, text) {
        if (!text || text.length === 0) return;

        try {
            await axios.post(
                `https://graph.facebook.com/v21.0/me/messages`,
                {
                    recipient: { id: recipientId },
                    message: { text: text }
                },
                {
                    params: { access_token: this.PAGE_ACCESS_TOKEN },
                    headers: { 'Content-Type': 'application/json' }
                }
            );
            console.log(`[MESSENGER] Message sent to ${recipientId}`);
        } catch (err) {
            console.error('[MESSENGER] Error sending message:', err.response?.data || err.message);
        }
    }

    // Send long messages by splitting into chunks
    async sendLongMessage(recipientId, text, delayMs = 1000) {
        if (!text || text.length === 0) return;

        // Strip markdown formatting before sending
        const cleanText = stripMarkdownFormatting(text);

        // Use LLM-based splitting for intelligent chunking
        const chunks = await splitIntoChunks(cleanText, process.env.DEEPSEEK_API_KEY);

        console.log(`[MESSENGER] Splitting message into ${chunks.length} parts`);

        for (let i = 0; i < chunks.length; i++) {
            try {
                await this.sendMessage(recipientId, chunks[i]);
            } catch (err) {
                console.error(`[MESSENGER] Failed to send chunk ${i + 1}:`, err.message);
            }
            if (i < chunks.length - 1) {
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
    }

    // Send image URL
    async sendImageUrl(recipientId, imageUrl, productName) {
        try {
            await axios.post(
                `https://graph.facebook.com/v21.0/me/messages`,
                {
                    recipient: { id: recipientId },
                    message: {
                        attachment: {
                            type: 'image',
                            payload: { url: imageUrl }
                        }
                    }
                },
                {
                    params: { access_token: this.PAGE_ACCESS_TOKEN },
                    headers: { 'Content-Type': 'application/json' }
                }
            );
            console.log(`[MESSENGER] Product image sent for "${productName}"`);
        } catch (err) {
            console.error('[MESSENGER] Error sending image:', err.response?.data || err.message);
        }
    }

    // Send quick reply buttons with dynamic language translation
    async sendQuickReplyButtons(recipientId, userMessage, productName = null) {
        try {
            // Get translated prompt and short buttons
            const [prompt, buttons] = await Promise.all([
                getQuickReplyPrompt(userMessage, process.env.DEEPSEEK_API_KEY, productName),
                getQuickReplyButtons(userMessage, process.env.DEEPSEEK_API_KEY)
            ]);

            await axios.post(
                `https://graph.facebook.com/v21.0/me/messages`,
                {
                    recipient: { id: recipientId },
                    message: {
                        text: prompt,
                        quick_replies: buttons
                    }
                },
                {
                    params: { access_token: this.PAGE_ACCESS_TOKEN },
                    headers: { 'Content-Type': 'application/json' }
                }
            );
            console.log('[MESSENGER] Quick reply buttons sent');
        } catch (err) {
            console.error('[MESSENGER] Error sending quick reply buttons:', err.response?.data || err.message);
        }
    }

    // Start the Express server
    start(port = process.env.PORT || 3000) {
        return new Promise((resolve, reject) => {
            const server = this.app.listen(port, '0.0.0.0', () => {
                console.log(`[MESSENGER] Bot server running on port ${port}`);
                console.log(`[MESSENGER] Webhook URL: http://localhost:${port}/webhook`);
                resolve(server);
            });

            server.on('error', (err) => {
                console.error('[MESSENGER] Server error:', err);
                reject(err);
            });
        });
    }
}

// Factory function to create and start the bot
async function initMessengerBot() {
    const bot = new MessengerBot();
    await bot.start();
    return bot;
}

module.exports = { MessengerBot, initMessengerBot };