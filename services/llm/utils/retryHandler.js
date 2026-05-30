// services/llm/utils/retryHandler.js
// Consolidated retry logic for LLM API calls
// Handles rate limiting, network errors, and transient failures

/**
 * Sleep utility for delays
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable
 * @param {Error} error - Error to check
 * @returns {boolean} - True if retryable
 */
function isRetryable(error) {
    // Rate limiting
    if (error.response?.status === 429) return true;

    // Server errors
    if (error.response?.status >= 500 && error.response?.status < 600) return true;

    // Network errors
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
        return true;
    }

    // Abort (timeout) - not retryable
    if (error.name === 'AbortError' || error.code === 'ECONNABORTED') {
        return false;
    }

    // Client errors (4xx except 429) - not retryable
    if (error.response?.status >= 400 && error.response?.status < 500 && error.response?.status !== 429) {
        return false;
    }

    return true;
}

/**
 * Execute a function with exponential backoff retry
 * @param {Function} fn - Async function to execute
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum number of retries (default: 3)
 * @param {number} options.baseDelay - Base delay in ms (default: 1000)
 * @param {number} options.maxDelay - Maximum delay in ms (default: 10000)
 * @param {string} options.label - Label for logging (default: 'Request')
 * @returns {Promise} - Result of the function
 */
async function withRetry(fn, options = {}) {
    const {
        maxRetries = 3,
        baseDelay = 1000,
        maxDelay = 10000,
        label = 'Request'
    } = options;

    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Don't retry if not retryable or this is the last attempt
            if (!isRetryable(error) || attempt >= maxRetries) {
                throw error;
            }

            // Calculate delay with exponential backoff
            const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);

            // Log retry attempt
            const retryableMsg = isRetryable(error) ? '' : ' (non-retryable)';
            console.log(`[RETRY] ${label} failed (attempt ${attempt}/${maxRetries}): ${error.message}${retryableMsg}`);
            console.log(`[RETRY] Retrying in ${delay}ms...`);

            await sleep(delay);
        }
    }

    throw lastError;
}

/**
 * Execute an HTTP GET request with retry
 * @param {Object} axios - Axios instance
 * @param {string} url - URL to fetch
 * @param {Object} options - Request options
 * @param {Object} retryOptions - Retry options
 * @returns {Promise<Object>} - Response data
 */
async function httpGetWithRetry(axios, url, options = {}, retryOptions = {}) {
    const defaultOptions = {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
    };

    const mergedOptions = { ...defaultOptions, ...options };

    return withRetry(
        async () => {
            const response = await axios.get(url, mergedOptions);
            return response;
        },
        { ...retryOptions, label: `GET ${url}` }
    );
}

/**
 * Execute an HTTP POST request with retry
 * @param {Object} axios - Axios instance
 * @param {string} url - URL to post to
 * @param {Object} data - Request body
 * @param {Object} options - Request options
 * @param {Object} retryOptions - Retry options
 * @returns {Promise<Object>} - Response data
 */
async function httpPostWithRetry(axios, url, data, options = {}, retryOptions = {}) {
    const defaultOptions = {
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
    };

    const mergedOptions = { ...defaultOptions, ...options };

    return withRetry(
        async () => {
            const response = await axios.post(url, data, mergedOptions);
            return response;
        },
        { ...retryOptions, label: `POST ${url}` }
    );
}

module.exports = {
    sleep,
    isRetryable,
    withRetry,
    httpGetWithRetry,
    httpPostWithRetry
};