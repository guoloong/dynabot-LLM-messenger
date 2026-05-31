// services/llm/minimaxProvider.js
// MiniMax LLM provider implementation
// Extends BaseLLMProvider with MiniMax-specific API calls
// API is OpenAI-compatible but uses max_completion_tokens instead of max_tokens

const axios = require('axios');
const { BaseLLMProvider } = require('./baseProvider');
const { withRetry } = require('./utils/retryHandler');

// MiniMax API configuration
const API_CONFIG = {
    name: 'minimax',
    endpoint: 'https://api.minimax.io/v1/chat/completions',
    model: 'MiniMax-M2.7',
    timeout: 20000
};

class MiniMaxProvider extends BaseLLMProvider {
    /**
     * Create a MiniMax provider instance
     * @param {Object} options - Configuration options
     * @param {string} options.apiKey - MiniMax API key (defaults to env MINIMAX_API_KEY)
     * @param {string} options.model - Model to use (defaults to 'MiniMax-M2.7')
     * @param {string} options.groupId - MiniMax Group ID (defaults to env MINIMAX_GROUP_ID)
     */
    constructor(options = {}) {
        const apiKey = options.apiKey || process.env.MINIMAX_API_KEY;
        const groupId = options.groupId || process.env.MINIMAX_GROUP_ID;

        super({
            ...API_CONFIG,
            apiKey,
            model: options.model || process.env.MINIMAX_MODEL || API_CONFIG.model,
            groupId
        });

        // Create axios instance with default config
        this.httpClient = axios.create({
            timeout: API_CONFIG.timeout
        });
    }

    /**
     * Build headers for MiniMax API
     * Requires Bearer auth + GroupId header
     * @returns {Object} Headers object
     */
    buildHeaders() {
        const headers = {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
        };

        // MiniMax requires GroupId header
        if (this.config.groupId) {
            headers['GroupId'] = this.config.groupId;
        }

        return headers;
    }

    /**
     * Build request payload for chat completions
     * MiniMax uses max_completion_tokens instead of max_tokens
     * @param {Array} messages - Message array
     * @param {Object} options - Request options
     * @returns {Object} Request payload
     */
    buildChatPayload(messages, options = {}) {
        // MiniMax uses max_completion_tokens instead of max_tokens
        const payload = {
            model: this.model,
            messages,
            extra_body: {
                reasoning_split: true
            }
        };

        // Set temperature (MiniMax default is 1.0, we want deterministic)
        if (options.temperature !== undefined) {
            payload.temperature = options.temperature;
        }

        // MiniMax-specific: use max_completion_tokens
        if (options.max_tokens) {
            payload.max_completion_tokens = options.max_tokens;
        } else if (options.maxTokens) {
            payload.max_completion_tokens = options.maxTokens;
        }

        return payload;
    }

    /**
     * Extract content from MiniMax response
     * Response format is OpenAI-compatible
     * With reasoning_split=true, thinking goes to reasoning_details field
     * Falls back to regex stripping if thinking tags still present
     * @param {Object} response - Raw API response
     * @returns {string} Extracted content
     */
    extractContent(response) {
        // Check for MiniMax-specific error in base_resp
        const baseResp = response.data?.base_resp;
        if (baseResp && baseResp.status_code !== 0) {
            throw new Error(`MiniMax API error: ${baseResp.status_msg || baseResp.status_code}`);
        }

        // Log reasoning_details if present (MiniMax-M2.7 thinking content)
        const reasoningDetails = response.data?.choices?.[0]?.message?.reasoning_details;
        if (reasoningDetails) {
            const reasoningText = typeof reasoningDetails === 'string'
                ? reasoningDetails
                : JSON.stringify(reasoningDetails);
            console.log(`[MINIMAX] Reasoning details: ${reasoningText.substring(0, 500)}...`);
        }

        // Standard OpenAI-compatible response extraction
        let content = response.data?.choices?.[0]?.message?.content || '';
        if (!content) {
            throw new Error('No content in MiniMax response');
        }

        // DEBUG: Log the raw content to see exact tag format
        console.log(`[MINIMAX] Raw content: ${content.substring(0, 200)}...`);

        // Strip thinking tags if present (MiniMax-M2.7 includes reasoning tags in content)
        content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
        content = content.replace(/<\/?think>/gi, '');

        // Trim leading/trailing whitespace after tag removal
        content = content.trim();

        return content;
    }

