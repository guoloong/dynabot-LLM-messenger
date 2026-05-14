// utils/llmHelpers.js
// Shared LLM utilities - extracted to avoid circular dependencies
// No imports from services/ to prevent circular dependency

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// Retry wrapper with exponential backoff for HTTP requests
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
    let lastError;
    const defaultOptions = {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000
    };
    const mergedOptions = { ...defaultOptions, ...options };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(url, mergedOptions);
            return response;
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                const delay = 1000 * Math.pow(2, attempt - 1);
                console.log(`⚠️ Fetch retry ${attempt}/${maxRetries} for ${url} in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    console.error(`❌ All ${maxRetries} retries failed for ${url}:`, lastError?.message);
    throw lastError;
}

async function searchWebsite(query) {
    try {
        const searchUrl = `https://www.dyna-nutrition.com/?s=${encodeURIComponent(query)}`;
        console.log(`🔎 Searching: ${searchUrl}`);
        const response = await fetchWithRetry(searchUrl);
        const $ = cheerio.load(response.data);
        $('script, style, nav, footer, header, .sidebar, .menu').remove();
        let mainContent = '';
        const selectors = ['.entry-content', 'article', '.post-content', '.product-content', '#primary', '.content-area'];
        for (const sel of selectors) {
            if ($(sel).length) {
                const text = $(sel).text().trim();
                if (text.length > 200) {
                    mainContent = text;
                    break;
                }
            }
        }
        if (!mainContent) mainContent = $('body').text().trim();
        const cleaned = mainContent.replace(/\s+/g, ' ').trim();
        if (cleaned.toLowerCase().includes('no results found')) {
            console.log('⚠️ No results found');
            return null;
        }
        console.log(`✅ Extracted ${cleaned.length} chars`);
        return cleaned;
    } catch (err) {
        console.error('Search error:', err.message);
        return null;
    }
}

async function fetchProductPageAndLinks(productUrl, maxInternalLinks = 3) {
    try {
        console.log(`📄 Fetching product page: ${productUrl}`);
        const response = await fetchWithRetry(productUrl, { timeout: 10000 });
        const $ = cheerio.load(response.data);
        $('script, style, nav, footer, header, .sidebar, .menu').remove();

        const mainContent = $('body').text().replace(/\s+/g, ' ').trim();

        const domain = new URL(productUrl).origin;
        const internalLinks = [];
        $('a[href]').each((i, el) => {
            let href = $(el).attr('href');
            if (href) {
                if (href.startsWith('/')) href = domain + href;
                else if (!href.startsWith('http')) return;
                if (href.startsWith(domain) && href !== productUrl) {
                    internalLinks.push(href);
                }
            }
        });
        const uniqueLinks = [...new Set(internalLinks)].slice(0, maxInternalLinks);

        let combinedContent = mainContent;
        for (const link of uniqueLinks) {
            try {
                console.log(`   🔗 Fetching internal link: ${link}`);
                const linkRes = await axios.get(link, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
                const $$ = cheerio.load(linkRes.data);
                $$('script, style, nav, footer, header, .sidebar, .menu').remove();
                const linkText = $$('body').text().replace(/\s+/g, ' ').trim();
                combinedContent += ' ' + linkText;
            } catch (err) {
                console.warn(`   ⚠️ Failed to fetch internal link ${link}: ${err.message}`);
            }
        }

        console.log(`📄 Product page + internal links: ${combinedContent.length} chars`);
        return combinedContent.length > 200 ? combinedContent : null;
    } catch (err) {
        console.error('📄 Product page fetch error:', err.message);
        return null;
    }
}

async function callDeepSeek(messages, apiKey) {
    console.log(`🔮 Calling DeepSeek API with ${messages.length} messages...`);
    if (!apiKey) {
        console.error('❌ No API key provided');
        return null;
    }
    try {
        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: "deepseek-chat",
            messages,
            temperature: 0.2,
            max_tokens: 500
        }, { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 20000 });
        const content = response.data.choices[0].message.content;
        console.log(`✅ DeepSeek response (${content.length} chars): "${content.substring(0, 150)}..."`);
        return content;
    } catch (err) {
        console.error('❌ DeepSeek API error:', err.message);
        return null;
    }
}

async function callDeepSeekWithRetry(messages, apiKey, maxRetries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await callDeepSeek(messages, apiKey);
            return result;
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                const delay = 1000 * Math.pow(2, attempt - 1);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    console.error(`❌ All ${maxRetries} retries failed:`, lastError?.message);
    return null;
}

async function extractKeywordsWithDeepSeek(userMessage, apiKey) {
    console.log(`🔍 Asking DeepSeek to extract keywords from: "${userMessage}"`);
    if (!apiKey) return userMessage;

    const prompt = `Extract the most important keywords from this user message for a web search.
Return ONLY the keywords separated by spaces, no punctuation, no extra text.
Focus on product names, ingredients, health terms, key concepts.
Remove filler words like "can", "does", "what", "is", "the", "should", "we", "have", etc.

User message: "${userMessage}"
Keywords:`;

    try {
        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are a keyword extraction tool. Respond only with the keywords.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0,
                max_tokens: 50
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                timeout: 10000
            }
        );

        const keywords = response.data.choices[0].message.content.trim();
        if (!keywords || keywords.split(/\s+/).length === 0 || keywords.length < 3) {
            return userMessage;
        }
        return keywords;
    } catch (err) {
        console.error('❌ Keyword extraction failed:', err.message);
        return userMessage;
    }
}

module.exports = {
    searchWebsite,
    fetchProductPageAndLinks,
    callDeepSeek,
    callDeepSeekWithRetry,
    extractKeywordsWithDeepSeek
};