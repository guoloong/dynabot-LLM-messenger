// services/imageProviders/deepseek.js
// DeepSeek Vision API provider for image analysis
// NOTE: DeepSeek currently does NOT support vision/image analysis
// This provider is prepared for when vision support is added

const axios = require('axios');

// DeepSeek API base URL
const API_BASE_URL = 'https://api.deepseek.com';

// Prompt for LLM-based structured JSON extraction (same as other providers)
const STRUCTURED_PROMPT = `You are analyzing an image for a health supplement chatbot.

Analyze the image and return COMPLETE valid JSON only (no markdown, no code blocks, no explanation).
The JSON must follow this exact structure:

{
  "type": "product_screenshot|payment_screenshot|receipt|text_screenshot|qr_code|product_photo|unknown",
  "description": "2-3 sentence clear description of what you see",
  "products": [
    {"name": "product name if visible", "price": "price as shown or N/A", "currency": "RM|SGD|THB|IDR|PHP|VND|N/A"}
  ],
  "platform": "shopee|lazada|tiktok|grabpay|tng|touchngo|carousell|unknown",
  "orderNumber": "ORDER-12345 or N/A",
  "paymentMethod": "bank transfer|grabpay|tng|boost|card|cash or N/A",
  "confidence": 0.0-1.0
}

Rules:
- type: Choose ONE from the list. If payment/receipt = "payment_screenshot", if shopping = "product_screenshot", if chat/text = "text_screenshot"
- products: Array of products seen (empty array if none). For each product, get the name and visible price/currency
- platform: Which e-commerce or payment platform is shown (lowercase)
- orderNumber: Order reference number if visible
- paymentMethod: How payment was/would be made
- confidence: How confident are you in your analysis (0.0-1.0 decimal)

Respond with ONLY the JSON object, nothing else.`;

/**
 * Analyze image using DeepSeek Vision API
 * NOTE: This function will throw error until DeepSeek adds vision support
 *
 * @param {string|Object} imageData - Image URL, base64 string, or MessageMedia object
 * @param {Object} options - Configuration options
 * @param {string} options.apiKey - DeepSeek API key
 * @param {string} options.prompt - Custom prompt for image analysis
 * @param {number} options.maxTokens - Maximum tokens in response
 * @returns {Promise<Object>} Standardized image analysis result
 */
async function analyzeImage(imageData, options = {}) {
    const {
        apiKey = process.env.DEEPSEEK_API_KEY,
        prompt = STRUCTURED_PROMPT,
        maxTokens = 600
    } = options;

    // Check if DeepSeek vision is supported
    if (!checkVisionSupport()) {
        throw new Error(
            'DeepSeek Vision is not yet available. ' +
            'DeepSeek currently does not support image analysis. ' +
            'Please set IMAGE_PROVIDER=minimax or IMAGE_PROVIDER=openai instead.'
        );
    }

    // Validate credentials
    if (!apiKey) {
        throw new Error('DeepSeek API key missing. Set DEEPSEEK_API_KEY in .env');
    }

    // Prepare image content
    const imageContent = await prepareImageContent(imageData);

    // Build request messages
    const messages = [
        {
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageContent } }
            ]
        }
    ];

    // Call DeepSeek API
    const response = await axios.post(`${API_BASE_URL}/chat/completions`, {
        model: 'deepseek-vision', // Will be updated when API is available
        messages,
        max_tokens: maxTokens
    }, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 30000
    });

    const rawContent = response.data?.choices?.[0]?.message?.content || '';

    if (!rawContent) {
        throw new Error('Empty response from DeepSeek Vision API');
    }

    // Parse structured JSON from LLM response
    const parsed = parseStructuredResponse(rawContent);

    // Convert to standardized format with detectedItems array
    const detectedItems = buildDetectedItems(parsed);

    return {
        provider: 'deepseek',
        description: parsed.description || rawContent.trim(),
        type: parsed.type || 'unknown',
        detectedItems,
        confidence: parsed.confidence || 0.5,
        structuredData: {
            products: parsed.products || [],
            platform: parsed.platform,
            orderNumber: parsed.orderNumber,
            paymentMethod: parsed.paymentMethod
        },
        rawResponse: response.data
    };
}

/**
 * Check if DeepSeek supports vision
 * TODO: Update this to return true when DeepSeek adds vision support
 */
function checkVisionSupport() {
    return false;
}

/**
 * Parse JSON from LLM response
 */
