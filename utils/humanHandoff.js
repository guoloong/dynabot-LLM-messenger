// utils/humanHandoff.js
// Manages human agent handoff state for WhatsApp bot
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '..', 'human_sessions.json');
const AUTO_RETURN_HOURS = 24; // Auto return to bot after 24 hours of human silence

let sessions = new Map();
let saveTimer = null;

// Load sessions from file on startup
function loadSessions() {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
            sessions = new Map(Object.entries(data));
            console.log(`📋 Loaded ${sessions.size} human sessions`);

            // Clean up expired sessions
            cleanupExpiredSessions();
        }
    } catch (err) {
        console.error('Failed to load human sessions:', err.message);
    }
}

// Save sessions to file (debounced)
function saveSessions() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const obj = Object.fromEntries(sessions);
            fs.writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2));
        } catch (err) {
            console.error('Failed to save human sessions:', err.message);
        }
    }, 500);
}

// Clean up expired sessions (auto-return to bot)
function cleanupExpiredSessions() {
    const now = Date.now();
    let changed = false;

    for (const [userId, session] of sessions.entries()) {
        if (session.mode === 'human') {
            // Check if human has been silent for too long
            const silentMs = now - (session.lastHumanMessage || session.startedAt);
            if (silentMs > AUTO_RETURN_HOURS * 60 * 60 * 1000) {
                console.log(`⏰ Auto-returning user ${userId} to bot (human timeout)`);
                sessions.delete(userId);
                changed = true;
            }
        }
    }

    if (changed) saveSessions();
}

// Periodic cleanup every 30 minutes
setInterval(cleanupExpiredSessions, 30 * 60 * 1000);

// Get session state for a user
function getSession(userId) {
    return sessions.get(userId);
}

// Check if user is in human mode
function isHumanMode(userId) {
    const session = sessions.get(userId);
    return session && session.mode === 'human';
}

// Set user to human mode (human agent takes over)
function setHumanMode(userId, agentId = 'human', phoneNumber = null) {
    sessions.set(userId, {
        mode: 'human',
        agentId: agentId,
        startedAt: Date.now(),
        lastHumanMessage: Date.now(),
        status: 'active',
        phoneNumber: phoneNumber // Store the actual phone number
    });
    console.log(`👤 User ${userId} switched to HUMAN mode (agent: ${agentId}, phone: ${phoneNumber})`);
    saveSessions();
}

// Set user back to bot mode (handoff complete)
function setBotMode(userId, reason = 'manual') {
    sessions.delete(userId);
    console.log(`🤖 User ${userId} returned to BOT mode (reason: ${reason})`);
    saveSessions();
}

// Update last human message timestamp
function updateHumanActivity(userId) {
    const session = sessions.get(userId);
    if (session && session.mode === 'human') {
        session.lastHumanMessage = Date.now();
        saveSessions();
    }
}

// Close human session
function closeSession(userId) {
    sessions.delete(userId);
    saveSessions();
}

// Get all active human sessions (for dashboard)
function getActiveSessions() {
    return Object.fromEntries(sessions);
}

// Check if current time is within human agent working hours
// Working hours: Monday to Friday, 9:00 AM to 5:00 PM
function isWithinWorkingHours() {
    const now = new Date();

    // Get day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
    const dayOfWeek = now.getDay();

    // Check if it's Monday to Friday (1-5)
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        return false; // Weekend
    }

    // Get hours in 24-hour format
    const hours = now.getHours();
    const minutes = now.getMinutes();

    // Check if within 9:00 AM to 5:00 PM
    // 9:00 AM = 9, 5:00 PM = 17
    const currentTimeMinutes = hours * 60 + minutes;
    const startTimeMinutes = 9 * 60;      // 9:00 AM = 540 minutes
    const endTimeMinutes = 17 * 60;        // 5:00 PM = 1020 minutes

    return currentTimeMinutes >= startTimeMinutes && currentTimeMinutes < endTimeMinutes;
}

// Get working hours status message
function getWorkingHoursMessage() {
    return "Our human agents are only available Monday to Friday, 9:00 AM to 5:00 PM. " +
           "For immediate assistance, please leave a message and we'll get back to you during business hours. " +
           "Thank you for your patience!";
}

// Check if user triggered escalation keywords
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
    shouldEscalate,
    isWithinWorkingHours,
    getWorkingHoursMessage
};