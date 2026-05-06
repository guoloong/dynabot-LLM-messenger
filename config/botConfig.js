// config/botConfig.js
const axios = require('axios');
const cheerio = require('cheerio');

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
                const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
                console.log(`⚠️ Fetch retry ${attempt}/${maxRetries} for ${url} in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    console.error(`❌ All ${maxRetries} retries failed for ${url}:`, lastError?.message);
    throw lastError;
}

const responseTemplates = {
    ORDER_INQUIRY: "📦 I'm unable to handle order-related questions. A human representative will contact you shortly. Please share your order number if available.",
    HUMAN_ESCALATION: "🙋 I'll connect you with a human representative right away. Please hold on.",
    OUT_OF_SCOPE: "🤖 I can only answer questions about our health supplements and wellness topics. Please ask about our products or request a human for other matters.",
    ERROR: "⚠️ I'm having trouble responding. Please try again or contact support."
};

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

        // Main content from product page
        const mainContent = $('body').text().replace(/\s+/g, ' ').trim();

        // Collect internal links (same domain)
        const domain = new URL(productUrl).origin;
        const internalLinks = [];
        $('a[href]').each((i, el) => {
            let href = $(el).attr('href');
            if (href) {
                // Resolve relative URLs
                if (href.startsWith('/')) href = domain + href;
                else if (!href.startsWith('http')) return;
                // Only same domain and not the product page itself
                if (href.startsWith(domain) && href !== productUrl) {
                    internalLinks.push(href);
                }
            }
        });
        // Remove duplicates
        const uniqueLinks = [...new Set(internalLinks)].slice(0, maxInternalLinks);

        let combinedContent = mainContent;
        // Fetch each internal link and add its text
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

module.exports = { responseTemplates, searchWebsite, fetchProductPageAndLinks };