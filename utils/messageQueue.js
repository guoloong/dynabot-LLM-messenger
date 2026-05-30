// utils/messageQueue.js
// Intelligent message queuing system with wait-and-combine strategy
// Handles rapid messages by batching them within a time window
// Works for both WhatsApp and Messenger platforms

// Platform constants (must match values in humanHandoff.js)
const PLATFORM_WHATSAPP = 'whatsapp';
const PLATFORM_MESSENGER = 'messenger';

class MessageQueue {
    constructor(options = {}) {
        // Configuration
        this.COMBINE_WINDOW_MS = options.combineWindowMs || 2000;  // Wait time to see if more messages come
        this.MAX_QUEUE_SIZE = options.maxQueueSize || 10;           // Max messages to combine
        this.MIN_MESSAGE_LENGTH = options.minMessageLength || 1;    // Minimum characters to process
        this.PROCESSING_DELAY_MS = options.processingDelayMs || 1500;  // Delay between responses

        // Per-user state: Map<userId, UserState>
        this.userStates = new Map();

        // Stats for monitoring
        this.stats = {
            totalMessagesQueued: 0,
            totalMessagesProcessed: 0,
            totalCombined: 0,
            queueOverflowCount: 0
        };
    }

    // Get or create user state
    getUserState(userId) {
        if (!this.userStates.has(userId)) {
            this.userStates.set(userId, {
                pendingMessages: [],      // Array of {content, timestamp}
                timer: null,               // setTimeout ID
                processing: false,        // Is user currently being processed?
                newMessagesDuringProcessing: false,  // Did new messages arrive while processing?
                lastProcessed: null,       // Timestamp of last processed message
                platform: 'whatsapp'       // 'whatsapp' or 'messenger'
            });
        }
        return this.userStates.get(userId);
    }

    // Queue a message for a user
    async enqueue(userId, message, platform = 'whatsapp', imageAnalysisResult = null) {
        const state = this.getUserState(userId);
        state.platform = platform;

        // Check for spam/overflow
        if (state.pendingMessages.length >= this.MAX_QUEUE_SIZE) {
            this.stats.queueOverflowCount++;
            console.log(`[QUEUE] User ${userId} exceeded max queue size (${this.MAX_QUEUE_SIZE})`);

            // Send warning to user
            await this.sendMessage(userId,
                "You're sending messages too quickly. Please wait for responses before sending more.",
                platform);
            return false;
        }

        // Skip very short/empty messages
        if (!message || message.trim().length < this.MIN_MESSAGE_LENGTH) {
            console.log(`[QUEUE] Skipping empty/too-short message from ${userId}`);
            return false;
        }

        // Add message to pending queue
        state.pendingMessages.push({
            content: message.trim(),
            timestamp: Date.now(),
            imageAnalysis: imageAnalysisResult  // Store image analysis with first message
        });

        this.stats.totalMessagesQueued++;

        console.log(`[QUEUE] User ${userId}: queued message "${message.substring(0, 50)}..." (queue size: ${state.pendingMessages.length})`);

        // Track if new messages arrive while processing
        if (state.processing) {
            state.newMessagesDuringProcessing = true;
            console.log(`[QUEUE] User ${userId}: new message while processing, will process after current batch`);
            return true;
        }

        // If NOT currently processing, start/update the combine window timer
        // This allows more time for rapid messages to arrive before processing
        if (!state.processing) {
            // Clear any existing timer
            if (state.timer) {
                clearTimeout(state.timer);
            }

            // Set timer for batch processing
            state.timer = setTimeout(() => {
                this.processQueue(userId);
            }, this.COMBINE_WINDOW_MS);

            // Send typing indicator to show activity
            this.sendTypingIndicator(userId, platform);
        }

        return true;
    }

    // Process queued messages for a user
    async processQueue(userId) {
        const state = this.userStates.get(userId);
        if (!state) return;

        // Clear timer - we're processing now
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }

        // Skip if already processing
        if (state.processing) {
            console.log(`[QUEUE] User ${userId} already processing`);
            return;
        }

        // Skip if queue is empty
        if (state.pendingMessages.length === 0) {
            return;
        }

        // Mark as processing
        state.processing = true;

        // Take ALL messages from queue
        const messagesToProcess = [...state.pendingMessages];
        state.pendingMessages = [];