    /**
     * Send a chat completion request with retry
     * @param {Array} messages - Array of message objects
     * @param {Object} options - Request options
     * @returns {Promise<string>} Response content
     */
    async chat(messages, options = {}) {
        if (!this.apiKey) {
            throw new Error('MiniMax API key not configured');
        }

        const payload = this.buildChatPayload(messages, {
            temperature: options.temperature ?? 0.2,
            max_tokens: options.max_tokens ?? 500
        });

        const response = await withRetry(
            async () => {
                const res = await this.httpClient.post(
                    this.endpoint,
                    payload,
                    { headers: this.buildHeaders() }
                );
                return res;
            },
            {
                maxRetries: 3,
                baseDelay: 1000,
                label: 'MiniMax chat'
            }
        );

        return this.extractContent(response);
    }

    /**
     * Extract keywords from user message using LLM
     * @param {string} userMessage - Input message
     * @returns {Promise<string>} Keywords separated by spaces
     */
    async extractKeywords(userMessage) {
        console.log(`[MINIMAX] Extracting keywords from: "${userMessage}"`);

        if (!this.apiKey) {
            return userMessage;
        }

        const prompt = `Extract the most important keywords from this user message for a web search.
Return ONLY the keywords separated by spaces, no punctuation, no extra text.
Focus on product names, ingredients, health terms, key concepts.

User message: "${userMessage}"
Keywords:`;

        try {
            const keywords = await this.chat([
                { role: 'system', content: 'You are a keyword extraction tool. Respond only with the keywords.' },
                { role: 'user', content: prompt }
            ], {
                temperature: 0,
                max_tokens: 50
            });

            const trimmed = keywords.trim();

            // Validate result
            if (!trimmed || trimmed.split(/\s+/).length === 0 || trimmed.length < 3) {
                console.log('[MINIMAX] Keyword extraction returned invalid result, using original message');
                return userMessage;
            }

            console.log(`[MINIMAX] Extracted keywords: "${trimmed}"`);
            return trimmed;
        } catch (err) {
            console.error('[MINIMAX] Keyword extraction failed:', err.message);
            return userMessage;
        }
    }

    /**
     * Search the internet using DuckDuckGo
     * @param {string} query - Search query
     * @returns {Promise<string|null>} Search results or null
     */
    async searchInternet(query) {
        console.log(`[MINIMAX] Internet search: "${query}"`);

        try {
            const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

            const response = await withRetry(
                async () => {
                    return this.httpClient.get(url, {
                        timeout: 8000,
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    });
                },
                {
                    maxRetries: 3,
                    baseDelay: 500,
                    label: 'Internet search'
                }
            );

            let text = response.data.AbstractText || '';

            // Add related topics if available
            if (response.data.RelatedTopics) {
                const firstTopics = response.data.RelatedTopics.slice(0, 3)
                    .map(t => t.Text || '')
                    .join(' ');
                text = (text + ' ' + firstTopics).trim();
            }

            if (text.length > 50) {
                console.log(`[MINIMAX] Internet search returned ${text.length} chars`);
                return text;
            }

            console.log('[MINIMAX] Internet search returned insufficient content');
            return null;
        } catch (err) {
            console.error('[MINIMAX] Internet search error:', err.message);
            return null;
        }
    }

    /**
     * Parse JSON from LLM response
     * @param {string} content - Raw response content
     * @returns {Object|null} Parsed JSON or null
     */
    parseJSON(content) {
        let cleaned = content.trim();

        // Remove markdown code blocks
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
        }

