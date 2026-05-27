// bot/quickReplyButtons.js
// Dynamic quick reply buttons with language-aware translations
// Uses LLM for language detection - no hardcoded patterns

const { translateWithHistory } = require('../utils/translateWithHistory');
const axios = require('axios');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// Button templates in English (short for Messenger 13-char limit)
const BUTTON_TEMPLATES = {
    price: 'May I know the price?',
    buyOnline: 'I want to buy online.',
    retailStore: 'I want to buy from a retail store.'
};

// Short button titles (≤13 chars for Messenger)
const SHORT_BUTTON_TITLES = {
    price: 'Price',
    buyOnline: 'Buy Online',
    retailStore: 'Retail Store'
};

// Original button templates for click handling (translate back to English-like)
const CLICK_TEMPLATES = {
    price: 'price',
    buyOnline: 'buy online',
    retailStore: 'buy from a retail store'
};

/**
 * Detect user's language using LLM
 * More accurate than regex, supports any language
 */
async function detectLanguageWithLLM(userMessage, apiKey) {
    if (!apiKey || !userMessage) {
        return 'en';
    }

    try {
        const prompt = `Detect the language of this message. Return ONLY a 2-letter ISO 639-1 language code (e.g., "en", "zh", "ms", "id", "th", "vi", "ja", "ko").

Message: "${userMessage.substring(0, 100)}"

Return ONLY the language code, nothing else.`;

        const response = await axios.post(
            DEEPSEEK_API_URL,
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are a language detection assistant. Return ONLY a 2-letter ISO 639-1 language code.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0,
                max_tokens: 10
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                timeout: 10000
            }
        );

        const langCode = response.data.choices[0].message.content.trim().toLowerCase().substring(0, 2);
        console.log(`[QUICK_REPLY] LLM detected language: ${langCode}`);
        return langCode;

    } catch (err) {
        console.error('[QUICK_REPLY] Language detection failed:', err.message);
        return 'en';
    }
}

/**
 * Get quick action messages in user's detected language
 * Uses LLM for both detection and translation
 */
async function getQuickActions(userMessage, apiKey) {
    try {
        // Detect language with LLM
        const lang = await detectLanguageWithLLM(userMessage, apiKey);

        // If English, no translation needed
        if (lang === 'en') {
            return {
                price: BUTTON_TEMPLATES.price,
                buyOnline: BUTTON_TEMPLATES.buyOnline,
                retailStore: BUTTON_TEMPLATES.retailStore,
                detectedLang: 'en'
            };
        }

        // Translate each button text to user's language using LLM
        const [price, buyOnline, retailStore] = await Promise.all([
            translateWithHistory(BUTTON_TEMPLATES.price, userMessage, [], apiKey),
            translateWithHistory(BUTTON_TEMPLATES.buyOnline, userMessage, [], apiKey),
            translateWithHistory(BUTTON_TEMPLATES.retailStore, userMessage, [], apiKey)
        ]);

        return {
            price,
            buyOnline,
            retailStore,
            detectedLang: lang
        };

    } catch (err) {
        console.error('[QUICK_REPLY] Translation failed, falling back to English:', err.message);
        return {
            price: BUTTON_TEMPLATES.price,
            buyOnline: BUTTON_TEMPLATES.buyOnline,
            retailStore: BUTTON_TEMPLATES.retailStore,
            detectedLang: 'en'
        };
    }
}

/**
 * Get translated quick reply prompt for Messenger
 * Returns a single translated message prompting user to use the buttons
 * @param {string} userMessage - User's message for language detection
 * @param {string} apiKey - DeepSeek API key
 * @param {string} productName - Product name to include (optional)
 */
async function getQuickReplyPrompt(userMessage, apiKey, productName = null) {
    try {
        // Detect language
        const lang = await detectLanguageWithLLM(userMessage, apiKey);

        // Build English template
        let template;
        if (productName) {
            const productDisplay = formatProductDisplayName(productName);
            template = `Quick action for ${productDisplay}. Click the buttons below for price, buy online, or find a retail store.`;
        } else {
            template = 'Quick action - click below for price, buy online, or find a retail store.';
        }

        // Translate if not English
        if (lang !== 'en') {
            const translated = await translateWithHistory(template, userMessage, [], apiKey);
            console.log(`[QUICK_REPLY] Prompt translated: "${template}" → "${translated}"`);
            return translated;
        }

        return template;

    } catch (err) {
        console.error('[QUICK_REPLY] Failed to get prompt:', err.message);
        return 'Quick action: click below for price, buy online, or find a retail store.';
    }
}

/**
 * Get quick action messages formatted as text (for WhatsApp)
 * @param {string} userMessage - User's message for language detection
 * @param {string} apiKey - DeepSeek API key
 * @param {string} productName - Product name to include in header (optional, keep English)
 */
