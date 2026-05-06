// utils/contactCache.js
// Stores phone numbers for user IDs to map LIDs to actual phone numbers
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'contact_cache.json');

let cache = new Map();

// Load cache from file
function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            cache = new Map(Object.entries(data));
            console.log(`📇 Loaded ${cache.size} contacts into cache`);
        }
    } catch (err) {
        console.error('Failed to load contact cache:', err.message);
    }
}

// Save cache to file
function saveCache() {
    try {
        const obj = Object.fromEntries(cache);
        fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2));
    } catch (err) {
        console.error('Failed to save contact cache:', err.message);
    }
}

// Store contact info
function setContact(userId, phoneNumber, name = null) {
    if (!phoneNumber || phoneNumber.length < 7) return;

    cache.set(userId, {
        phoneNumber: phoneNumber.replace(/[^0-9]/g, ''),
        name: name,
        updatedAt: Date.now()
    });
    saveCache();
}

// Get stored contact info
function getContact(userId) {
    return cache.get(userId);
}

// Get phone number for a user (returns null if not cached)
function getPhoneNumber(userId) {
    const contact = cache.get(userId);
    return contact ? contact.phoneNumber : null;
}

// Check if we have a phone for this user
function hasPhone(userId) {
    return cache.has(userId);
}

loadCache();

module.exports = {
    setContact,
    getContact,
    getPhoneNumber,
    hasPhone
};