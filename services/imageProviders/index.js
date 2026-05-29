// services/imageProviders/index.js
// Factory pattern for image analysis providers
// Manages provider registration and selection

const fs = require('fs');
const path = require('path');

// Dynamic provider loading
const providerFiles = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.js') && f !== 'index.js')
    .map(f => f.replace('.js', ''));

const providers = {};
for (const name of providerFiles) {
    try {
        providers[name] = require(`./${name}.js`);
        console.log(`[IMAGE_PROVIDER] Loaded provider: ${name}`);
    } catch (err) {
        console.error(`[IMAGE_PROVIDER] Failed to load ${name}:`, err.message);
    }
}

// Provider configuration
const PROVIDER_CONFIG = {
    minimax: {
        name: 'MiniMax Vision',
        description: 'Primary provider with strong image understanding',
        credentials: ['MINIMAX_API_KEY', 'MINIMAX_GROUP_ID'],
        requires: ['apiKey', 'groupId'],
        supports: ['image', 'screenshot', 'receipt']
    },
    deepseek: {
        name: 'DeepSeek Vision',
        description: 'Alternative provider (vision support pending)',
        credentials: ['DEEPSEEK_API_KEY'],
        requires: ['apiKey'],
        supports: ['image', 'screenshot'],
        status: 'not_available'
    },
    openai: {
        name: 'OpenAI GPT-4 Vision',
        description: 'Premium provider with GPT-4o image analysis',
        credentials: ['OPENAI_API_KEY'],
        requires: ['apiKey'],
        supports: ['image', 'screenshot', 'receipt', 'document']
    }
};

/**
 * Get active provider instance
 * @returns {Object} Active provider module
 */
function getActiveProvider() {
    const providerName = process.env.IMAGE_PROVIDER || 'minimax';
    return getProvider(providerName);
}

/**
 * Get specific provider by name
 * @param {string} name - Provider name (minimax, deepseek, openai)
 * @returns {Object} Provider module
 */
function getProvider(name) {
    const Provider = providers[name];
    if (!Provider) {
        const available = Object.keys(providers).join(', ');
        throw new Error(
            `Unknown image provider: "${name}". Available providers: ${available}`
        );
    }
    return Provider;
}

/**
 * Check if a provider is configured and ready
 * @param {string} name - Provider name
 * @returns {boolean} True if configured
 */
function isProviderConfigured(name) {
    const Provider = providers[name];
    if (!Provider || !Provider.isConfigured) return false;
    return Provider.isConfigured();
}

/**
 * Get list of configured providers
 * @returns {string[]} Array of provider names that are ready to use
 */
function getConfiguredProviders() {
    return Object.keys(providers).filter(name => isProviderConfigured(name));
}

/**
 * Get provider configuration info
 * @param {string} name - Provider name
 * @returns {Object} Provider configuration
 */
function getProviderInfo(name) {
    const config = PROVIDER_CONFIG[name];
    if (!config) return null;

    return {
        ...config,
        isConfigured: isProviderConfigured(name),
        available: !!providers[name]
    };
}

/**
 * Get all available providers info
 * @returns {Object[]} Array of provider info objects
 */
function getAllProvidersInfo() {
    return Object.keys(PROVIDER_CONFIG).map(name => ({
        name,
        ...getProviderInfo(name)
    }));
}

/**
 * Validate environment configuration
 * @returns {Object} Validation result with errors and warnings
 */
function validateConfiguration() {
    const result = {
        isValid: true,
        errors: [],
        warnings: [],
        providers: {}
    };

    const activeProvider = process.env.IMAGE_PROVIDER || 'minimax';

    for (const [name, config] of Object.entries(PROVIDER_CONFIG)) {
        const missingCreds = config.credentials.filter(cred => !process.env[cred]);
        const isConfigured = missingCreds.length === 0;

        result.providers[name] = {
            name: config.name,
            isConfigured,
            missingCredentials: missingCreds,
            status: isConfigured ? 'ready' : (config.status || 'needs_credentials')
        };

        if (name === activeProvider && !isConfigured) {
            result.errors.push(
                `IMAGE_PROVIDER=${name} requires: ${missingCreds.join(', ')}`
            );
            result.isValid = false;
        }
    }

    // Check for active provider status
    if (!providers[activeProvider]) {
        result.errors.push(
            `IMAGE_PROVIDER=${activeProvider} is not available. ` +
            `Available: ${Object.keys(providers).join(', ')}`
        );
        result.isValid = false;
    }

    return result;
}

/**
 * Set active provider at runtime
 * @param {string} name - Provider name
 */
function setActiveProvider(name) {
    if (!providers[name]) {
        throw new Error(`Provider "${name}" not available`);
    }
    process.env.IMAGE_PROVIDER = name;
    console.log(`[IMAGE_PROVIDER] Active provider set to: ${name}`);
}

module.exports = {
    getActiveProvider,
    getProvider,
    getProviderInfo,
    getAllProvidersInfo,
    getConfiguredProviders,
    isProviderConfigured,
    validateConfiguration,
    setActiveProvider,
    PROVIDER_CONFIG
};