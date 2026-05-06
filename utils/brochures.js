// utils/brochures.js
// Loads and manages product brochure supplementary information
const fs = require('fs');
const path = require('path');

const BROCHURES_DIR = path.join(__dirname, '..', 'config', 'brochures');

let brochuresCache = new Map();

// Load all brochures from config/brochures folder
function loadBrochures() {
    brochuresCache.clear();

    try {
        if (!fs.existsSync(BROCHURES_DIR)) {
            console.log('📚 Brochures folder not found:', BROCHURES_DIR);
            return;
        }

        const files = fs.readdirSync(BROCHURES_DIR);

        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const filePath = path.join(BROCHURES_DIR, file);
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

                    if (data.product_id) {
                        brochuresCache.set(data.product_id.toLowerCase(), {
                            product_id: data.product_id,
                            source_file: data.source_file,
                            content: data.content
                        });
                        console.log(`📚 Loaded brochure: ${data.product_id}`);
                    }
                } catch (e) {
                    console.error(`Failed to load brochure ${file}:`, e.message);
                }
            }
        }

        console.log(`📚 Total brochures loaded: ${brochuresCache.size}`);
    } catch (err) {
        console.error('Failed to load brochures:', err.message);
    }
}

// Get brochure content for a specific product
function getBrochure(productId) {
    return brochuresCache.get(productId.toLowerCase()) || null;
}

// Get all brochure product IDs
function getBrochureProductIds() {
    return Array.from(brochuresCache.keys());
}

// Check if product has brochure
function hasBrochure(productId) {
    return brochuresCache.has(productId.toLowerCase());
}

// Get supplementary info for AI prompt
function getSupplementaryInfo(productId) {
    const brochure = getBrochure(productId);
    if (brochure) {
        return `\n\n[Supplementary Information from Product Brochure]\n${brochure.content}`;
    }
    return '';
}

// Initialize on load
loadBrochures();

module.exports = {
    loadBrochures,
    getBrochure,
    getBrochureProductIds,
    hasBrochure,
    getSupplementaryInfo
};