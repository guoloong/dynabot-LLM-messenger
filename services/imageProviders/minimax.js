// services/imageProviders/minimax.js
// MiniMax Vision API provider for image analysis
// Fixed: Using correct VLM endpoint /v1/coding_plan/vlm with automatic failover

const axios = require('axios');

// MiniMax VLM endpoint
const VLM_ENDPOINT = '/v1/coding_plan/vlm';

// Base URLs to try
const BASE_URLS = [
    'https://api.minimax.io',
    'https://api.minimaxi.com'
];

// Prompt for concise text description (no JSON needed - LLM will handle it)
const STRUCTURED_PROMPT = `Describe this image briefly for a health supplement chatbot.
Focus on: product names, prices/currency, brand names, platform if e-commerce, order numbers, payment methods, key text content.
Keep description under 300 words. Be concise and factual.`;

/**
 * Analyze image using MiniMax Vision API (VLM endpoint)
 * Automatically tries both base URLs to handle different key types
 *
 * @param {string|Object} imageData - Image URL, base64 string, or MessageMedia object
 * @param {Object} options - Configuration options
 * @param {string} options.apiKey - MiniMax API key
 * @param {string} options.groupId - MiniMax Group ID
 * @param {string} options.prompt - Custom prompt for image analysis
 * @returns {Promise<Object>} Standardized image analysis result
 */
async function analyzeImage(imageData, options = {}) {
    const {
        apiKey = process.env.MINIMAX_API_KEY,
        groupId = process.env.MINIMAX_GROUP_ID,
        prompt = STRUCTURED_PROMPT
    } = options;

    // Validate credentials
    if (!apiKey) {
        throw new Error('MiniMax API key missing. Set MINIMAX_API_KEY in .env');
    }

    // Prepare image content (data URI format)
    const imageContent = await prepareImageContent(imageData);

    // Request payload for MiniMax VLM endpoint
    const payload = {
        prompt: prompt,
        image_url: imageContent
    };

    // Headers
    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    };

    // Add GroupId header if provided
    if (groupId) {
        headers['GroupId'] = groupId;
    }

    let response;
    let success = false;

    // Try each base URL
    for (const baseUrl of BASE_URLS) {
        const endpoint = `${baseUrl}${VLM_ENDPOINT}`;
        console.log(`[MINIMAX] Trying endpoint: ${endpoint}`);

        try {
            response = await axios.post(endpoint, payload, {
                headers,
                timeout: 30000
            });

            // Check if we got a valid response
            const rawContent = response.data?.content;
            const statusCode = response.data?.base_resp?.status_code;

            if (rawContent && statusCode === 0) {
                console.log(`[MINIMAX] Success with: ${endpoint}`);
                success = true;
                break;
            } else if (statusCode !== 0) {
                const statusMsg = response.data?.base_resp?.status_msg || 'Unknown error';
                console.log(`[MINIMAX] ${endpoint} returned error: ${statusCode} - ${statusMsg}`);
                // If invalid API key, don't try other URLs
                if (statusCode === 1001 || statusMsg.includes('invalid') || statusMsg.includes('Invalid')) {
                    throw new Error(`MiniMax VLM API error: ${statusMsg}`);
                }
            }
        } catch (error) {
            const errorMsg = error.response?.data?.base_resp?.status_msg || error.message;
            console.log(`[MINIMAX] ${endpoint} failed: ${errorMsg}`);

            // If invalid API key, don't try other URLs
            if (errorMsg.includes('invalid') || errorMsg.includes('Invalid') || error.response?.status === 401) {
                throw new Error(`MiniMax VLM API error: ${errorMsg}`);
            }

            // For other errors (network, etc.), continue to next URL
            continue;
        }
    }

    if (!success || !response) {
        throw new Error('MiniMax VLM API error: All endpoints failed');
    }

    // Parse response
    // MiniMax VLM response format: { "content": "...", "base_resp": { "status_code": 0, "status_msg": "success" } }
    const rawContent = response.data?.content || '';

    // DEBUG: Show raw MiniMax output
    console.log('\n========================================');
    console.log('[MINIMAX] RAW API RESPONSE:');
    console.log('========================================');
    console.log(rawContent);
    console.log('========================================\n');

    if (!rawContent) {
        throw new Error('Empty response from MiniMax VLM API');
    }

    console.log(`[MINIMAX] Received response, parsing...`);

    // Return raw description - let LLM handle parsing/understanding
    return {
        provider: 'minimax',
        description: rawContent.trim(),
        rawResponse: response.data
    };
}

/**
 * Parse JSON from LLM response (fallback only - returns raw text now)
 */
function parseStructuredResponse(content) {
    let cleanedContent = content.trim();
    // Try to find JSON object in the content
    const jsonStart = cleanedContent.indexOf('{');
    const jsonEnd = cleanedContent.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        const jsonStr = cleanedContent.substring(jsonStart, jsonEnd + 1);
        try {
            const parsed = JSON.parse(jsonStr);
            return { description: parsed.description || cleanedContent };
        } catch (parseError) {
            // Not JSON, use raw content
            return { description: cleanedContent };
        }
    }
    return { description: cleanedContent };
}

/**
 * Prepare image content for API call (must be data URI format)
 */
async function prepareImageContent(imageData) {
    // Already a data URI - return as-is
    if (typeof imageData === 'string' && imageData.startsWith('data:')) {
        return imageData;
    }

    // HTTPS URL
    if (typeof imageData === 'string' && (imageData.startsWith('https://') || imageData.startsWith('http://'))) {
        return imageData;
    }

    // WhatsApp MessageMedia object
    if (imageData && typeof imageData === 'object' && imageData.data) {
        return `data:${imageData.mimetype || 'image/jpeg'};base64,${imageData.data}`;
    }

    // Plain base64 string (add data URI prefix)
    if (typeof imageData === 'string' && !imageData.startsWith('data:') && /^[A-Za-z0-9+/=]+$/.test(imageData)) {
        return `data:image/jpeg;base64,${imageData}`;
    }

    throw new Error(`Unable to process image data format: ${typeof imageData}`);
}

/**
 * Get provider name
 */
function getProviderName() {
    return 'minimax';
}

/**
 * Check if provider is configured
 */
function isConfigured() {
    return !!process.env.MINIMAX_API_KEY;
}

module.exports = {
    analyzeImage,
    getProviderName,
    isConfigured,
    prepareImageContent,
    VLM_ENDPOINT,
    BASE_URLS,
    STRUCTURED_PROMPT
};
