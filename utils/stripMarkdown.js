// utils/stripMarkdown.js
// Strip all markdown formatting from text for WhatsApp/Messenger compatibility

/**
 * Strip all markdown formatting from text
 * This is a safety net to ensure no markdown appears in final messages
 * @param {string} text - The text to strip markdown from
 * @returns {string} - Text with markdown removed
 */
function stripMarkdownFormatting(text) {
    if (!text || typeof text !== 'string') return text;

    // Replace **bold** with just the text (add emoji for emphasis)
    text = text.replace(/\*\*(.+?)\*\*/g, '🔥 $1');

    // Replace *italic* with just the text
    text = text.replace(/\*([^*]+?)\*/g, '$1');

    // Replace _italic_ (WhatsApp style) - keep as-is but strip underscore if not intended
    // text = text.replace(/_([^_]+)_/g, '$1'); // Uncomment if you want to strip _ too

    // Replace # headers with just text
    text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1');

    // Clean up links [text](url) -> text
    text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');

    // Clean up inline code `code` -> code
    text = text.replace(/`([^`]+)`/g, '$1');

    // Clean up code blocks ``` ``` -> remove
    text = text.replace(/```[\s\S]*?```/g, '');

    return text;
}

module.exports = {
    stripMarkdownFormatting
};