        // Find JSON object boundaries
        const jsonStart = cleaned.indexOf('{');
        const jsonEnd = cleaned.lastIndexOf('}');

        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
            const jsonStr = cleaned.substring(jsonStart, jsonEnd + 1);
            try {
                return JSON.parse(jsonStr);
            } catch (parseError) {
                console.warn('[MINIMAX] JSON parse failed:', parseError.message);
            }
        }

        return null;
    }

    /**
     * Analyze intent from user message using structured prompt
     * @param {string} userMessage - User message
     * @param {Object} context - Additional context (history, userId, phone, etc.)
     * @returns {Promise<Object>} Parsed intent result
     */
    async analyzeIntent(userMessage, context = {}) {
        console.log(`[MINIMAX] Analyzing intent for: "${userMessage}"`);

        const { history = [], userId = '', phoneNumber = '' } = context;

        // Build conversation context string
        const conversationContext = this.buildConversationContext(history, 10);

        const contextInfo = context.ctx ? `
EXISTING CONTEXT (use when current message is a follow-up):
- Last product user asked about for price: ${context.ctx.lastPriceProduct || 'none'}
- Last currency used: ${context.ctx.lastPriceCurrency || 'none'}
- Last product user mentioned: ${context.ctx.lastMentionedProduct || 'none'}
- Pending store product: ${context.ctx.pendingStoreProduct || 'none'}` : '';

        const prompt = `Analyze this user message for a WhatsApp health products chatbot.

${conversationContext ? `CONVERSATION HISTORY (last ${Math.min(history.length, 10)} messages):
${conversationContext}
---` : ''}

CURRENT MESSAGE: "${userMessage}"
${contextInfo}

TASK:
Determine the user's INTENT and extract relevant information.

Return ONLY a JSON object with this exact format:
{
    "intent": "price" | "store" | "marketplace" | "general",
    "product": "product slug or null",
    "currency": "SGD" | "MYR" | "IDR" | "THB" | "PHP" | "VND" | null,
    "location": "location name or null",
    "needsMoreInfo": true | false,
    "reasoning": "brief explanation"
}

INTENT DEFINITIONS:
- "price": User asks about product cost, pricing, how much, etc.
- "store": User asks about PHYSICAL RETAIL STORE LOCATIONS
- "marketplace": User asks about ONLINE MARKETPLACE PURCHASING
- "general": Any other question

CURRENCY DETECTION:
- "SGD" for Singapore, "MYR" for Malaysia, etc.

LOCATION DETECTION:
- Countries: Malaysia, Singapore, Indonesia, Thailand, Philippines, Vietnam
- Areas: KL, Kuala Lumpur, PJ, Petaling Jaya, Subang Jaya, Shah Alam, Penang, Johor, JB, Singapore

PRODUCT DETECTION:
- Detect from current message OR recent history
- Slugs: bionatto, men-guard, riflex-360, ashislim, optiberries, tricollagen, etc.

User message: "${userMessage}"
Response:`;

        try {
            const content = await this.chat([
                { role: 'system', content: 'You are a JSON parser. Return ONLY valid JSON, no markdown, no explanation.' },
                { role: 'user', content: prompt }
            ], {
                temperature: 0,
                max_tokens: 300
            });

            const result = this.parseJSON(content);

            if (result) {
                console.log(`[MINIMAX] Intent detected: intent=${result.intent}, product=${result.product}, currency=${result.currency}`);
                return {
                    intent: result.intent || 'general',
                    product: result.product || null,
                    currency: result.currency || null,
                    location: result.location || null,
                    needsMoreInfo: result.needsMoreInfo || false,
                    reasoning: result.reasoning || ''
                };
            }

            console.warn('[MINIMAX] Failed to parse intent JSON, using fallback');
            return this.fallbackIntentDetection(userMessage, history);
        } catch (err) {
            console.error('[MINIMAX] Intent analysis failed:', err.message);
            return this.fallbackIntentDetection(userMessage, history);
        }
    }

    /**
     * Build conversation context string from history
     * @param {Array} history - Message history
     * @param {number} maxMessages - Maximum messages to include
     * @returns {string} Context string
     */
    buildConversationContext(history, maxMessages = 10) {
        if (!history || history.length === 0) return '';

        const recentMessages = history.slice(-maxMessages);
        const lines = [];

        for (const msg of recentMessages) {
            const role = msg.role === 'user' ? 'User' : 'Bot';
            const content = msg.content.length > 100 ? msg.content.substring(0, 100) + '...' : msg.content;
            lines.push(`${role}: "${content}"`);
        }

        return lines.join('\n');
    }

    /**
     * Fallback intent detection when LLM fails
     * @param {string} userMessage - User message
     * @param {Array} history - Message history
     * @returns {Object} Intent result
     */
    fallbackIntentDetection(userMessage, history = []) {
        const lowerMsg = userMessage.toLowerCase();

        const locations = ['singapore', 'malaysia', 'kl', 'kuala lumpur', 'pj', 'petaling jaya',
            'subang', 'subang jaya', 'shah alam', 'penang', 'johor', 'jb',
            'indonesia', 'thailand', 'philippines', 'vietnam'];

        const priceKeywords = ['price', 'cost', 'how much', 'rm', 'sg$', 'dollars', 'cheap'];
        const marketplaceKeywords = ['lazada', 'shopee', 'tiktok', 'official website', 'official store',
            'buy online', 'buy from', 'marketplace'];
        const storeKeywords = ['where to buy', 'where can i buy', 'store', 'stores', 'pharmacy',
            'watsons', 'guardian', 'caring', 'retail', 'near me'];

        const isPrice = priceKeywords.some(k => lowerMsg.includes(k));
        const isMarketplace = marketplaceKeywords.some(k => lowerMsg.includes(k));
        const isStore = storeKeywords.some(k => lowerMsg.includes(k));

        // Detect currency
        let currency = null;
        if (lowerMsg.includes('singapore') || lowerMsg.includes('sg')) currency = 'SGD';
        else if (lowerMsg.includes('malaysia') || lowerMsg.includes('kl') || lowerMsg.includes('rm')) currency = 'MYR';

        // Detect location
        let location = null;
        for (const loc of locations) {
            if (lowerMsg.includes(loc)) {
                location = loc;
                break;
            }
        }

        // Detect product
        const product = this.extractProductFromText(userMessage) || this.findProductInHistory(history);

        let intent = 'general';
        if (isPrice) intent = 'price';
        else if (isMarketplace) intent = 'marketplace';
        else if (isStore) intent = 'store';

        console.log(`[MINIMAX] Fallback intent: intent=${intent}, product=${product}, currency=${currency}`);

        return {
            intent,
            product,
            currency,
            location,
            needsMoreInfo: false,
            reasoning: 'fallback'
        };
    }

    /**
     * Extract product from text
     * @param {string} text - Input text
     * @returns {string|null} Product slug or null
     */
    extractProductFromText(text) {
        const lowerText = text.toLowerCase();

        const productPatterns = [
            { name: 'bionatto', patterns: ['bionatto', 'bio-natto'] },
            { name: 'men-guard', patterns: ['men guard', 'menguard', 'men-guard'] },
            { name: 'riflex-360', patterns: ['riflex', 'riflex 360', 'riflex-360'] },
            { name: 'ashislim', patterns: ['ashislim', 'ashi slim'] },
            { name: 'optiberries', patterns: ['optiberries', 'opti berries'] },
            { name: 'tricollagen', patterns: ['tricollagen', 'tri collagen'] },
            { name: 'vitamune', patterns: ['vitamune', 'cdz'] },
            { name: 'hairegain', patterns: ['hairegain', 'hair gain'] },
            { name: 'hp-floragut', patterns: ['hp-floragut', 'hp floragut', 'floragut'] },
            { name: 'glucopal', patterns: ['glucopal', 'gluco pal'] },
            { name: 'elderola', patterns: ['elderola'] },
            { name: 'nustem', patterns: ['nustem', 'nu stem'] },
            { name: 'uri-comfort', patterns: ['uri comfort', 'uri-comfort'] },
            { name: 'liveprotein', patterns: ['liveprotein', 'live protein'] },
            { name: 'marinecal-plus', patterns: ['marinecal', 'marine cal'] },
            { name: 'optivue', patterns: ['optivue', 'opti vue'] },
            { name: 'organic-ashitaba', patterns: ['ashitaba', 'organic ashitaba'] },
            { name: 'black-elderberry-juice', patterns: ['elderberry', 'black elderberry'] },
            { name: 'tibetan-seaberry', patterns: ['seaberry', 'sea berry', 'tibetan'] },
            { name: 'super-bio-organic', patterns: ['super bio', 'super bio organic'] }
        ];

        for (const { name, patterns } of productPatterns) {
            for (const pattern of patterns) {
                if (lowerText.includes(pattern)) {
                    return name;
                }
            }
        }

        return null;
    }

    /**
     * Find product in message history
     * @param {Array} history - Message history
     * @returns {string|null} Product slug or null
     */
    findProductInHistory(history) {
        if (!history || history.length === 0) return null;

        for (let i = history.length - 1; i >= 0; i--) {
            const msg = history[i];
            if (msg.role === 'user') {
                const product = this.extractProductFromText(msg.content);
                if (product) {
                    console.log(`[MINIMAX] Found product in history: ${product}`);
                    return product;
                }
            }
        }

        return null;
    }
}

module.exports = MiniMaxProvider;