async function getQuickActionsText(userMessage, apiKey, productName = null) {
    const actions = await getQuickActions(userMessage, apiKey);

    // Create product display name (keep as-is, English only)
    const productDisplay = productName
        ? productName.charAt(0).toUpperCase() + productName.slice(1).replace(/-/g, ' ')
        : null;

    // Translate frame text using LLM
    // Translate "Quick Actions for" as a whole phrase, then append product name (keep English)
    let headerPrefix = 'Quick Actions for';
    let replyText = 'Reply with number (1, 2, or 3)';

    if (actions.detectedLang !== 'en') {
        try {
            [headerPrefix, replyText] = await Promise.all([
                translateWithHistory('Quick Actions for', userMessage, [], apiKey),
                translateWithHistory('Reply with number (1, 2, or 3)', userMessage, [], apiKey)
            ]);
        } catch (err) {
            console.error('[QUICK_REPLY] Frame translation failed:', err.message);
        }
    }

    // Build button texts with product name
    const buyOnlineText = productDisplay
        ? `${actions.buyOnline.replace(/online\./i, '')} ${productDisplay} online.`.replace(/\s+/g, ' ')
        : actions.buyOnline;

    const retailStoreText = productDisplay
        ? `I want to buy ${productDisplay} from a retail store.`
        : actions.retailStore;

    // Translate button texts with product name
    let translatedBuyOnline = buyOnlineText;
    let translatedRetailStore = retailStoreText;

    if (actions.detectedLang !== 'en') {
        try {
            [translatedBuyOnline, translatedRetailStore] = await Promise.all([
                translateWithHistory(buyOnlineText, userMessage, [], apiKey),
                translateWithHistory(retailStoreText, userMessage, [], apiKey)
            ]);
        } catch (err) {
            console.error('[QUICK_REPLY] Button translation failed:', err.message);
            translatedBuyOnline = buyOnlineText;
            translatedRetailStore = retailStoreText;
        }
    }

    return {
        text: `
━━━━━━━━━━━━━━━━━━━━━━
📋 ${productDisplay ? `${headerPrefix} ${productDisplay}` : headerPrefix}

1️⃣ 💰 ${actions.price}
2️⃣ 🛒 ${translatedBuyOnline}
3️⃣ 🏪 ${translatedRetailStore}

*${replyText}*
━━━━━━━━━━━━━━━━━━━━━━
`,
        detectedLang: actions.detectedLang,
        actions: actions,
        productName: productDisplay
    };
}

/**
 * Get quick action messages as quick reply format (for Messenger)
 * Returns array of { title, payload } objects with SHORT translated titles (≤13 chars)
 */
async function getQuickReplyButtons(userMessage, apiKey) {
    // Detect language once
    const lang = await detectLanguageWithLLM(userMessage, apiKey);

    // Short English labels for translation (max 13 chars)
    const shortLabels = {
        price: 'Price',
        buyOnline: 'Buy Online',
        retailStore: 'Retail'
    };

    // If not English, translate each label
    if (lang !== 'en' && apiKey) {
        try {
            const [priceLabel, buyOnlineLabel, retailLabel] = await Promise.all([
                translateWithHistory(shortLabels.price, userMessage, [], apiKey),
                translateWithHistory(shortLabels.buyOnline, userMessage, [], apiKey),
                translateWithHistory(shortLabels.retailStore, userMessage, [], apiKey)
            ]);

            return [
                {
                    content_type: 'text',
                    title: `💰 ${priceLabel.substring(0, 11)}`,
                    payload: 'BTN_PRICE'
                },
                {
                    content_type: 'text',
                    title: `🛒 ${buyOnlineLabel.substring(0, 8)}`,
                    payload: 'BTN_BUY_ONLINE'
                },
                {
                    content_type: 'text',
                    title: `🏪 ${retailLabel.substring(0, 9)}`,
                    payload: 'BTN_RETAIL'
                }
            ];
        } catch (err) {
            console.error('[QUICK_REPLY] Button translation failed:', err.message);
        }
    }

    // Fallback to English
    return [
        {
            content_type: 'text',
            title: '💰 Price',
            payload: 'BTN_PRICE'
        },
        {
            content_type: 'text',
            title: '🛒 Buy Online',
            payload: 'BTN_BUY_ONLINE'
        },
        {
            content_type: 'text',
            title: '🏪 Retail',
            payload: 'BTN_RETAIL'
        }
    ];
}

/**
 * Check if a message is a quick action response (1, 2, or 3)
 * Note: For Messenger, button clicks send the payload, not text
 * For WhatsApp, users type 1, 2, or 3
 */
function isQuickActionResponse(message) {
    if (!message) return null;

    const text = message.trim().toLowerCase();

    // Number response (for WhatsApp text menu)
    if (text === '1') return 'price';
    if (text === '2') return 'buyOnline';
    if (text === '3') return 'retailStore';

    return null;
}

/**
 * Check if payload is from a quick reply button click (Messenger)
 */
function isQuickReplyPayload(payload) {
    if (!payload) return null;

    if (payload === 'BTN_PRICE') return 'price';
    if (payload === 'BTN_BUY_ONLINE') return 'buyOnline';
    if (payload === 'BTN_RETAIL') return 'retailStore';

    return null;
}

/**
 * Format product name for display (capitalize, replace hyphens with spaces)
 * @param {string} productName - Product slug (e.g., "bionatto")
 * @returns {string} Formatted name (e.g., "BioNatto Plus")
 */
function formatProductDisplayName(productName) {
    if (!productName) return null;
    return productName.charAt(0).toUpperCase() + productName.slice(1).replace(/-/g, ' ');
}

module.exports = {
    BUTTON_TEMPLATES,
    CLICK_TEMPLATES,
    detectLanguageWithLLM,
    getQuickActions,
    getQuickReplyPrompt,
    getQuickActionsText,
    getQuickReplyButtons,
    isQuickActionResponse,
    isQuickReplyPayload,
    formatProductDisplayName
};