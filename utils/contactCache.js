// utils/contactCache.js
// Stores phone numbers for user IDs (WhatsApp) and Facebook names for Messenger

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'contact_cache.json');

let cache = new Map();
let fbNameToPsid = new Map(); // Facebook name -> PSID mapping for Messenger

function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            cache = new Map(Object.entries(data));
            console.log(`[CONTACTS] Loaded ${cache.size} contacts`);
        }
    } catch (err) {
        console.error('[CONTACTS] Failed to load cache:', err.message);
    }
}

function saveCache() {
    try {
        const obj = Object.fromEntries(cache);
        fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2));
    } catch (err) {
        console.error('[CONTACTS] Failed to save cache:', err.message);
    }
}

function setContact(userId, phoneNumber, name = null) {
    if (!phoneNumber || phoneNumber.length < 7) return;

    cache.set(userId, {
        phoneNumber: phoneNumber.replace(/[^0-9]/g, ''),
        name: name,
        updatedAt: Date.now()
    });
    saveCache();
}

/**
 * Store Facebook name -> PSID mapping for Messenger users
 */
function setFacebookUser(psid, facebookName) {
    if (!psid || !facebookName) return;

    const lowerName = facebookName.toLowerCase();

    // Store both PSID->info and name->PSID mapping
    cache.set(psid, {
        facebookName: facebookName,
        updatedAt: Date.now()
    });

    fbNameToPsid.set(lowerName, psid);
    saveCache();

    console.log(`[CONTACTS] Cached FB user: ${facebookName} -> ${psid}`);
}

/**
 * Get PSID by Facebook name (for Messenger !escalate)
 */
function getPsidByFacebookName(facebookName) {
    if (!facebookName) return null;

    const lowerName = facebookName.toLowerCase();
    return fbNameToPsid.get(lowerName) || null;
}

/**
 * Get cached Facebook name for a PSID
 */
function getFacebookName(psid) {
    const contact = cache.get(psid);
    return contact ? contact.facebookName : null;
}

function getContact(userId) {
    return cache.get(userId);
}

function getPhoneNumber(userId) {
    const contact = cache.get(userId);
    return contact ? contact.phoneNumber : null;
}

function hasPhone(userId) {
    return cache.has(userId);
}

loadCache();

module.exports = {
    setContact,
    setFacebookUser,
    getPsidByFacebookName,
    getFacebookName,
    getContact,
    getPhoneNumber,
    hasPhone
};