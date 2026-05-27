// bot/quickReplyButtons.js
// Dynamic quick reply buttons with language-aware translations
// Uses LLM for language detection - no hardcoded patterns

const { translateWithHistory } = require('../utils/translateWithHistory');
const axios = require('axios');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// Button templates in English
const BUTTON_TEMPLATES = {
    price: 'May I know the price?',
    buyOnline: 'I want to buy online.',
    retailStore: 'I want to buy from a retail store.'
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
 * Get quick action messages formatted as text (for WhatsApp)
 * @param {string} userMessage - User's message for language detection
 * @param {string} apiKey - DeepSeek API key
 * @param {string} productName - Product name to include in header (optional)
 */
async function getQuickActionsText(userMessage, apiKey, productName = null) {
    const actions = await getQuickActions(userMessage, apiKey);

    // Create product display name (capitalize first letter)
    const productDisplay = productName
        ? productName.charAt(0).toUpperCase() + productName.slice(1).replace(/-/g, ' ')
        : null;

    return {
        text: `
━━━━━━━━━━━━━━━━━━━━━━
📋 Quick Actions${productDisplay ? ` for ${productDisplay}` : ''}

1️⃣ 💰 ${actions.price}
2️⃣ 🛒 ${productDisplay ? actions.buyOnline.replace(/online\./i, `${productDisplay} online.`) : actions.buyOnline}
3️⃣ 🏪 ${productDisplay ? actions.retailStore.replace(/a retail store\./i, `${productDisplay} from a retail store.`) : actions.retailStore}

*Reply with number (1, 2, or 3)*
━━━━━━━━━━━━━━━━━━━━━━
`,
        detectedLang: actions.detectedLang,
        actions: actions,
        productName: productDisplay
    };
}

/**
 * Get quick action messages as quick reply format (for Messenger)
 * Returns array of { title, payload } objects
 */
async function getQuickReplyButtons(userMessage, apiKey) {
    const actions = await getQuickActions(userMessage, apiKey);

    return [
        {
            content_type: 'text',
            title: `💰 ${actions.price}`,
            payload: `BTN_PRICE_${actions.detectedLang}`
        },
        {
            content_type: 'text',
            title: `🛒 ${actions.buyOnline}`,
            payload: `BTN_BUY_ONLINE_${actions.detectedLang}`
        },
        {
            content_type: 'text',
            title: `🏪 ${actions.retailStore}`,
            payload: `BTN_RETAIL_STORE_${actions.detectedLang}`
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

    if (payload.startsWith('BTN_PRICE_')) return 'price';
    if (payload.startsWith('BTN_BUY_ONLINE_')) return 'buyOnline';
    if (payload.startsWith('BTN_RETAIL_STORE_')) return 'retailStore';

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
    detectLanguageWithLLM,
    getQuickActions,
    getQuickActionsText,
    getQuickReplyButtons,
    isQuickActionResponse,
    isQuickReplyPayload,
    formatProductDisplayName
};