// utils/humanHandoff.js
// Manages human agent handoff state for both WhatsApp and Messenger

const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '..', 'human_sessions.json');
const AUTO_RETURN_HOURS = 24;

// Platform constants
const PLATFORM_WHATSAPP = 'whatsapp';
const PLATFORM_MESSENGER = 'messenger';

let sessions = new Map();
let saveTimer = null;

function loadSessions() {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
            sessions = new Map(Object.entries(data));
            console.log(`[HANDOFF] Loaded ${sessions.size} human sessions`);
            cleanupExpiredSessions();
        }
    } catch (err) {
        console.error('[HANDOFF] Failed to load sessions:', err.message);
    }
}

function saveSessions() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const obj = Object.fromEntries(sessions);
            fs.writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2));
        } catch (err) {
            console.error('[HANDOFF] Failed to save sessions:', err.message);
        }
    }, 500);
}

function cleanupExpiredSessions() {
    const now = Date.now();
    let changed = false;

    for (const [userId, session] of sessions.entries()) {
        if (session.mode === 'human') {
            const silentMs = now - (session.lastHumanMessage || session.startedAt);
            if (silentMs > AUTO_RETURN_HOURS * 60 * 60 * 1000) {
                console.log(`[HANDOFF] Auto-returning user ${userId} to bot`);
                sessions.delete(userId);
                changed = true;
            }
        }
    }

    if (changed) saveSessions();
}

setInterval(cleanupExpiredSessions, 30 * 60 * 1000);

function getSession(userId) {
    // DEBUG: Log incoming request
    console.log(`[HANDOFF] DEBUG getSession: userId=${userId}`);

    // Direct lookup
    const session = sessions.get(userId);
    console.log(`[HANDOFF] DEBUG getSession: directMatch=${session ? 'YES' : 'NO'}`);
    if (session) {
        return session;
    }

    // DEBUG: Log all current sessions
    console.log(`[HANDOFF] DEBUG getSession: Checking against ${sessions.size} total sessions`);
    for (const [storedId, storedSession] of sessions.entries()) {
        console.log(`[HANDOFF] DEBUG Session: storedId=${storedId}, platform=${storedSession.platform}, mode=${storedSession.mode}, fbName=${storedSession.facebookName || 'none'}`);
    }

    // For WhatsApp LID format - try to find matching session by phone
    const cleanUserId = userId.replace(/[^0-9]/g, '');
    if (cleanUserId.length < 7) return null;

    // Load contact cache to build phone -> userId mapping
    let contactCache = {};
    try {
        const cacheFile = path.join(__dirname, '..', 'contact_cache.json');
        if (fs.existsSync(cacheFile)) {
            contactCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        }
    } catch (e) {}

    // Build phone -> userId map from contact cache
    const phoneToCachedUser = {};
    for (const [cachedUserId, contact] of Object.entries(contactCache)) {
        if (contact && contact.phoneNumber) {
            const phone = contact.phoneNumber.replace(/[^0-9]/g, '');
            phoneToCachedUser[phone] = cachedUserId;
        }
    }

    // Get user's phone from contact cache using their userId
    let userPhone = null;
    for (const [phone, cachedId] of Object.entries(phoneToCachedUser)) {
        if (cachedId === userId) {
            userPhone = phone;
            break;
        }
    }

    console.log(`[HANDOFF] getSession checking: userId=${userId}, cleanUserId=${cleanUserId}, userPhone=${userPhone}`);

    // Check all WhatsApp sessions for phone match
    for (const [storedId, storedSession] of sessions.entries()) {
        if (storedSession.platform === PLATFORM_WHATSAPP) {
            const storedPhone = storedSession.phoneNumber ? storedSession.phoneNumber.replace(/[^0-9]/g, '') : '';
            if (!storedPhone) continue;

            console.log(`[HANDOFF] getSession comparing with: storedId=${storedId}, storedPhone=${storedPhone}`);

            // Match if any of these conditions are true:
            // 1. Stored phone matches user's phone from contact cache
            // 2. Stored phone contains last 8 of incoming LID
            // 3. User's phone from cache contains stored phone
            // 4. Stored phone is contained in incoming LID (phone@c.us vs LID@c.us)
            // 5. Last 8 of stored phone matches last 8 of incoming LID
            if (userPhone && storedPhone === userPhone) {
                console.log(`[HANDOFF] getSession: MATCH (exact userPhone)`);
                return storedSession;
            }
            if (storedPhone.includes(cleanUserId.slice(-8))) {
                console.log(`[HANDOFF] getSession: MATCH (stored contains LID last 8)`);
                return storedSession;
            }
            if (userPhone && storedPhone.includes(userPhone)) {
                console.log(`[HANDOFF] getSession: MATCH (stored contains userPhone)`);
                return storedSession;
            }
            if (cleanUserId.includes(storedPhone)) {
                console.log(`[HANDOFF] getSession: MATCH (LID contains stored)`);
                return storedSession;
            }
            if (storedPhone.slice(-8) === cleanUserId.slice(-8)) {
                console.log(`[HANDOFF] getSession: MATCH (last 8 match)`);
                return storedSession;
            }
        }
    }

    return null;
}