        // Combine all messages
        const combined = this.combineMessages(messagesToProcess, state);
        const imageAnalysisResult = messagesToProcess[0]?.imageAnalysis || null;
        const count = messagesToProcess.length;

        console.log(`[QUEUE] User ${userId}: combining ${count} message(s): "${combined.substring(0, 50)}..."`);

        if (count > 1) {
            this.stats.totalCombined++;
        }

        // Process the combined message
        await this.processMessage(userId, combined, count, state.platform, imageAnalysisResult);

        // Update stats
        this.stats.totalMessagesProcessed++;
        state.lastProcessed = Date.now();

        // Clear processing flag
        state.processing = false;

        // Check if new messages arrived during processing
        if (state.pendingMessages.length > 0) {
            console.log(`[QUEUE] User ${userId}: ${state.pendingMessages.length} new message(s) arrived, waiting...`);

            // Set timer for new messages (2 seconds of silence before processing)
            state.timer = setTimeout(() => {
                this.processQueue(userId);
            }, this.COMBINE_WINDOW_MS);
        }
    }

    // Combine multiple messages into one
    combineMessages(messages, state) {
        if (messages.length === 0) return '';
        if (messages.length === 1) return messages[0].content;

        // Extract content strings
        const contents = messages.map(m => m.content);

        // Check if messages are very short (likely split sentence)
        const avgLength = contents.reduce((sum, c) => sum + c.length, 0) / contents.length;
        const isSplitSentence = avgLength < 15 && contents.length >= 2;

        if (isSplitSentence) {
            console.log(`[QUEUE] Detected likely split sentence (avg length: ${avgLength.toFixed(1)} chars)`);
        }

        // Combine with space, preserve original order
        return contents.join(' ');
    }

    // Process message - to be overridden by bot implementation
    async processMessage(userId, combinedMessage, messageCount, platform) {
        // This should be replaced by the bot's actual message handler
        // For now, throw an error if not implemented
        throw new Error('processMessage must be implemented by the bot');
    }

    // Send typing indicator - to be implemented by bot
    async sendTypingIndicator(userId, platform) {
        // This should be replaced by the bot's typing indicator implementation
        // Bot will override this method
    }

    // Send text message - to be implemented by bot
    async sendMessage(userId, text, platform) {
        // This should be replaced by the bot's message sending implementation
        // Bot will override this method
    }

    // Force process a user's queue immediately (e.g., before bot shutdown)
    async forceProcess(userId) {
        const state = this.userStates.get(userId);
        if (state && state.pendingMessages.length > 0) {
            console.log(`[QUEUE] Force processing queue for ${userId}`);
            await this.processQueue(userId);
        }
    }

    // Clear a user's queue
    clearQueue(userId) {
        const state = this.userStates.get(userId);
        if (state) {
            if (state.timer) {
                clearTimeout(state.timer);
                state.timer = null;
            }
            state.pendingMessages = [];
            state.processing = false;
            console.log(`[QUEUE] Cleared queue for ${userId}`);
        }
    }

    // Get queue status for a user
    getQueueStatus(userId) {
        const state = this.userStates.get(userId);
        if (!state) {
            return { queued: 0, processing: false };
        }
        return {
            queued: state.pendingMessages.length,
            processing: state.processing,
            lastProcessed: state.lastProcessed
        };
    }

    // Get all stats
    getStats() {
        return {
            ...this.stats,
            activeUsers: this.userStates.size,
            usersProcessing: Array.from(this.userStates.entries())
                .filter(([_, state]) => state.processing)
                .map(([userId, _]) => userId)
        };
    }

    // Cleanup old entries (called periodically)
    cleanup() {
        const now = Date.now();
        const EXPIRY_MS = 30 * 60 * 1000;  // 30 minutes
        let cleaned = 0;

        for (const [userId, state] of this.userStates.entries()) {
            const lastActivity = state.lastProcessed || 0;
            const pending = state.pendingMessages.length > 0;

            // Remove users with no recent activity and empty queue
            if (!pending && (now - lastActivity > EXPIRY_MS)) {
                this.userStates.delete(userId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[QUEUE] Cleaned up ${cleaned} inactive users`);
        }

        return cleaned;
    }

    // Start periodic cleanup
    startCleanup(intervalMs = 5 * 60 * 1000) {  // Every 5 minutes
        setInterval(() => this.cleanup(), intervalMs);
    }
}

module.exports = { MessageQueue, PLATFORM_WHATSAPP, PLATFORM_MESSENGER };