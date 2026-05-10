// services/intentManager.js
// LLM-Driven Intent State Machine for Natural Conversation Flow

const axios = require('axios');

// In-memory state storage (per user)
const userIntentStates = new Map();

// State types
const STATES = {
    IDLE: 'IDLE',
    AWAITING_PRODUCT: 'AWAITING_PRODUCT',
    AWAITING_LOCATION: 'AWAITING_LOCATION',
    AWAITING_ACTION: 'AWAITING_ACTION',
    ACTIVE_EVALUATION: 'ACTIVE_EVALUATION'
};

// Intent types
const INTENT_TYPES = {
    PRODUCT_INFO: 'product_info',
    PRICE_CHECK: 'price_check',
    STORE_LOCATOR: 'store_locator',
    PURCHASE_INTENT: 'purchase_intent',
    COMPARISON: 'comparison',
    RECOMMENDATION: 'recommendation',
    GENERAL_INQUIRY: 'general_inquiry'
};

// Get or create user state
function getUserState(userId) {
    if (!userId) return null;
    
    if (!userIntentStates.has(userId)) {
        userIntentStates.set(userId, createState());
    }
    
    const state = userIntentStates.get(userId);
    
    // Check if state has expired (2 minute timeout)
    if (state.pendingIntent && state.pendingIntent.expiresAt) {
        if (Date.now() > state.pendingIntent.expiresAt) {
            console.log(`⏰ [INTENT] State expired for user ${userId}, resetting to IDLE`);
            state.currentState = STATES.IDLE;
            state.pendingIntent = null;
        }
    }
    
    return state;
}

// Create initial state
function createState() {
    return {
        currentState: STATES.IDLE,
        pendingIntent: null,
        context: {
            product: null,
            productSlug: null,
            location: null,
            currency: null,
            lastAction: null
        },
        lastUpdated: Date.now()
    };
}

// Clear user state
function clearUserState(userId) {
    if (userId && userIntentStates.has(userId)) {
        userIntentStates.delete(userId);
        console.log(`🗑️ [INTENT] Cleared state for user ${userId}`);
    }
}

// Analyze intent using LLM
async function analyzeIntentWithLLM(userMessage, apiKey, productNames = [], conversationHistory = []) {
    if (!apiKey) {
        console.warn('⚠️ [INTENT] No API key for intent analysis - using fallback');
        return analyzeIntentFallback(userMessage, productNames);
    }
    
    const productList = productNames.join(', ');
    const historyContext = conversationHistory.slice(-3).map(msg => 
        `${msg.sender}: ${msg.text}`
    ).join('\n');
    
    const prompt = `You are an intent analyzer for a health supplement chatbot. Analyze the user's message and extract structured information.

Available products: ${productList}

Previous conversation:
${historyContext || 'No previous messages'}

Current message: "${userMessage}"

Analyze and return ONLY valid JSON with this structure:
{
    "intent": "<intent_type>",
    "confidence": <0-1>,
    "detectedProduct": "<product_name or null>",
    "detectedLocation": "<location or null>",
    "detectedCurrency": "<currency code or null>",
    "isFollowUp": <true/false>,
    "missingInfo": ["<what_info_needed>"],
    "shouldSwitchIntent": <true/false>,
    "reasoning": "<brief explanation>"
}

Intent types:
- product_info: asking about benefits, ingredients, suitability, what is
- price_check: asking about price, cost, how much
- store_locator: asking where to buy, store locations
- purchase_intent: wants to buy, order, get the product
- comparison: comparing products
- recommendation: asking for suggestions
- general_inquiry: greeting, thanks, or unclear

Rules:
1. If message mentions a product name from the list, set detectedProduct
2. If message mentions location (city, area, country), set detectedLocation
3. If message mentions currency (MYR, SGD, etc.) or country for pricing, set detectedCurrency
4. If this seems like a follow-up to previous conversation, set isFollowUp=true
5. List missing info needed to fulfill the intent (e.g., need product, need location)
6. If user switches topic completely, set shouldSwitchIntent=true`;

    try {
        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { 
                        role: 'system', 
                        content: 'You are an intent analyzer. Return ONLY valid JSON, no extra text.' 
                    },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.1,
                max_tokens: 300
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                timeout: 15000
            }
        );
        
        const content = response.data.choices[0].message.content.trim();
        console.log(`🤖 [INTENT] LLM analysis: ${content.substring(0, 200)}...`);
        
        // Parse JSON response
        try {
            // Remove markdown code blocks if present
            const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const result = JSON.parse(jsonStr);
            
            // Validate required fields
            if (!result.intent || !result.confidence) {
                console.warn('⚠️ [INTENT] Invalid LLM response structure');
                return analyzeIntentFallback(userMessage, productNames);
            }
            
            return result;
        } catch (parseErr) {
            console.error('❌ [INTENT] Failed to parse LLM JSON:', parseErr.message);
            return analyzeIntentFallback(userMessage, productNames);
        }
    } catch (err) {
        console.error('❌ [INTENT] LLM API error:', err.message);
        return analyzeIntentFallback(userMessage, productNames);
    }
}

