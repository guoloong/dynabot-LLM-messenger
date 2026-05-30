// services/llm/deepseekProvider.js
// DeepSeek LLM provider implementation
// Extends BaseLLMProvider with DeepSeek-specific API calls

const axios = require('axios');
const { BaseLLMProvider } = require('./baseProvider');
const { withRetry } = require('./utils/retryHandler');

// DeepSeek API configuration
const API_CONFIG = {
    name: 'deepseek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    timeout: 20000
};

class DeepSeekProvider extends BaseLLMProvider {
    /**
     * Create a DeepSeek provider instance
     * @param {Object} options - Configuration options
     * @param {string} options.apiKey - DeepSeek API key (defaults to env DEEPSEEK_API_KEY)
     * @param {string} options.model - Model to use (defaults to 'deepseek-chat')
     */
    constructor(options = {}) {
        const apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY;
        super({
            ...API_CONFIG,
            apiKey,
            model: options.model || process.env.DEEPSEEK_MODEL || API_CONFIG.model
        });

        // Create axios instance with default config
        this.httpClient = axios.create({
            timeout: API_CONFIG.timeout
        });
    }

    /**
     * Build headers for DeepSeek API
     * @returns {Object} Headers object
     */
    buildHeaders() {
        return {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Send a chat completion request with retry
     * @param {Array} messages - Array of message objects
     * @param {Object} options - Request options
     * @returns {Promise<string>} Response content
     */
    async chat(messages, options = {}) {
        if (!this.apiKey) {
            throw new Error('DeepSeek API key not configured');
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
                label: 'DeepSeek chat'
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
        console.log(`[DEEPSEEK] Extracting keywords from: "${userMessage}"`);

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
                console.log('[DEEPSEEK] Keyword extraction returned invalid result, using original message');
                return userMessage;
            }

            console.log(`[DEEPSEEK] Extracted keywords: "${trimmed}"`);
            return trimmed;
        } catch (err) {
            console.error('[DEEPSEEK] Keyword extraction failed:', err.message);
            return userMessage;
        }
    }

    /**
     * Search the internet using DuckDuckGo
     * @param {string} query - Search query
     * @returns {Promise<string|null>} Search results or null
     */
    async searchInternet(query) {
        console.log(`[DEEPSEEK] Internet search: "${query}"`);

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
                console.log(`[DEEPSEEK] Internet search returned ${text.length} chars`);
                return text;
            }

            console.log('[DEEPSEEK] Internet search returned insufficient content');
            return null;
        } catch (err) {
            console.error('[DEEPSEEK] Internet search error:', err.message);
            return null;
        }
    }

    /**
     * Parse JSON from LLM response
     * @param {string} content - Raw response content
     * @returns {Object} Parsed JSON or fallback object
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
                console.warn('[DEEPSEEK] JSON parse failed:', parseError.message);
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
        console.log(`[DEEPSEEK] Analyzing intent for: "${userMessage}"`);

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
                console.log(`[DEEPSEEK] Intent detected: intent=${result.intent}, product=${result.product}, currency=${result.currency}`);
                return {
                    intent: result.intent || 'general',
                    product: result.product || null,
                    currency: result.currency || null,
                    location: result.location || null,
                    needsMoreInfo: result.needsMoreInfo || false,
                    reasoning: result.reasoning || ''
                };
            }

            console.warn('[DEEPSEEK] Failed to parse intent JSON, using fallback');
            return this.fallbackIntentDetection(userMessage, history);
        } catch (err) {
            console.error('[DEEPSEEK] Intent analysis failed:', err.message);
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

        console.log(`[DEEPSEEK] Fallback intent: intent=${intent}, product=${product}, currency=${currency}`);

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
                    console.log(`[DEEPSEEK] Found product in history: ${product}`);
                    return product;
                }
            }
        }

        return null;
    }
}

module.exports = DeepSeekProvider;