function isHumanMode(userId) {
    // Direct lookup
    const session = sessions.get(userId);
    console.log(`[HANDOFF] DEBUG isHumanMode: userId=${userId}, directMatch=${session ? 'YES' : 'NO'}`);
    if (session && session.mode === 'human') {
        return true;
    }

    // DEBUG: Log all current sessions for troubleshooting
    console.log(`[HANDOFF] DEBUG: Checking against ${sessions.size} total sessions`);
    for (const [storedId, storedSession] of sessions.entries()) {
        console.log(`[HANDOFF] DEBUG Session: storedId=${storedId}, platform=${storedSession.platform}, mode=${storedSession.mode}, fbName=${storedSession.facebookName || 'none'}, phone=${storedSession.phoneNumber || 'none'}`);
    }

    // For WhatsApp LID format - try to match by phone
    const cleanUserId = userId.replace(/[^0-9]/g, '');
    if (cleanUserId.length < 7) return false;

    // Load contact cache to build phone -> userId mapping
    let contactCache = {};
    try {
        const cacheFile = path.join(__dirname, '..', 'contact_cache.json');
        if (fs.existsSync(cacheFile)) {
            contactCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        }
    } catch (e) {}

    // Build phone -> userId map from contact cache
    const phoneToCachedUser = {};
    for (const [cachedUserId, contact] of Object.entries(contactCache)) {
        if (contact && contact.phoneNumber) {
            const phone = contact.phoneNumber.replace(/[^0-9]/g, '');
            phoneToCachedUser[phone] = cachedUserId;
        }
    }

    // Get user's phone from contact cache using their userId
    let userPhone = null;
    for (const [phone, cachedId] of Object.entries(phoneToCachedUser)) {
        if (cachedId === userId) {
            userPhone = phone;
            break;
        }
    }

    console.log(`[HANDOFF] isHumanMode checking: userId=${userId}, cleanUserId=${cleanUserId}, userPhone=${userPhone}`);

    // Check all WhatsApp human sessions for phone match
    for (const [storedId, storedSession] of sessions.entries()) {
        if (storedSession.platform === PLATFORM_WHATSAPP && storedSession.mode === 'human') {
            const storedPhone = storedSession.phoneNumber ? storedSession.phoneNumber.replace(/[^0-9]/g, '') : '';
            if (!storedPhone) continue;

            console.log(`[HANDOFF] isHumanMode comparing with: storedId=${storedId}, storedPhone=${storedPhone}`);

            // Match if any of these conditions are true:
            // 1. Stored phone matches user's phone from contact cache
            // 2. Stored phone contains last 8 of incoming LID
            // 3. User's phone from cache contains stored phone
            // 4. Stored phone is contained in incoming LID (phone@c.us vs LID@c.us)
            // 5. Last 8 of stored phone matches last 8 of incoming LID
            if (userPhone && storedPhone === userPhone) {
                console.log(`[HANDOFF] isHumanMode: MATCH (exact userPhone)`);
                return true;
            }
            if (storedPhone.includes(cleanUserId.slice(-8))) {
                console.log(`[HANDOFF] isHumanMode: MATCH (stored contains LID last 8)`);
                return true;
            }
            if (userPhone && storedPhone.includes(userPhone)) {
                console.log(`[HANDOFF] isHumanMode: MATCH (stored contains userPhone)`);
                return true;
            }
            if (cleanUserId.includes(storedPhone)) {
                console.log(`[HANDOFF] isHumanMode: MATCH (LID contains stored)`);
                return true;
            }
            if (storedPhone.slice(-8) === cleanUserId.slice(-8)) {
                console.log(`[HANDOFF] isHumanMode: MATCH (last 8 match)`);
                return true;
            }
        }
    }

    return false;
}

