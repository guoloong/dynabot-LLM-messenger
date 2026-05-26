// utils/translateWithHistory.js
// Translates English responses to match user's current language

const axios = require('axios');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const TIMEOUT_MS = 15000;

/**
 * Translates English response to match user's current language
 * @param {string} englishText - The English response from priceApi or storeLocator
 * @param {string} currentMessage - The user's current message (for language detection)
 * @param {Array} preserveItems - Optional: array of strings to preserve (store names, addresses, etc.)
 * @param {string} apiKey - DeepSeek API key
 * @returns {string} Translated response (or original if LLM fails)
 */
async function translateWithHistory(englishText, currentMessage, preserveItems = [], apiKey) {
    if (!apiKey) {
        console.log('[TRANSLATE] No API key, returning English text');
        return englishText;
    }

    if (!englishText || !currentMessage) {
        return englishText;
    }

    try {
        // Build preservation instructions if items provided
        let preserveInstructions = '';
        if (preserveItems.length > 0) {
            preserveInstructions = `\n\nCRITICAL: Do NOT translate these items. Keep them EXACTLY as-is (in English):
${preserveItems.map(item => `- ${item}`).join('\n')}`;
        }

        const prompt = `You are a translation assistant. Your ONLY task is to translate text.

USER'S CURRENT MESSAGE (to determine target language):
"${currentMessage}"
${preserveInstructions}

RESPONSE TO TRANSLATE:
${englishText}

INSTRUCTIONS:
1. First, identify the language of the user's current message
2. Then, translate the response to EXACTLY that same language
3. If the message is in English → return the response in English (no translation needed)
4. If the message is in Chinese → return the response in Chinese
5. If the message is in Malay → return the response in Malay
6. If the message is in Indonesian → return the response in Indonesian
7. If the message is in Thai → return the response in Thai
8. If the message is in Vietnamese → return the response in Vietnamese

DO NOT:
- Translate to a different language than the user's message
- Translate store names, addresses, phone numbers, prices, product names
- Add explanations or notes
- Use markdown code blocks

Return ONLY the translated response text.`;

        const response = await axios.post(
            DEEPSEEK_API_URL,
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are a translation assistant. Always translate to the exact same language as the user\'s message.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.1,
                max_tokens: 1000
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                timeout: TIMEOUT_MS
            }
        );

        const translatedText = response.data.choices[0].message.content.trim();

        // Clean up any markdown code blocks if LLM added them
        const cleanedText = translatedText.replace(/^```\n?|```$/gi, '').trim();

        console.log('[TRANSLATE] Successfully translated response');
        return cleanedText || englishText;

    } catch (err) {
        console.error(`[TRANSLATE] Translation failed: ${err.message}`);
        // Fallback: return original English text
        return englishText;
    }
}

module.exports = { translateWithHistory };