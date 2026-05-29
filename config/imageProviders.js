// config/imageProviders.js
// Image analysis provider configuration and validation

const VALID_PROVIDERS = ['minimax', 'deepseek', 'openai'];

/**
 * Get image provider configuration
 */
function getImageProviderConfig() {
    return {
        // Active provider selection
        provider: process.env.IMAGE_PROVIDER || 'minimax',

        // MiniMax configuration (Primary)
        minimax: {
            apiKey: process.env.MINIMAX_API_KEY,
            groupId: process.env.MINIMAX_GROUP_ID,
            enabled: !!(process.env.MINIMAX_API_KEY && process.env.MINIMAX_GROUP_ID)
        },

        // DeepSeek configuration (Future - vision not yet supported)
        deepseek: {
            apiKey: process.env.DEEPSEEK_API_KEY,
            enabled: !!process.env.DEEPSEEK_API_KEY,
            visionSupported: false, // DeepSeek doesn't support vision yet
            note: 'DeepSeek vision is not yet available. Set IMAGE_PROVIDER=minimax or IMAGE_PROVIDER=openai instead.'
        },

        // OpenAI configuration (Alternative)
        openai: {
            apiKey: process.env.OPENAI_API_KEY,
            model: process.env.OPENAI_VISION_MODEL || 'gpt-4o',
            enabled: !!process.env.OPENAI_API_KEY
        },

        // Global settings
        settings: {
            // Maximum tokens for image analysis response
            maxTokens: parseInt(process.env.IMAGE_MAX_TOKENS) || 500,

            // Enable fallback to alternative provider if primary fails
            enableFallback: process.env.IMAGE_FALLBACK_ENABLED !== 'false',

            // Fallback provider (if primary fails)
            fallbackProvider: process.env.IMAGE_FALLBACK_PROVIDER || 'openai',

            // Timeout for image analysis (ms)
            timeout: parseInt(process.env.IMAGE_TIMEOUT) || 30000,

            // Enable verbose logging
            verboseLogging: process.env.IMAGE_VERBOSE === 'true'
        }
    };
}

/**
 * Validate image provider configuration
 */
function validateImageProviderConfig() {
    const config = getImageProviderConfig();
    const errors = [];
    const warnings = [];

    // Check if provider is valid
    if (!VALID_PROVIDERS.includes(config.provider)) {
        errors.push(
            `Invalid IMAGE_PROVIDER "${config.provider}". ` +
            `Valid options: ${VALID_PROVIDERS.join(', ')}`
        );
    }

    // Check active provider credentials
    const provider = config[config.provider];
    if (!provider) {
        errors.push(`Provider "${config.provider}" not found`);
    } else if (!provider.enabled) {
        const missingCreds = [];
        if (config.provider === 'minimax') {
            if (!config.minimax.apiKey) missingCreds.push('MINIMAX_API_KEY');
            if (!config.minimax.groupId) missingCreds.push('MINIMAX_GROUP_ID');
        } else if (config.provider === 'openai') {
            if (!config.openai.apiKey) missingCreds.push('OPENAI_API_KEY');
        } else if (config.provider === 'deepseek') {
            if (!config.deepseek.apiKey) missingCreds.push('DEEPSEEK_API_KEY');
        }

        if (missingCreds.length > 0) {
            errors.push(`${config.provider.toUpperCase()} requires: ${missingCreds.join(', ')}`);
        }
    }

    // Check for DeepSeek vision warning
    if (config.provider === 'deepseek' && !config.deepseek.visionSupported) {
        warnings.push('DeepSeek Vision is not yet available. Image analysis may fail.');
    }

    // Check fallback configuration
    if (config.settings.enableFallback && config.provider !== config.settings.fallbackProvider) {
        const fallbackProvider = config[config.settings.fallbackProvider];
        if (fallbackProvider && !fallbackProvider.enabled) {
            warnings.push(
                `Fallback provider "${config.settings.fallbackProvider}" is not configured. ` +
                'Fallback will not work if primary provider fails.'
            );
        }
    }

    return {
        isValid: errors.length === 0,
        errors,
        warnings,
        config
    };
}

/**
 * Get prompt template for image analysis
 */
function getImageAnalysisPrompt(type = 'general') {
    const prompts = {
        general: `You are analyzing an image for a health supplement chatbot.

Describe what you see concisely. Identify any:
1. Products (especially health supplements, brand names)
2. Prices (in any currency: RM, SGD, THB, etc.)
3. Text content (messages, screenshots, receipts)
4. E-commerce platforms (Shopee, Lazada, TikTok, etc.)
5. Payment screenshots or transaction details.

Be specific about product names, prices, and relevant details.`,

        product: `Analyze this product image for a health supplement chatbot.

Focus on:
- Product name and brand
- Packaging details
- Any visible text, labels, or claims
- Price if shown
- Any distinguishing features

Provide a concise description that helps identify this product.`,

        payment: `Analyze this payment or transaction screenshot.

Extract and identify:
- Transaction type (payment, receipt, transfer)
- Amount paid (with currency)
- Platform or service used
- Order number or transaction ID
- Date and time
- Any other relevant payment details

Be precise with financial information.`,

        ecommerce: `Analyze this e-commerce screenshot (Shopee, Lazada, TikTok, etc.).

Identify:
- Platform name
- Product shown (name, brand)
- Price displayed
- Seller information
- Ratings or reviews visible
- Any promotional details (discounts, offers)
- Add to cart or buy options

Provide details that help a chatbot understand shopping context.`,

        text: `Extract all visible text from this screenshot or image.

Include:
- All text content
- Source or context (e.g., WhatsApp message, website)
- Any names, numbers, or relevant information
- Language used

Be comprehensive and include all readable text.`
    };

    return prompts[type] || prompts.general;
}

/**
 * Get image type specific prompt
 */
function getPromptForImageType(imageType) {
    const typeMap = {
        product_screenshot: 'ecommerce',
        product_photo: 'product',
        payment_screenshot: 'payment',
        receipt: 'payment',
        text_screenshot: 'text',
        qr_code: 'general',
        unknown: 'general'
    };

    return getImageAnalysisPrompt(typeMap[imageType] || 'general');
}

/**
 * Image type classification labels
 */
const IMAGE_TYPES = {
    product_screenshot: 'E-commerce Product Screenshot',
    product_photo: 'Product Photo',
    payment_screenshot: 'Payment/Transaction Screenshot',
    receipt: 'Receipt',
    text_screenshot: 'Text Screenshot',
    qr_code: 'QR Code',
    unknown: 'Unknown'
};

module.exports = {
    getImageProviderConfig,
    validateImageProviderConfig,
    getImageAnalysisPrompt,
    getPromptForImageType,
    IMAGE_TYPES,
    VALID_PROVIDERS
};