// Fallback intent analysis (keyword-based)
function analyzeIntentFallback(userMessage, productNames = []) {
    const msg = userMessage.toLowerCase();
    
    // Detect product
    let detectedProduct = null;
    for (const productName of productNames) {
        if (msg.includes(productName.toLowerCase())) {
            detectedProduct = productName;
            break;
        }
    }
    
    // Detect location
    const locationPatterns = /\b(kl|kuala lumpur|pj|petaling jaya|subang|shah alam|penang|johor|singapore|malaysia|near|area|location)\b/i;
    const detectedLocation = locationPatterns.test(msg) ? extractLocation(msg) : null;
    
    // Detect currency
    const currencyMatch = msg.match(/\b(myr|rm|sgd|usd|bnd|hkd|idr|twd)\b/i);
    const detectedCurrency = currencyMatch ? currencyMatch[0].toUpperCase().replace('RM', 'MYR') : null;
    
    // Determine intent
    let intent = INTENT_TYPES.GENERAL_INQUIRY;
    const missingInfo = [];
    
    if (/\b(price|cost|how much|money|expensive|cheap)\b/.test(msg)) {
        intent = INTENT_TYPES.PRICE_CHECK;
        if (!detectedProduct) missingInfo.push('product');
    } else if (/\b(where|buy|store|shop|location|near|area|address)\b/.test(msg)) {
        intent = INTENT_TYPES.STORE_LOCATOR;
        if (!detectedProduct) missingInfo.push('product');
        if (!detectedLocation) missingInfo.push('location');
    } else if (/\b(buy|order|purchase|get|want|need)\b/.test(msg)) {
        intent = INTENT_TYPES.PURCHASE_INTENT;
        if (!detectedProduct) missingInfo.push('product');
    } else if (/\b(what|benefit|ingredient|suitable|for|help|work)\b/.test(msg)) {
        intent = INTENT_TYPES.PRODUCT_INFO;
        if (!detectedProduct) missingInfo.push('product');
    } else if (/\b(compare|vs|versus|difference|better)\b/.test(msg)) {
        intent = INTENT_TYPES.COMPARISON;
    } else if (/\b(recommend|suggest|best|which one)\b/.test(msg)) {
        intent = INTENT_TYPES.RECOMMENDATION;
    }
    
    return {
        intent,
        confidence: 0.7,
        detectedProduct,
        detectedLocation,
        detectedCurrency,
        isFollowUp: false,
        missingInfo,
        shouldSwitchIntent: true,
        reasoning: 'Fallback keyword-based analysis'
    };
}

// Extract location from text (simple version)
function extractLocation(text) {
    const locationKeywords = [
        'kl', 'kuala lumpur', 'pj', 'petaling jaya', 'subang jaya', 'shah alam',
        'penang', 'johor bah ru', 'singapore', 'malaysia', 'selangor'
    ];
    
    for (const loc of locationKeywords) {
        if (text.toLowerCase().includes(loc)) {
            return loc;
        }
    }
    
    return null;
}

// Process message with state machine
async function processIntent(userMessage, userId, apiKey, productNames = [], conversationHistory = []) {
    const state = getUserState(userId);
    
    if (!state) {
        console.log('⚠️ [INTENT] No user state (no userId), using stateless processing');
        return await analyzeIntentWithLLM(userMessage, apiKey, productNames, conversationHistory);
    }
    
    console.log(`🧠 [INTENT] Processing message in state: ${state.currentState}`);
    
    // Analyze intent
    const analysis = await analyzeIntentWithLLM(userMessage, apiKey, productNames, conversationHistory);
    console.log(`🎯 [INTENT] Detected: ${analysis.intent}, Product: ${analysis.detectedProduct || 'none'}, Location: ${analysis.detectedLocation || 'none'}`);
    
    // Update state based on current state and new analysis
    const transitionResult = handleStateTransition(state, analysis, userMessage);
    
    // Update timestamp
    state.lastUpdated = Date.now();
    
    return {
        ...analysis,
        state: state.currentState,
        context: { ...state.context },
        action: transitionResult.action,
        shouldExecute: transitionResult.shouldExecute
    };
}

