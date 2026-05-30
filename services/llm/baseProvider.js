// services/llm/baseProvider.js
// Abstract base class for LLM providers
// Defines the interface that all LLM providers must implement

/**
 * Base class for LLM providers
 * All provider implementations should extend this class
 */
class BaseLLMProvider {
    /**
     * @param {Object} config - Provider configuration
     * @param {string} config.name - Provider name (e.g., 'deepseek', 'openai')
     * @param {string} config.endpoint - API endpoint URL
     * @param {string} config.model - Default model name
     * @param {string} config.apiKey - API key for authentication
     */
    constructor(config) {
        this.config = config;
        this.name = config.name || 'unknown';
        this.endpoint = config.endpoint || '';
        this.model = config.model || '';
        this.apiKey = config.apiKey || '';
    }

    /**
     * Get the provider name
     * @returns {string} Provider name
     */
    getName() {
        return this.name;
    }

    /**
     * Check if the provider is configured
     * @returns {boolean} True if API key is set
     */
    isConfigured() {
        return !!this.apiKey;
    }

    /**
     * Build headers for API requests
     * Override in subclass if provider has different auth requirements
     * @returns {Object} Headers object
     */
    buildHeaders() {
        return {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Build request payload for chat completions
     * Override in subclass if provider has different payload format
     * @param {Array} messages - Message array
     * @param {Object} options - Request options
     * @returns {Object} Request payload
     */
    buildChatPayload(messages, options = {}) {
        return {
            model: this.model,
            messages,
            temperature: options.temperature ?? 0.2,
            max_tokens: options.max_tokens ?? 500
        };
    }

    /**
     * Extract content from response
     * Override in subclass if provider has different response format
     * @param {Object} response - Raw API response
     * @returns {string} Extracted content
     */
    extractContent(response) {
        return response.data?.choices?.[0]?.message?.content || '';
    }

    /**
     * Send a chat completion request
     * @param {Array} messages - Array of message objects with role and content
     * @param {Object} options - Request options
     * @param {number} options.temperature - Sampling temperature (default: 0.2)
     * @param {number} options.max_tokens - Maximum tokens (default: 500)
     * @param {number} options.timeout - Request timeout in ms (default: 20000)
     * @returns {Promise<string>} Response content
     */
    async chat(messages, options = {}) {
        throw new Error('chat() must be implemented by subclass');
    }

    /**
     * Extract keywords from text using LLM
     * @param {string} text - Input text
     * @returns {Promise<string>} Keywords separated by spaces
     */
    async extractKeywords(text) {
        throw new Error('extractKeywords() must be implemented by subclass');
    }

    /**
     * Search the internet for information
     * @param {string} query - Search query
     * @returns {Promise<string|null>} Search results or null
     */
    async searchInternet(query) {
        throw new Error('searchInternet() must be implemented by subclass');
    }

    /**
     * Analyze intent from user message
     * @param {string} userMessage - User message
     * @param {Object} context - Additional context
     * @returns {Promise<Object>} Parsed intent result
     */
    async analyzeIntent(userMessage, context) {
        throw new Error('analyzeIntent() must be implemented by subclass');
    }
}

/**
 * Create a new provider instance from config
 * @param {string} providerName - Name of the provider
 * @param {Object} config - Provider configuration
 * @returns {BaseLLMProvider} Provider instance
 */
function createProvider(providerName, config) {
    // Provider registry - add new providers here
    const providers = {
        deepseek: require('./deepseekProvider')
    };

    const Provider = providers[providerName];
    if (!Provider) {
        const available = Object.keys(providers).join(', ');
        throw new Error(`Unknown provider: "${providerName}". Available: ${available}`);
    }

    return new Provider(config);
}

module.exports = {
    BaseLLMProvider,
    createProvider
};