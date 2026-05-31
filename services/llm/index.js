// services/llm/index.js
// LLM Provider Factory
// Manages provider selection, configuration, and access
// Currently supports DeepSeek and MiniMax

const DeepSeekProvider = require('./deepseekProvider');
const MiniMaxProvider = require('./minimaxProvider');

// Singleton instance
let providerInstance = null;

// Default configuration from environment variables
const DEFAULT_CONFIG = {
    provider: process.env.LLM_PROVIDER || 'deepseek',
    deepseek: {
        apiKey: process.env.DEEPSEEK_API_KEY,
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        endpoint: process.env.DEEPSEEK_API_ENDPOINT || 'https://api.deepseek.com/v1/chat/completions'
    },
    minimax: {
        apiKey: process.env.MINIMAX_API_KEY,
        model: process.env.MINIMAX_MODEL || 'MiniMax-M2.7',
        endpoint: 'https://api.minimax.io/v1/chat/completions',
        groupId: process.env.MINIMAX_GROUP_ID
    },
    openai: {
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        endpoint: 'https://api.openai.com/v1/chat/completions'
    },
    anthropic: {
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
        endpoint: 'https://api.anthropic.com/v1/messages'
    }
};

/**
 * Get the active LLM provider instance
 * Uses singleton pattern to reuse the same provider
 * @returns {BaseLLMProvider} Active provider instance
 */
function getLLMProvider() {
    if (providerInstance) {
        return providerInstance;
    }

    const providerName = process.env.LLM_PROVIDER || DEFAULT_CONFIG.provider;

    console.log(`[LLM_FACTORY] Initializing provider: ${providerName}`);

    switch (providerName) {
        case 'deepseek':
            providerInstance = new DeepSeekProvider({
                apiKey: process.env.DEEPSEEK_API_KEY
            });
            break;

        case 'minimax':
            providerInstance = new MiniMaxProvider({
                apiKey: process.env.MINIMAX_API_KEY,
                groupId: process.env.MINIMAX_GROUP_ID
            });
            break;

        // Future providers can be added here:
        // case 'openai':
        //     providerInstance = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY });
        //     break;
        // case 'anthropic':
        //     providerInstance = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY });
        //     break;

        default:
            console.warn(`[LLM_FACTORY] Unknown provider "${providerName}", falling back to DeepSeek`);
            providerInstance = new DeepSeekProvider({
                apiKey: process.env.DEEPSEEK_API_KEY
            });
    }

    console.log(`[LLM_FACTORY] Provider initialized: ${providerInstance.getName()}`);
    return providerInstance;
}

/**
 * Reset the provider instance (for testing or switching)
 * Forces re-initialization on next getLLMProvider() call
 */
function resetProvider() {
    if (providerInstance) {
        console.log('[LLM_FACTORY] Resetting provider instance');
    }
    providerInstance = null;
}

/**
 * Check if the current provider is configured
 * @returns {boolean} True if provider has valid API key
 */
function isConfigured() {
    const providerName = process.env.LLM_PROVIDER || 'deepseek';

    switch (providerName) {
        case 'deepseek':
            return !!process.env.DEEPSEEK_API_KEY;
        case 'minimax':
            return !!process.env.MINIMAX_API_KEY;
        case 'openai':
            return !!process.env.OPENAI_API_KEY;
        case 'anthropic':
            return !!process.env.ANTHROPIC_API_KEY;
        default:
            return !!process.env.DEEPSEEK_API_KEY;
    }
}

/**
 * Get current provider name
 * @returns {string} Provider name
 */
function getProviderName() {
    return process.env.LLM_PROVIDER || 'deepseek';
}

/**
 * Get configuration for a specific provider
 * @param {string} providerName - Name of the provider
 * @returns {Object} Provider configuration
 */
function getProviderConfig(providerName) {
    return DEFAULT_CONFIG[providerName] || null;
}

/**
 * Get all available providers configuration
 * @returns {Object} All providers config
 */
function getAllProvidersConfig() {
    return { ...DEFAULT_CONFIG };
}

/**
 * Validate the current configuration
 * @returns {Object} Validation result with errors and warnings
 */
function validateConfiguration() {
    const providerName = process.env.LLM_PROVIDER || 'deepseek';
    const result = {
        isValid: true,
        errors: [],
        warnings: [],
        provider: providerName
    };

    const config = getProviderConfig(providerName);

    if (!config) {
        result.isValid = false;
        result.errors.push(`Unknown provider: ${providerName}`);
        return result;
    }

    // Check required credentials
    if (!config.apiKey) {
        const credEnvVar = `${providerName.toUpperCase()}_API_KEY`;
        result.isValid = false;
        result.errors.push(`${credEnvVar} is not configured`);
    }

    // Check model
    if (!config.model && providerName === 'deepseek') {
        result.warnings.push('DEEPSEEK_MODEL not set, using default: deepseek-chat');
    }

    return result;
}

/**
 * Get status information about the LLM system
 * @returns {Object} Status object
 */
function getStatus() {
    const validation = validateConfiguration();

    return {
        provider: getProviderName(),
        configured: isConfigured(),
        isValid: validation.isValid,
        errors: validation.errors,
        warnings: validation.warnings
    };
}

// Chat shorthand using the active provider
/**
 * Send a chat request to the active LLM
 * @param {Array} messages - Message array
 * @param {Object} options - Request options
 * @returns {Promise<string>} Response content
 */
async function chat(messages, options = {}) {
    const provider = getLLMProvider();
    return provider.chat(messages, options);
}

/**
 * Extract keywords from text
 * @param {string} text - Input text
 * @returns {Promise<string>} Keywords
 */
async function extractKeywords(text) {
    const provider = getLLMProvider();
    return provider.extractKeywords(text);
}

/**
 * Search the internet
 * @param {string} query - Search query
 * @returns {Promise<string|null>} Search results
 */
async function searchInternet(query) {
    const provider = getLLMProvider();
    return provider.searchInternet(query);
}

/**
 * Analyze intent from message
 * @param {string} userMessage - User message
 * @param {Object} context - Additional context
 * @returns {Promise<Object>} Intent result
 */
async function analyzeIntent(userMessage, context = {}) {
    const provider = getLLMProvider();
    return provider.analyzeIntent(userMessage, context);
}

module.exports = {
    // Factory functions
    getLLMProvider,
    resetProvider,

    // Configuration
    isConfigured,
    getProviderName,
    getProviderConfig,
    getAllProvidersConfig,
    validateConfiguration,
    getStatus,

    // Shorthand functions
    chat,
    extractKeywords,
    searchInternet,
    analyzeIntent,

    // Direct provider access (advanced usage)
    DeepSeekProvider
};