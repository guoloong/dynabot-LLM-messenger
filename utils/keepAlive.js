// utils/keepAlive.js
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', (error) => console.error('Uncaught Exception:', error));
let heartbeat = null;
function startHeartbeat(ms = 120000) {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => console.log(`💓 Heartbeat - ${new Date().toLocaleTimeString()}`), ms);
}
function stopHeartbeat() { if (heartbeat) clearInterval(heartbeat); }
module.exports = { startHeartbeat, stopHeartbeat };