// services/imageAnalyzer.js
// Provider-agnostic image analysis module
// Main entry point for analyzing images received from users

const { getActiveProvider, validateConfiguration } = require('./imageProviders');

// Default analysis prompt for health supplement chatbot
const DEFAULT_PROMPT = `You are analyzing an image for a health supplement chatbot.

Describe what you see concisely and clearly. Identify and extract:

1. PRODUCTS:
   - Any health supplements, vitamins, or wellness products
   - Brand names, product names (e.g., BioNatto, Riflex 360, Tricollagen)
   - Product packaging details

2. PRICES:
   - Any prices shown (in any currency: RM, SGD, THB, IDR, PHP, VND)
   - Discounts or special offers
   - Price per unit or total price

3. E-COMMERCE INFORMATION:
   - Platform name (Shopee, Lazada, TikTok, etc.)
   - Product listings or shopping screenshots
   - Add to cart, buy buttons
   - Seller ratings or reviews

4. PAYMENT/TRANSACTION DETAILS:
   - Payment confirmations or receipts
   - Bank transfers, e-wallets (GrabPay, Touch 'n Go, etc.)
   - Order numbers or transaction IDs

5. TEXT/SCREENSHOTS:
   - Any text content or messages
   - Screenshots of conversations
   - QR codes

6. OTHER RELEVANT DETAILS:
   - Product quantities
   - Shipping information
   - Store or location information

Provide a concise description that helps the chatbot understand the image context. Focus on details that are relevant to a health supplement business.`;

/**
 * Analyze an image and return structured description
 *
 * @param {string|Object} imageData - Image data (URL, base64, or MessageMedia)
 * @param {Object} options - Analysis options
 * @param {string} options.prompt - Custom prompt for analysis
 * @param {number} options.maxTokens - Max tokens for response
 * @returns {Promise<Object>} Standardized image analysis result
 */
async function analyzeImage(imageData, options = {}) {
    const {
        prompt = DEFAULT_PROMPT,
        maxTokens = 500,
        fallbackToText = true,
        verbose = false
    } = options;

    // Validate configuration
    const validation = validateConfiguration();
    if (!validation.isValid && options.apiKey) {
        console.warn('[IMAGE_ANALYZER] Invalid configuration, but using provided API key');
    } else if (!validation.isValid) {
        throw new Error(
            `Image analyzer not configured: ${validation.errors.join('; ')}. ` +
            `Please set required environment variables.`
        );
    }

    // Log start
    if (verbose) {
        console.log('[IMAGE_ANALYZER] Starting analysis...');
        console.log('[IMAGE_ANALYZER] Provider:', process.env.IMAGE_PROVIDER || 'minimax');
    }

    // Get active provider
    let provider;
    try {
        provider = getActiveProvider();
        if (verbose) console.log('[IMAGE_ANALYZER] Using provider:', provider.getProviderName?.() || 'unknown');
    } catch (err) {
        console.error('[IMAGE_ANALYZER] Failed to get provider:', err.message);
        throw err;
    }

    // Call provider's analyze function
    let result;
    try {
        result = await provider.analyzeImage(imageData, {
            prompt,
            maxTokens
        });
    } catch (err) {
        console.error('[IMAGE_ANALYZER] Provider error:', err.message);

        // Try fallback if enabled
        if (fallbackToText && process.env.IMAGE_FALLBACK_PROVIDER) {
            console.log('[IMAGE_ANALYZER] Attempting fallback to alternative provider...');
            try {
                const fallback = getActiveProvider();
                if (fallback.getProviderName !== provider.getProviderName) {
                    result = await fallback.analyzeImage(imageData, { prompt, maxTokens });
                    result.fallbackProvider = result.provider;
                    result.provider = `fallback:${result.provider}`;
                    console.log('[IMAGE_ANALYZER] Fallback successful');
                }
            } catch (fallbackErr) {
                console.error('[IMAGE_ANALYZER] Fallback also failed:', fallbackErr.message);
                throw err; // Throw original error
            }
        } else {
            throw err;
        }
    }

    // Validate result structure
    if (!result || !result.description) {
        throw new Error('Invalid result from image provider: missing description');
    }

    // DEBUG: Log the complete analysis result
    if (verbose) {
        console.log('\n========================================');
        console.log('[IMAGE_ANALYZER] ANALYSIS RESULT:');
        console.log('========================================');
        console.log('Provider:', result.provider);
        console.log('Description:', result.description);
        console.log('========================================\n');
    }

    // Add metadata
    result.timestamp = Date.now();
    result.provider = result.provider || provider.getProviderName?.() || 'unknown';

    if (verbose) {
        console.log('[IMAGE_ANALYZER] Analysis complete');
        console.log('[IMAGE_ANALYZER] Type:', result.type);
        console.log('[IMAGE_ANALYZER] Items found:', result.detectedItems?.length || 0);
    }

    return result;
}

