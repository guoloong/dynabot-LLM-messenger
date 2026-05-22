// bot/messengerBot.js
// Facebook Messenger bot with DeepSeek AI integration

const express = require('express');
const axios = require('axios');
const { generateResponse } = require('../services/deepseek');
const { routeMessage } = require('../services/messageRouter');
const { getProductPrice, formatPriceResponse } = require('../services/priceApi');
const { findStores } = require('../services/storeLocator');
const { getHistory, addMessage } = require('../utils/memory');
const { splitIntoChunks } = require('../utils/llmMessageSplitter');

// Messenger Bot class
class MessengerBot {
    constructor() {
        this.app = express();
        this.app.use(express.json());
        this.PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
        this.VERIFY_TOKEN = process.env.VERIFY_TOKEN;
        this.userCooldowns = new Map();
        this.COOLDOWN_MS = 2000;

        this.setupRoutes();

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

    // Handle incoming text message
    async handleMessage(senderPsid, receivedMessage) {
        // Skip echoes
        if (receivedMessage.is_echo) {
            console.log('[MESSENGER] Skipping echo message');
            return;
        }

        // Get message text
        const messageText = receivedMessage.text ? receivedMessage.text.trim() : null;

        if (!messageText) {
            console.log('[MESSENGER] No text in message, skipping');
            return;
        }

        console.log(`[MESSENGER] Message from ${senderPsid}: "${messageText}"`);

        // Apply cooldown
        const now = Date.now();
        const lastMsgTime = this.userCooldowns.get(senderPsid) || 0;
        if (now - lastMsgTime < this.COOLDOWN_MS) {
            console.log(`[MESSENGER] Cooldown active, skipping`);
            return;
        }
        this.userCooldowns.set(senderPsid, now);

        try {
            // Get conversation history for context
            const history = getHistory(senderPsid);

            // Route message to appropriate handler
            console.log(`[MESSENGER] Routing message with history: ${history.length} messages`);
            const route = await routeMessage(messageText, senderPsid, null, process.env.DEEPSEEK_API_KEY, history);
            console.log(`[MESSENGER] Routed to: ${route.handler}`, route.params);

            // Handle based on route
            if (route.handler === 'priceApi') {
                await this.handlePriceQuery(senderPsid, route.params.productName, route.params.currency);
                return;
            }

            if (route.handler === 'storeLocator') {
                await this.handleStoreQuery(senderPsid, messageText, route.params);
                return;
            }

            // Default: Generate DeepSeek response
            console.log(`[MESSENGER] Routing to DeepSeek (general response)`);

            const response = await generateResponse(
                messageText,
                '',
                process.env.DEEPSEEK_API_KEY,
                history
            );

            const finalReply = response.text || "I'm having trouble responding. Please try again.";
            const imageUrl = response.imageUrl;
            const productName = response.productName;

            // Send response
            await this.sendLongMessage(senderPsid, finalReply);

            // Send product image if applicable
            if (imageUrl && productName) {
                try {
                    await this.sendImageUrl(senderPsid, imageUrl, productName);
                } catch (err) {
                    console.error('[MESSENGER] Failed to send product image:', err.message);
                }
            }

            // Save to history
            addMessage(senderPsid, 'user', messageText);
            addMessage(senderPsid, 'assistant', finalReply);

        } catch (err) {
            console.error('[MESSENGER] Error handling message:', err);
            await this.sendMessage(senderPsid, "Something went wrong. Please try again later.");
        }
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

        try {
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

    // Handle price query
    async handlePriceQuery(senderPsid, productName, currency) {
        console.log(`[MESSENGER] Processing price query: product=${productName}, currency=${currency}`);

        if (!productName) {
            await this.sendMessage(senderPsid, 'Which product would you like to know the price of?');
            return;
        }

        try {
            const priceInfo = await getProductPrice(productName, null, process.env.DEEPSEEK_API_KEY, currency);

            if (priceInfo) {
                const response = formatPriceResponse(productName, priceInfo, currency);
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

    // Handle store locator query
    async handleStoreQuery(senderPsid, userMessage, routeParams) {
        console.log(`[MESSENGER] Processing store query`);

        try {
            const storeResult = await findStores(userMessage, process.env.DEEPSEEK_API_KEY, routeParams);

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

        // Use LLM-based splitting for intelligent chunking
        const chunks = await splitIntoChunks(text, process.env.DEEPSEEK_API_KEY);

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