// services/messageRouter.js
// LLM-based message routing - determines intent and routes to appropriate handler
// Routes: price (priceApi), store (storeLocator), or general (deepseek)

const axios = require('axios');
const { getContext, updatePriceContext, updateStoreContext, updateMentionedProduct, clearPriceContext, clearStoreContext } = require('./contextManager');

// Configuration
const MAX_HISTORY_MESSAGES = 20;

// Known products list for the LLM
const KNOWN_PRODUCTS = [
    'bionatto', 'men-guard', 'ashiguard', 'ashislim', 'black-elderberry-juice',
    'elderola', 'glucopal', 'hairegain', 'hp-floragut', 'liveprotein',
    'marinecal-plus', 'nustem', 'optiberries', 'optivue', 'organic-ashitaba',
    'super-bio-organic', 'tibetan-seaberry', 'tricollagen', 'uri-comfort',
    'vitamune-cdz', 'riflex-360', 'liveberries', 'liveessence', 'livezymes',
    'nitrovar', 'bone-builder', 'liver-detox'
];

/**
 * Build conversation context string from history
 */
function buildConversationContext(history, maxMessages = MAX_HISTORY_MESSAGES) {
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
 * Use LLM to analyze user message and determine intent
 * Now includes conversation history for better context understanding
 */
async function analyzeIntent(userMessage, userId, phoneNumber, apiKey, history = []) {
    console.log(`[ROUTER] Analyzing intent for: "${userMessage}"`);
    console.log(`[ROUTER] History messages: ${history.length}`);

    if (!apiKey) {
        console.warn('[ROUTER] No API key - using fallback intent detection');
        return fallbackIntentDetection(userMessage, history);
    }

    // Build conversation context
    const conversationContext = buildConversationContext(history, 10);

    // Get context for follow-up handling
    const ctx = getContext(userId);

    const contextInfo = ctx ? `
EXISTING CONTEXT (use when current message is a follow-up):
- Last product user asked about for price: ${ctx.lastPriceProduct || 'none'}
- Last currency used: ${ctx.lastPriceCurrency || 'none'}
- Last product user mentioned: ${ctx.lastMentionedProduct || 'none'}
- Pending store product: ${ctx.pendingStoreProduct || 'none'}` : '';

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

INTENT DEFINITIONS (IMPORTANT - choose the most specific match):
- "price": User asks about product cost, pricing, how much, etc.
- "store": User asks about PHYSICAL RETAIL STORE LOCATIONS (pharmacy near me, find stores in KL, where to buy near JB, stores in Singapore, Caring pharmacy, Watsons, Guardian)
- "marketplace": User asks about ONLINE MARKETPLACE PURCHASING (buy on Lazada, Shopee, TikTok, official website, is it on Shopee?, available on TikTok?, can I buy from Lazada?)
- "general": Any other question (benefits, dosage, shipping, "I want to buy", "where to purchase" without specifying platform)

**"HOW TO BUY" IS MARKETPLACE:**
- "How to buy" → marketplace (NOT general)
- "How to order" → marketplace
- "Where can I buy" → marketplace
- "I want to buy" → marketplace
- "Show me how to buy" → marketplace
- "How do I purchase" → marketplace

MARKETPLACE EXAMPLES (route to "marketplace"):
- "Is this product on Shopee?"
- "Can I buy from Lazada?"
- "Do you have TikTok shop?"
- "Official website link"
- "Buy from your website"
- "How to order online?"
- "I want to buy from Shopee"
- "Available on Lazada Malaysia?"
- "How to buy?" (CRITICAL: this is marketplace, NOT general!)
- "Where to buy online?"

RETAIL STORE EXAMPLES (route to "store"):
- "Where can I buy near KLCC?"
- "Find stores in Singapore"
- "Pharmacy near me"
- "Stores in Johor"
- "Watsons near PJ"
- "Caring pharmacy Shah Alam"
- "Is it available at Guardian?"

FOLLOW-UP HANDLING:
- If user says "Price?" or "how much?" and they mentioned a product in history → use that product
- If user says "Where to buy?" and they mentioned a product in history → use that product
- If user says "How about Malaysia?" after price query → change currency to MYR
- If user says "How about JB?" after store query → change location to JB

NUMERIC SELECTION HANDLING (critical!):
- If user sends a single number (1, 2, 3, etc.) or text like "option 2", "the second one", "3 please"
- Check the conversation history - if the bot recently listed numbered options (e.g., "1. TriCollagen\n2. Tibetan Seaberry\n...")
- Interpret the number as selecting that option and return the corresponding product
- Example: User sends "4" and history shows "1. TriCollagen\n2. Tibetan Seaberry\n3. LiveBerries\n4. MarineCal Plus"
- → Return product=marinecal-plus (or appropriate slug)
- Return "general" intent but include the selected product

CURRENCY DETECTION:
- "SGD", "MYR", "IDR", "THB", "PHP", "VND", etc. based on location mentioned
- If user mentions a country, use that country's currency
- If phone is from Singapore (65...), default to SGD
- If phone is from Malaysia (60...), default to MYR

LOCATION DETECTION:
- Countries: Malaysia, Singapore, Indonesia, Thailand, Philippines, Vietnam
- Areas: KL, Kuala Lumpur, PJ, Petaling Jaya, Subang Jaya, Shah Alam, Penang, Johor, JB, Singapore, SG, etc.

PRODUCT DETECTION (important!):
- Detect product names: BioNatto, Men Guard, Riflex 360, Ashislim, Optiberries, Tricollagen, etc.
- If user mentions a product in current message OR in recent history, extract it
- Product slugs: bionatto, men-guard, riflex-360, ashislim, optiberries, tricollagen, vitamune-cdz, hairegain, hp-floragut, glucopal, elderola, nustem, uri-comfort

User message: "${userMessage}"
Response:`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are a JSON parser. Return ONLY valid JSON, no markdown, no explanation.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0,
                max_tokens: 300
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                signal: controller.signal,
                timeout: 20000
            }
        );

        clearTimeout(timeoutId);
        const content = response.data.choices[0].message.content.trim();

        // Parse JSON
        let jsonStr = content.replace(/```json\n?|```\n?/gi, '').trim();
        const result = JSON.parse(jsonStr);

        console.log(`[ROUTER] LLM detected: intent=${result.intent}, product=${result.product}, currency=${result.currency}, location=${result.location}`);

        return {
            intent: result.intent || 'general',
            product: result.product || null,
            currency: result.currency || null,
            location: result.location || null,
            needsMoreInfo: result.needsMoreInfo || false,
            reasoning: result.reasoning || ''
        };

    } catch (err) {
        console.error(`[ROUTER] LLM analysis failed: ${err.message}`);
        return fallbackIntentDetection(userMessage, history);
    }
}

/**
 * Extract product from message text
 */
function extractProductFromText(text) {
    const lowerText = text.toLowerCase();

    const productPatterns = [
        { name: 'bionatto', patterns: ['bionatto', 'bio-natto'] },
        { name: 'men-guard', patterns: ['men guard', 'menguard', 'men-guard'] },
        { name: 'riflex-360', patterns: ['riflex', 'riflex 360', 'riflex-360', 'vitalguard'] },
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
        { name: 'super-bio-organic', patterns: ['super bio', 'super bio organic'] },
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
 * Find most recent product mention in history
 */
function findProductInHistory(history) {
    if (!history || history.length === 0) return null;

    // Look at last 10 messages (user + bot pairs)
    for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        if (msg.role === 'user') {
            const product = extractProductFromText(msg.content);
            if (product) {
                console.log(`[ROUTER] Found product in history: ${product}`);
                return product;
            }
        }
    }

    return null;
}

/**
 * Fallback intent detection when LLM fails
 */
function fallbackIntentDetection(userMessage, history = []) {
    const lowerMsg = userMessage.toLowerCase();

    // Location list (must be before usage)
    const locations = ['singapore', 'malaysia', 'kl', 'kuala lumpur', 'pj', 'petaling jaya', 'subang', 'subang jaya',
        'shah alam', 'penang', 'johor', 'jb', 'johor bahru', 'ipoh', 'melaka', 'seremban',
        'indonesia', 'thailand', 'philippines', 'vietnam', 'sabah', 'sarawak'];

    // Price keywords
    const priceKeywords = ['price', 'cost', 'how much', 'rm', 'sg$', 'dollars', 'cheap'];
    const isPrice = priceKeywords.some(k => lowerMsg.includes(k));

    // Marketplace keywords (online platforms)
    const marketplaceKeywords = ['lazada', 'shopee', 'tiktok', 'official website', 'official store',
        'buy online', 'buy from', 'marketplace', 'online purchase', 'vt.tiktok'];
    const isMarketplace = marketplaceKeywords.some(k => lowerMsg.includes(k));

    // Physical store keywords (retail locations)
    const storeKeywords = ['where to buy', 'where can i buy', 'store', 'stores', 'pharmacy',
        'watsons', 'guardian', 'caring', 'retail', 'near me', 'near'];
    const isStore = storeKeywords.some(k => lowerMsg.includes(k));

    // Check for location-specific buy queries (these should go to store)
    const hasLocation = locations.some(loc => lowerMsg.includes(loc));
    const hasBuyKeyword = lowerMsg.includes('buy');
    const isPhysicalStoreQuery = hasBuyKeyword && hasLocation;

    // Detect currency
    let currency = null;
    if (lowerMsg.includes('singapore') || lowerMsg.includes('sg')) currency = 'SGD';
    else if (lowerMsg.includes('malaysia') || lowerMsg.includes('kl') || lowerMsg.includes('rm')) currency = 'MYR';
    else if (lowerMsg.includes('indonesia') || lowerMsg.includes('rp')) currency = 'IDR';
    else if (lowerMsg.includes('thailand') || lowerMsg.includes('thb')) currency = 'THB';
    else if (lowerMsg.includes('philippines') || lowerMsg.includes('php')) currency = 'PHP';
    else if (lowerMsg.includes('vietnam') || lowerMsg.includes('vnd')) currency = 'VND';

    // Detect location
    let location = null;
    for (const loc of locations) {
        if (lowerMsg.includes(loc)) {
            location = loc;
            break;
        }
    }

    // Detect product from current message OR history
    let product = extractProductFromText(userMessage);

    if (!product) {
        product = findProductInHistory(history);
    }

    let intent = 'general';
    if (isPrice) intent = 'price';
    else if (isMarketplace) intent = 'marketplace';
    else if (isStore || isPhysicalStoreQuery) intent = 'store';

    console.log(`[ROUTER] Fallback detected: intent=${intent}, product=${product}, currency=${currency}, location=${location}`);

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
 * Determine currency from phone number prefix
 */
function getCurrencyFromPhone(phoneNumber) {
    if (!phoneNumber) return null;

    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');

    // Check for country prefixes
    if (cleanPhone.startsWith('65')) return 'SGD';
    if (cleanPhone.startsWith('60')) return 'MYR';
    if (cleanPhone.startsWith('62')) return 'IDR';
    if (cleanPhone.startsWith('66')) return 'THB';
    if (cleanPhone.startsWith('63')) return 'PHP';
    if (cleanPhone.startsWith('84')) return 'VND';

    return null;
}

/**
 * Extract region from phone number (for marketplace URL selection)
 */
function getRegionFromPhone(phoneNumber) {
    if (!phoneNumber) return null;
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('65')) return 'Singapore';
    if (cleanPhone.startsWith('60')) return 'Malaysia';
    return null;
}

/**
 * Extract marketplace URL from knowledge base based on user request
 * Returns: { type, url, platform, region, officialUrl }
 */
function extractMarketplaceUrl(userMessage, phoneNumber, kb) {
    const lowerMsg = userMessage.toLowerCase();
    const ecommerceStores = kb?.ecommerceStores || {};
    const marketplaces = ecommerceStores.marketplaces || [];
    const official = ecommerceStores.official || {};

    console.log(`[ROUTER] extractMarketplaceUrl: msg="${userMessage}", phone=${phoneNumber}`);
    console.log(`[ROUTER] Available marketplaces in KB:`, marketplaces.map(m => `${m.platform}/${m.region}`));

    // Detect platform from message (case-insensitive matching, preserve KB case for display)
    let requestedPlatform = null;

    // Map lowercase detection to KB case (case-insensitive match)
    const platformMap = {
        'lazada': 'Lazada',
        'shopee': 'Shopee',
        'tiktok': 'TikTok Shop'
    };

    if (lowerMsg.includes('lazada')) requestedPlatform = platformMap['lazada'];
    else if (lowerMsg.includes('shopee')) requestedPlatform = platformMap['shopee'];
    else if (lowerMsg.includes('tiktok')) requestedPlatform = platformMap['tiktok'];
    else if (lowerMsg.includes('official website') || lowerMsg.includes('official store')) {
        console.log(`[ROUTER] Platform detected: official website`);
        return {
            type: 'official',
            url: official.url || 'https://www.dyna-nutrition.com',
            name: official.name || 'Official Website',
            platform: null,
            region: null
        };
    }

    console.log(`[ROUTER] Platform detected from message: ${requestedPlatform}`);

    // Detect region: try message first, then phone
    let region = null;

    // Check message for region
    if (lowerMsg.includes('singapore') || lowerMsg.includes('sg ')) region = 'Singapore';
    else if (lowerMsg.includes('malaysia') || lowerMsg.includes('my ')) region = 'Malaysia';

    // If no region in message, try phone number
    if (!region) {
        region = getRegionFromPhone(phoneNumber);
    }

    // If still no region, check phone for default
    if (!region && phoneNumber) {
        const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('65')) region = 'Singapore';
        else if (cleanPhone.startsWith('60')) region = 'Malaysia';
    }

    console.log(`[ROUTER] Region detected: ${region} (from phone: ${phoneNumber})`);

    // Find matching marketplace
    if (requestedPlatform) {
        console.log(`[ROUTER] Looking for platform="${requestedPlatform}", region="${region}"`);
        console.log(`[ROUTER] Checking each marketplace entry...`);
        for (const m of marketplaces) {
            console.log(`  - ${m.platform}/${m.region}: match=${m.platform === requestedPlatform && (region === null || m.region === region)}`);
        }

        if (region) {
            // Has platform AND region - find exact match
            const match = marketplaces.find(m => m.platform === requestedPlatform && m.region === region);
            console.log(`[ROUTER] Exact match result: ${match ? match.url : 'null'}`);
            if (match) {
                return {
                    type: 'marketplace',
                    url: match.url,
                    name: match.name,
                    platform: match.platform,
                    region: match.region
                };
            }
            // Platform found but not for this region
            console.log(`[ROUTER] Platform found but not for region ${region}`);
            return {
                type: 'platform_not_found',
                url: null,
                name: null,
                platform: requestedPlatform,
                region: region
            };
        } else {
            // Has platform but no region - return all platforms of that type
            const matches = marketplaces.filter(m => m.platform === requestedPlatform);
            console.log(`[ROUTER] No region, found ${matches.length} matches for ${requestedPlatform}`);
            if (matches.length === 1) {
                return {
                    type: 'marketplace',
                    url: matches[0].url,
                    name: matches[0].name,
                    platform: matches[0].platform,
                    region: matches[0].region
                };
            }
            // Multiple matches (MY + SG) - need region
            return {
                type: 'need_region',
                url: null,
                name: null,
                platform: requestedPlatform,
                region: null,
                availableRegions: matches.map(m => m.region)
            };
        }
    }

    // No specific platform detected - return official website
    return {
        type: 'official',
        url: official.url || 'https://www.dyna-nutrition.com',
        name: official.name || 'Official Website',
        platform: null,
        region: null
    };
}

/**
 * Main routing function - analyzes message and routes to appropriate handler
 * Now accepts history for better context understanding
 */
async function routeMessage(userMessage, userId, phoneNumber, apiKey, history = []) {
    const ctx = getContext(userId);

    // Analyze intent with LLM (now including history)
    const intent = await analyzeIntent(userMessage, userId, phoneNumber, apiKey, history);

    // Determine default currency from phone if not specified
    if (!intent.currency && phoneNumber) {
        intent.currency = getCurrencyFromPhone(phoneNumber);
    }

    // Handle follow-ups using context + history
    if (intent.intent === 'price') {
        // Try: LLM-detected product > context lastPriceProduct > history
        if (!intent.product) {
            if (ctx && ctx.lastPriceProduct) {
                intent.product = ctx.lastPriceProduct;
                console.log(`[ROUTER] Using context price product: ${intent.product}`);
            } else if (ctx && ctx.lastMentionedProduct) {
                intent.product = ctx.lastMentionedProduct;
                console.log(`[ROUTER] Using context mentioned product: ${intent.product}`);
            } else {
                const historyProduct = findProductInHistory(history);
                if (historyProduct) {
                    intent.product = historyProduct;
                    console.log(`[ROUTER] Using history product: ${intent.product}`);
                }
            }
        }

        // Update contexts
        if (intent.product) {
            updatePriceContext(userId, intent.product, intent.currency);
            updateMentionedProduct(userId, intent.product);
        }

        return {
            handler: 'priceApi',
            params: {
                productName: intent.product,
                currency: intent.currency,
                phoneNumber: phoneNumber
            }
        };
    }

    if (intent.intent === 'store') {
        // Try: LLM-detected product > context pendingStoreProduct > context lastMentionedProduct > history
        if (!intent.product) {
            if (ctx && ctx.pendingStoreProduct) {
                intent.product = ctx.pendingStoreProduct;
                console.log(`[ROUTER] Using context store product: ${intent.product}`);
            } else if (ctx && ctx.lastMentionedProduct) {
                intent.product = ctx.lastMentionedProduct;
                console.log(`[ROUTER] Using context mentioned product for store: ${intent.product}`);
            } else {
                const historyProduct = findProductInHistory(history);
                if (historyProduct) {
                    intent.product = historyProduct;
                    console.log(`[ROUTER] Using history product for store: ${intent.product}`);
                }
            }
        }

        // Update contexts
        if (intent.product) {
            updateStoreContext(userId, intent.product);
            updateMentionedProduct(userId, intent.product);
        }

        return {
            handler: 'storeLocator',
            params: {
                productName: intent.product,
                location: intent.location,
                needsLocation: intent.needsMoreInfo || (!intent.location && intent.product)
            }
        };
    }

    // Marketplace query - extract URL from knowledge base and route to deepseek
    if (intent.intent === 'marketplace') {
        // Load knowledge base
        const { getKnowledge } = require('./knowledgeLoader');
        const kb = getKnowledge();

        // Extract marketplace URL
        const urlInfo = extractMarketplaceUrl(userMessage, phoneNumber, kb);
        console.log(`[ROUTER] Marketplace URL extraction: type=${urlInfo.type}, platform=${urlInfo.platform}, region=${urlInfo.region}`);

        // Track mentioned product for future follow-ups
        const mentionedProduct = extractProductFromText(userMessage) || findProductInHistory(history);
        if (mentionedProduct) {
            updateMentionedProduct(userId, mentionedProduct);
            console.log(`[ROUTER] Marketplace query tracked product: ${mentionedProduct}`);
        }

        // Route to deepseek with extracted URL info
        return {
            handler: 'deepseek',
            params: {
                isMarketplaceQuery: true,
                marketplaceUrl: urlInfo.url,
                marketplaceType: urlInfo.type, // 'official', 'marketplace', 'platform_not_found', 'need_region'
                marketplaceName: urlInfo.name,
                marketplacePlatform: urlInfo.platform,
                marketplaceRegion: urlInfo.region,
                availableRegions: urlInfo.availableRegions
            }
        };
    }

    // General query - track mentioned product for future follow-ups
    const mentionedProduct = extractProductFromText(userMessage) || findProductInHistory(history);
    if (mentionedProduct) {
        updateMentionedProduct(userId, mentionedProduct);
        console.log(`[ROUTER] Tracked mentioned product: ${mentionedProduct}`);
    }

    return {
        handler: 'deepseek',
        params: {}
    };
}

module.exports = {
    analyzeIntent,
    routeMessage,
    getCurrencyFromPhone,
    getRegionFromPhone,
    extractMarketplaceUrl,
    KNOWN_PRODUCTS,
    extractProductFromText,
    buildConversationContext
};