function setHumanMode(userId, agentId = 'human', phoneNumber = null, platform = PLATFORM_WHATSAPP, facebookName = null) {
    // DEBUG: Log what we're about to save
    console.log(`[HANDOFF] DEBUG setHumanMode: userId=${userId}, agentId=${agentId}, phone=${phoneNumber}, platform=${platform}, fbName=${facebookName}`);

    sessions.set(userId, {
        mode: 'human',
        agentId: agentId,
        startedAt: Date.now(),
        lastHumanMessage: Date.now(),
        status: 'active',
        phoneNumber: phoneNumber,
        platform: platform,
        facebookName: facebookName
    });

    // DEBUG: Verify what was actually saved
    const savedSession = sessions.get(userId);
    console.log(`[HANDOFF] DEBUG setHumanMode: Verified saved session - mode=${savedSession.mode}, platform=${savedSession.platform}, fbName=${savedSession.facebookName}`);

    console.log(`[HANDOFF] User ${userId} switched to HUMAN mode (platform: ${platform}, name: ${facebookName || phoneNumber || userId})`);
    saveSessions();
}

function setBotMode(userId, reason = 'manual') {
    sessions.delete(userId);
    console.log(`[HANDOFF] User ${userId} returned to BOT mode (reason: ${reason})`);
    saveSessions();
}

function updateHumanActivity(userId) {
    const session = sessions.get(userId);
    if (session && session.mode === 'human') {
        session.lastHumanMessage = Date.now();
        saveSessions();
    }
}

function closeSession(userId) {
    sessions.delete(userId);
    saveSessions();
}

function getActiveSessions() {
    return Object.fromEntries(sessions);
}

/**
 * Get active sessions filtered by platform
 */
function getActiveSessionsByPlatform(platform) {
    const filtered = {};
    for (const [userId, session] of Object.entries(sessions)) {
        if (session.platform === platform) {
            filtered[userId] = session;
        }
    }
    return filtered;
}

/**
 * Get display name for a session (phone number for WhatsApp, facebookName for Messenger)
 */
function getSessionDisplayName(session) {
    if (session.platform === PLATFORM_MESSENGER && session.facebookName) {
        return session.facebookName;
    }
    return session.phoneNumber || session.userId || 'Unknown';
}

/**
 * Close session by facebook name (for Messenger admin commands)
 * If platform is specified, only closes sessions on that platform
 */
function closeSessionByName(name, platform = null) {
    const lowerName = name.toLowerCase();
    let closed = [];

    for (const [userId, session] of sessions.entries()) {
        // Filter by platform if specified
        if (platform && session.platform !== platform) {
            continue;
        }
        if (session.facebookName && session.facebookName.toLowerCase() === lowerName) {
            sessions.delete(userId);
            closed.push(userId);
            console.log(`[HANDOFF] Closed session for ${name} (${userId}, platform: ${session.platform})`);
        }
    }

    if (closed.length > 0) {
        saveSessions();
    }

    return closed;
}

/**
 * Close sessions by phone number (for WhatsApp admin commands)
 */
function closeSessionByPhone(phoneNumber) {
    const cleaned = phoneNumber.replace(/[^0-9]/g, '');
    let closed = [];

    for (const [userId, session] of sessions.entries()) {
        if (session.phoneNumber) {
            const sessionPhone = session.phoneNumber.replace(/[^0-9]/g, '');
            if (sessionPhone === cleaned || sessionPhone.includes(cleaned) || cleaned.includes(sessionPhone)) {
                sessions.delete(userId);
                closed.push(userId);
                console.log(`[HANDOFF] Closed session for ${phoneNumber} (${userId})`);
            }
        }
    }

    if (closed.length > 0) {
        saveSessions();
    }

    return closed;
}

function isWithinWorkingHours() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) return false;

    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentTimeMinutes = hours * 60 + minutes;
    const startTimeMinutes = 9 * 60;
    const endTimeMinutes = 17 * 60;

    return currentTimeMinutes >= startTimeMinutes && currentTimeMinutes < endTimeMinutes;
}

function getWorkingHoursMessage() {
    return "Our human agents are only available Monday to Friday, 9:00 AM to 5:00 PM. " +
           "For immediate assistance, please leave a message and we'll get back to you during business hours.";
}

function shouldEscalate(message) {
    const keywords = [
        'talk to human', 'speak to human', 'real person', 'live agent',
        'customer service', 'representative', 'help from person',
        'person', 'agent', 'real person', 'not bot', 'not a bot'
    ];
    const lowerMsg = message.toLowerCase();
    return keywords.some(k => lowerMsg.includes(k));
}

loadSessions();

module.exports = {
    isHumanMode,
    setHumanMode,
    setBotMode,
    updateHumanActivity,
    closeSession,
    getSession,
    getActiveSessions,
    getActiveSessionsByPlatform,
    getSessionDisplayName,
    closeSessionByName,
    closeSessionByPhone,
    shouldEscalate,
    isWithinWorkingHours,
    getWorkingHoursMessage,
    PLATFORM_WHATSAPP,
    PLATFORM_MESSENGER
};