function parseStructuredResponse(content) {
    let cleanedContent = content.trim();

    if (cleanedContent.startsWith('```')) {
        cleanedContent = cleanedContent.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
    }

    const jsonStart = cleanedContent.indexOf('{');
    const jsonEnd = cleanedContent.lastIndexOf('}');

    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        const jsonStr = cleanedContent.substring(jsonStart, jsonEnd + 1);
        try {
            const parsed = JSON.parse(jsonStr);
            return validateAndNormalize(parsed);
        } catch (parseError) {
            console.warn('[DEEPSEEK] JSON parse failed:', parseError.message);
            return fallbackParse(cleanedContent);
        }
    }

    return fallbackParse(cleanedContent);
}

/**
 * Validate and normalize parsed data
 */
function validateAndNormalize(data) {
    return {
        type: normalizeType(data.type),
        description: typeof data.description === 'string' ? data.description.trim() : '',
        products: Array.isArray(data.products) ? data.products : [],
        platform: typeof data.platform === 'string' ? data.platform.toLowerCase() : 'unknown',
        orderNumber: data.orderNumber || 'N/A',
        paymentMethod: data.paymentMethod || 'N/A',
        confidence: typeof data.confidence === 'number' ? Math.max(0, Math.min(1, data.confidence)) : 0.5
    };
}

/**
 * Normalize image type
 */
function normalizeType(type) {
    if (!type || typeof type !== 'string') return 'unknown';

    const typeMap = {
        'product_screenshot': 'product_screenshot',
        'product_screenshots': 'product_screenshot',
        'product': 'product_screenshot',
        'ecommerce': 'product_screenshot',
        'payment_screenshot': 'payment_screenshot',
        'payment': 'payment_screenshot',
        'receipt': 'receipt',
        'text_screenshot': 'text_screenshot',
        'text': 'text_screenshot',
        'chat': 'text_screenshot',
        'qr_code': 'qr_code',
        'qr': 'qr_code',
        'product_photo': 'product_photo',
        'photo': 'product_photo'
    };

    const normalized = type.toLowerCase().trim();
    return typeMap[normalized] || 'unknown';
}

/**
 * Fallback parser
 */
function fallbackParse(content) {
    const lowerContent = content.toLowerCase();

    let type = 'unknown';
    if (/payment|transaction|receipt|transfer|bank|paid|invoice|grabpay|tng/.test(lowerContent)) {
        type = 'payment_screenshot';
    } else if (/shopee|lazada|tiktok|product page|add to cart|listing|marketplace/.test(lowerContent)) {
        type = 'product_screenshot';
    } else if (/qr code|qrcode|scan/.test(lowerContent)) {
        type = 'qr_code';
    } else if (/screenshot|whatsapp|chat|message|text/.test(lowerContent)) {
        type = 'text_screenshot';
    }

    return {
        type,
        description: content.trim().substring(0, 500),
        products: [],
        platform: 'unknown',
        orderNumber: 'N/A',
        paymentMethod: 'N/A',
        confidence: 0.3
    };
}

/**
 * Build detectedItems array
 */
function buildDetectedItems(parsed) {
    const items = [];

    if (parsed.products && Array.isArray(parsed.products)) {
        for (const product of parsed.products) {
            if (product.name && product.name !== 'N/A') {
                items.push({
                    type: 'product',
                    value: product.name,
                    price: product.price || 'N/A',
                    currency: product.currency || 'N/A'
                });
            }
        }
    }

    if (parsed.platform && parsed.platform !== 'unknown') {
        items.push({ type: 'platform', value: parsed.platform });
    }

    if (parsed.orderNumber && parsed.orderNumber !== 'N/A') {
        items.push({ type: 'order_number', value: parsed.orderNumber });
    }

    if (parsed.paymentMethod && parsed.paymentMethod !== 'N/A' && parsed.type === 'payment_screenshot') {
        items.push({ type: 'payment_method', value: parsed.paymentMethod });
    }

    return items;
}

/**
 * Prepare image content
 */
async function prepareImageContent(imageData) {
    if (typeof imageData === 'string') {
        if (imageData.startsWith('http')) return imageData;
        if (imageData.startsWith('data:')) return imageData;
        if (/^[A-Za-z0-9+/=]+$/.test(imageData)) {
            return `data:image/jpeg;base64,${imageData}`;
        }
    }

    if (imageData && typeof imageData === 'object' && imageData.data) {
        return `data:${imageData.mimetype || 'image/jpeg'};base64,${imageData.data}`;
    }

    throw new Error(`Unable to process image data format: ${typeof imageData}`);
}

/**
 * Get provider name
 */
function getProviderName() {
    return 'deepseek';
}

/**
 * Check if provider is configured
 */
function isConfigured() {
    return !!process.env.DEEPSEEK_API_KEY;
}

/**
 * Check if vision is supported
 */
function isVisionSupported() {
    return checkVisionSupport();
}

module.exports = {
    analyzeImage,
    getProviderName,
    isConfigured,
    isVisionSupported,
    checkVisionSupport,
    prepareImageContent,
    STRUCTURED_PROMPT
};