/**
 * Analyze multiple images
 *
 * @param {Array} images - Array of image data
 * @param {Object} options - Analysis options
 * @returns {Promise<Array>} Array of analysis results
 */
async function analyzeMultipleImages(images, options = {}) {
    if (!Array.isArray(images) || images.length === 0) {
        throw new Error('images must be a non-empty array');
    }

    const results = await Promise.all(
        images.map((img, index) =>
            analyzeImage(img, options).catch(err => ({
                error: true,
                message: err.message,
                index
            }))
        )
    );

    return results;
}

/**
 * Quick analyze - shorthand for simple image description
 *
 * @param {string|Object} imageData - Image data
 * @returns {Promise<string>} Simple description string
 */
async function quickAnalyze(imageData) {
    const result = await analyzeImage(imageData, {
        maxTokens: 300
    });
    return result.description;
}

/**
 * Get image type classification
 *
 * @param {string|Object} imageData - Image data
 * @returns {Promise<string>} Image type
 */
async function classifyImage(imageData) {
    const result = await analyzeImage(imageData, {
        maxTokens: 100,
        prompt: 'Classify this image into one of these categories: ' +
                'product_screenshot, payment_screenshot, receipt, text_screenshot, ' +
                'qr_code, product_photo, or unknown. Reply with just the category.'
    });

    return result.type || 'unknown';
}

/**
 * Extract structured information from image
 *
 * @param {string|Object} imageData - Image data
 * @param {Object} options - Extraction options
 * @returns {Promise<Object>} Structured extraction result
 */
async function extractInfo(imageData, options = {}) {
    const {
        extractProducts = true,
        extractPrices = true,
        extractPlatforms = true
    } = options;

    const result = await analyzeImage(imageData, {
        maxTokens: 400
    });

    return {
        description: result.description,
        type: result.type,
        confidence: result.confidence,
        extracted: {
            products: extractProducts ? result.detectedItems?.filter(i => i.type === 'product') || [] : [],
            prices: extractPrices ? result.detectedItems?.filter(i => i.type === 'price') || [] : [],
            platforms: extractPlatforms ? result.detectedItems?.filter(i => i.type === 'platform') || [] : [],
            orderNumbers: result.detectedItems?.filter(i => i.type === 'order_number') || []
        }
    };
}

/**
 * Build context string for LLM integration
 * Simple prefix that tells LLM user sent a photo with description
 *
 * @param {Object} analysisResult - Result from analyzeImage
 * @returns {string} Context string to prepend to user message
 */
function buildLLMContext(analysisResult) {
    if (!analysisResult || !analysisResult.description) return '';

    // Simple format - just the description, LLM will understand
    return `\n[User sent a photo]\nImage description: ${analysisResult.description}\n`;
}

/**
 * Check if image analyzer is ready
 * @returns {Object} Status object
 */
function getStatus() {
    const validation = validateConfiguration();
    const activeProvider = process.env.IMAGE_PROVIDER || 'minimax';

    return {
        ready: validation.isValid,
        activeProvider,
        configuredProviders: Object.keys(validation.providers).filter(
            name => validation.providers[name].isConfigured
        ),
        errors: validation.errors,
        warnings: validation.warnings
    };
}

module.exports = {
    analyzeImage,
    analyzeMultipleImages,
    quickAnalyze,
    classifyImage,
    extractInfo,
    buildLLMContext,
    getStatus,
    DEFAULT_PROMPT
};