// Handle state transitions
function handleStateTransition(state, analysis, userMessage) {
    const { currentState, context, pendingIntent } = state;
    let action = 'continue';
    let shouldExecute = false;
    
    switch (currentState) {
        case STATES.IDLE:
            if (analysis.missingInfo.length > 0) {
                // Need more info before executing
                if (analysis.missingInfo.includes('product')) {
                    state.currentState = STATES.AWAITING_PRODUCT;
                    state.pendingIntent = {
                        type: analysis.intent,
                        timestamp: Date.now(),
                        expiresAt: Date.now() + 120000 // 2 minutes
                    };
                    action = 'ask_for_product';
                } else if (analysis.missingInfo.includes('location')) {
                    state.currentState = STATES.AWAITING_LOCATION;
                    state.pendingIntent = {
                        type: analysis.intent,
                        timestamp: Date.now(),
                        expiresAt: Date.now() + 120000
                    };
                    action = 'ask_for_location';
                }
            } else {
                // Have all info, execute immediately
                updateContext(state, analysis);
                state.currentState = STATES.ACTIVE_EVALUATION;
                shouldExecute = true;
                action = 'execute';
            }
            break;
            
        case STATES.AWAITING_PRODUCT:
            if (analysis.detectedProduct) {
                // Got the product, now check if we have everything
                updateContext(state, { ...analysis, product: analysis.detectedProduct });
                
                if (pendingIntent) {
                    // Combine with pending intent
                    const combinedAnalysis = {
                        ...pendingIntent,
                        detectedProduct: analysis.detectedProduct,
                        detectedLocation: analysis.detectedLocation,
                        detectedCurrency: analysis.detectedCurrency || pendingIntent.detectedCurrency
                    };
                    
                    // Check if still missing info
                    const stillMissing = [];
                    if (combinedAnalysis.intent === INTENT_TYPES.STORE_LOCATOR && !combinedAnalysis.detectedLocation) {
                        stillMissing.push('location');
                    }
                    
                    if (stillMissing.length > 0) {
                        if (stillMissing.includes('location')) {
                            state.currentState = STATES.AWAITING_LOCATION;
                            action = 'ask_for_location';
                        }
                    } else {
                        state.currentState = STATES.ACTIVE_EVALUATION;
                        shouldExecute = true;
                        action = 'execute';
                    }
                } else {
                    state.currentState = STATES.ACTIVE_EVALUATION;
                    shouldExecute = true;
                    action = 'execute';
                }
            } else {
                // Still no product, ask again
                action = 'ask_for_product';
            }
            break;
            
        case STATES.AWAITING_LOCATION:
            if (analysis.detectedLocation) {
                updateContext(state, { ...analysis, location: analysis.detectedLocation });
                
                if (pendingIntent) {
                    const combinedAnalysis = {
                        ...pendingIntent,
                        detectedProduct: context.product,
                        detectedLocation: analysis.detectedLocation,
                        detectedCurrency: analysis.detectedCurrency || pendingIntent.detectedCurrency
                    };
                    state.currentState = STATES.ACTIVE_EVALUATION;
                    shouldExecute = true;
                    action = 'execute';
                } else {
                    state.currentState = STATES.ACTIVE_EVALUATION;
                    shouldExecute = true;
                    action = 'execute';
                }
            } else {
                // Still no location, ask again
                action = 'ask_for_location';
            }
            break;
            
        case STATES.ACTIVE_EVALUATION:
            // User can switch intents while keeping product context
            if (analysis.shouldSwitchIntent || analysis.detectedProduct) {
                if (analysis.detectedProduct) {
                    updateContext(state, analysis);
                }
                
                if (analysis.missingInfo.length > 0) {
                    if (analysis.missingInfo.includes('location')) {
                        state.currentState = STATES.AWAITING_LOCATION;
                        state.pendingIntent = {
                            type: analysis.intent,
                            timestamp: Date.now(),
                            expiresAt: Date.now() + 120000
                        };
                        action = 'ask_for_location';
                    } else if (analysis.missingInfo.includes('product')) {
                        state.currentState = STATES.AWAITING_PRODUCT;
                        state.pendingIntent = {
                            type: analysis.intent,
                            timestamp: Date.now(),
                            expiresAt: Date.now() + 120000
                        };
                        action = 'ask_for_product';
                    }
                } else {
                    shouldExecute = true;
                    action = 'execute';
                }
            } else {
                shouldExecute = true;
                action = 'execute';
            }
            break;
    }
    
    // Log state transition
    console.log(`🔄 [INTENT] State transition: ${currentState} → ${state.currentState}, Action: ${action}, Execute: ${shouldExecute}`);
    
    return { action, shouldExecute };
}

// Update context with new information
function updateContext(state, analysis) {
    if (analysis.detectedProduct) {
        state.context.product = analysis.detectedProduct;
    }
    if (analysis.detectedLocation) {
        state.context.location = analysis.detectedLocation;
    }
    if (analysis.detectedCurrency) {
        state.context.currency = analysis.detectedCurrency;
    }
    state.context.lastAction = analysis.intent;
}

// Generate response based on action
function generateActionResponse(action, intent, context) {
    switch (action) {
        case 'ask_for_product':
            return {
                text: `I'd be happy to help you with that! 😊 Which product are you interested in?\n\nAvailable products: BioNatto Plus, GlucoPal, AshiSlim Plus, Men Guard Capsule, and more.`,
                shouldContinue: false
            };
            
        case 'ask_for_location':
            return {
                text: `To find the nearest stores, please tell me your location. For example: "near Subang Jaya" or "I'm in KL" 📍`,
                shouldContinue: false
            };
            
        case 'execute':
            return {
                text: null,
                shouldContinue: true
            };
            
        default:
            return {
                text: null,
                shouldContinue: true
            };
    }
}

module.exports = {
    getUserState,
    clearUserState,
    analyzeIntentWithLLM,
    processIntent,
    generateActionResponse,
    STATES,
    INTENT_TYPES
};