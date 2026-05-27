# Dyna-Nutrition WhatsApp & Messenger Bot v5.0

A sophisticated multi-platform chatbot for Dyna-Nutrition with AI-powered responses using DeepSeek API, featuring live website search, product lookup, price checking, store location services, human agent handoff capabilities, and intelligent multi-language support.

**Platforms Supported:** WhatsApp Web, Facebook Messenger

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture & Design](#architecture--design)
- [Message Flow](#message-flow)
- [Project Structure](#project-structure)
- [Setup Instructions](#setup-instructions)
- [Environment Configuration](#environment-configuration)
- [Commands](#commands)
- [API Reference](#api-reference)
- [Dependencies](#dependencies)
- [Troubleshooting](#troubleshooting)
- [Security Considerations](#security-considerations)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

This bot serves as an intelligent customer service assistant for Dyna-Nutrition, handling inquiries about health supplements across multiple Southeast Asian markets (Singapore, Malaysia, Indonesia, Thailand, Philippines, Vietnam). It uses a **three-tier LLM-powered routing system** to intelligently direct user queries to specialized handlers:

1. **Price Queries** → Real-time WooCommerce API integration with multi-currency support
2. **Store Locator** → MLP API for retail location data with geographic filtering
3. **Marketplace Queries** → Guidance for online purchasing (Lazada, Shopee, TikTok, official website)
4. **General Questions** → DeepSeek AI with knowledge base, web search, and internet search fallback

The bot maintains conversation context across sessions, supports 6+ languages through real-time translation, and seamlessly escalates to human agents when needed.

### Version History

- **v5.0** (Current): Multi-platform support (WhatsApp + Messenger), LLM-based message chunking, quick reply buttons, enhanced translation
- **v4.x**: Added context manager for follow-up queries, improved human handoff
- **v3.x**: Introduced LLM-based intent routing
- **v2.x**: Added web scraping and price API integration
- **v1.x**: Initial WhatsApp bot with basic responses

---

## Key Features

### Core Capabilities

| Feature | Description | Platform |
|---------|-------------|----------|
| **AI-Powered Responses** | Intelligent conversation handling via DeepSeek API with context awareness | Both |
| **Live Website Search** | Real-time scraping of dyna-nutrition.com for up-to-date product information | Both |
| **Product Information Lookup** | Access to local knowledge base and product configurations | Both |
| **Multi-Currency Price Checking** | Integration with WooCommerce API supporting SGD, MYR, IDR, THB, PHP, VND | Both |
| **Store Locator** | Find nearby retail stores in Malaysia/Singapore with LLM-based location filtering | Both |
| **Marketplace Guidance** | Direct users to online marketplaces (Lazada, Shopee, TikTok, official site) | Both |
| **Human Agent Handoff** | Seamless escalation to human representatives with working hours detection | Both |
| **Persistent Memory** | Conversation history and product tracking per user (180-day retention) | Both |
| **Contact Caching** | Efficient phone number/Facebook name storage for returning users | Both |
| **Quick Reply Buttons** | Dynamic translated buttons for Price, Buy Online, Retail Store | Messenger |
| **Multi-Language Support** | Real-time translation to/from Chinese, Malay, Indonesian, Thai, Vietnamese | Both |

### Smart Features

- **Working Hours Detection**: Automatically informs users outside business hours before escalation (Mon-Fri, 9 AM - 5 PM SGT)
- **Session Management**: Track and manage active human agent sessions with auto-expiry (24 hours)
- **LLM Message Chunking**: Automatic splitting of long messages into semantic chunks for WhatsApp compatibility (max 450 chars/chunk)
- **Auto-Reconnect**: Exponential backoff retry logic for connection stability (max 5 attempts, 5s-25s delays)
- **Rate Limiting**: Built-in 2-second cooldown per user to prevent message flooding
- **Context-Aware Follow-ups**: Maintains conversation context for 60 days to handle follow-up questions like "Price?" or "How about Malaysia?"
- **Product Mention Tracking**: Remembers products mentioned in general conversation for future queries
- **Language Detection**: LLM-based language detection (no hardcoded patterns) supporting any language
- **Markdown Stripping**: Automatic removal of markdown formatting for platform compatibility
- **File Watching**: Auto-reload knowledge base when JSON files change

### Intent Routing Categories

The bot recognizes four distinct intent types:

| Intent | Trigger Examples | Handler |
|--------|------------------|---------|
| **price** | "How much?", "What's the cost?", "Price in MYR" | `priceApi.js` |
| **store** | "Where to buy near KL?", "Stores in Singapore", "Pharmacy near JB" | `storeLocator.js` |
| **marketplace** | "Buy on Lazada", "Shopee official store", "How to order online" | `deepseek.js` |
| **general** | "What are the benefits?", "Dosage?", "Shipping info" | `deepseek.js` |

---

## Architecture & Design

### System Components Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    Platform Layer                                │
│  ┌──────────────────────┐    ┌──────────────────────────────┐   │
│  │  WhatsApp Web Client │    │  Facebook Messenger Express  │   │
│  │  (whatsapp-web.js)   │    │  Server (webhook-based)      │   │
│  └──────────┬───────────┘    └──────────────┬───────────────┘   │
└─────────────┼────────────────────────────────┼──────────────────┘
              │                                │
              └────────────┬───────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Message Handler Layer                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Command      │  │ Human Mode   │  │ Rate Limit   │          │
│  │ Processor    │  │ Check        │  │ & Cooldown   │          │
│  │ (!bot,!status│  │ (session     │  │ (2s per      │          │
│  │ !close)      │  │ management)  │  │ user)        │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    LLM-Based Intent Router                       │
│              (DeepSeek API with Conversation History)            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Analyzes: intent, product, currency, location, context   │   │
│  │ Supports: price, store, marketplace, general             │   │
│  └──────────────────────────────────────────────────────────┘   │
└────────────┬──────────────────────┬─────────────────┬───────────┘
             │                      │                 │
     ┌───────▼───────┐    ┌────────▼───────┐ ┌──────▼──────┐
     │  Price API    │    │ Store Locator  │ │  DeepSeek   │
     │   Handler     │    │    Handler     │ │  (General)  │
     └───────┬───────┘    └────────┬───────┘ └──────┬──────┘
             │                     │                │
             ▼                     ▼                ▼
┌────────────────────┐  ┌─────────────────┐ ┌──────────────────┐
│ WooCommerce API    │  │  MLP Store API  │ │ Knowledge Base   │
│ (Real-time Prices) │  │ (Store Data)    │ │ + Web Scraping   │
│ Multi-currency     │  │ Location filter │ │ + DuckDuckGo     │
└────────────────────┘  └─────────────────┘ └──────────────────┘
```

### Design Patterns Used

1. **Strategy Pattern**: Different response strategies (price, store, marketplace, general) selected at runtime based on LLM-detected intent
2. **Factory Pattern**: Dynamic module loading for human handoff (`delete require.cache`) to ensure fresh state
3. **Observer Pattern**: Event-driven WhatsApp client with listeners for QR, ready, disconnected, message events
4. **Repository Pattern**: Centralized data access for memory, context, and contact cache
5. **Circuit Breaker Pattern**: Retry logic with exponential backoff (1s, 2s, 4s) for external API calls
6. **Singleton Pattern**: Shared client instance and session state across modules
7. **Decorator Pattern**: Translation layer wraps all responses for multi-language support
8. **State Machine**: Human handoff sessions with states (bot, human, human_complete, agent_closed)

### Tech Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Node.js 16+ | JavaScript runtime |
| WhatsApp Client | whatsapp-web.js ^1.23.0 | WhatsApp Web automation |
| Messenger Server | Express ^4.18.2 | Webhook server for Facebook |
| HTTP Client | Axios ^1.6.0 | API requests and web scraping |
| HTML Parser | Cheerio ^1.0.0-rc.12 | Web scraping DOM manipulation |
| LLM Provider | DeepSeek API | Intent analysis, translation, responses |
| Environment | dotenv ^16.3.1 | Configuration management |
| QR Display | qrcode-terminal ^0.12.0 | WhatsApp authentication |
| Dev Tool | nodemon ^3.0.1 | Development auto-reload |

---

## Message Flow

### Detailed Request Lifecycle

#### 1. **Incoming Message Processing**

**WhatsApp** (`bot/whatsappBot.js`):
```javascript
// Timeline: 0-50ms
1. Extract message body and sender ID (from msg.from)
2. Cache contact phone number from WhatsApp metadata
3. Check for special commands (!bot, !status, !close, !closeall)
4. Verify user is not in human mode
5. Apply rate limiting (2s cooldown per user)
6. Send typing indicator to chat
```

**Messenger** (`bot/messengerBot.js`):
```javascript
// Timeline: 0-50ms
1. Receive webhook POST from Facebook
2. Extract sender PSID and message text
3. Fetch and cache Facebook user name via Graph API
4. Check for admin commands (!status, !close, !escalate, !closeall)
5. Verify user is not in human mode
6. Apply rate limiting (2s cooldown)
```

#### 2. **Quick Action Handling** (Button Clicks)

For Messenger button clicks or WhatsApp quick replies:
```javascript
1. Detect button response ("1", "2", "3" or translated variants)
2. Get conversation history for language detection
3. Translate button template to user's language:
   - "May I know the price?" → "我可以知道价格吗？"
4. Pass translated message to normal routing flow
5. Handle based on detected intent (price/store/general)
```

#### 3. **Intent Analysis** (`services/messageRouter.js`)

```javascript
// Timeline: 50-15000ms (depends on LLM response)
1. Build conversation context from last 10-20 messages
2. Retrieve stored context (last price product, pending store product)
3. Call DeepSeek API with prompt including:
   - User message
   - Conversation history
   - Existing context
   - Product/currency/location detection instructions
4. Parse JSON response: { intent, product, currency, location, needsMoreInfo }
5. Fallback to keyword-based detection if LLM fails
6. Update context manager with detected entities
```

Example LLM prompt structure:
```
CONVERSATION HISTORY (last 10 messages):
User: "What is BioNatto?"
Bot: "BioNatto is a natural..."
User: "How much in Malaysia?"
---

CURRENT MESSAGE: "Price?"

EXISTING CONTEXT:
- Last product user asked about for price: bionatto
- Last currency used: MYR
- Last product user mentioned: bionatto

TASK: Determine INTENT and extract relevant information.
Return JSON: { intent, product, currency, location, needsMoreInfo, reasoning }
```

#### 4. **Handler Execution**

**Price Query Flow** (`services/priceApi.js`):
```
Product Name → Slug Normalization → WooCommerce API → LLM Parsing → Format Response
     │                │                    │                │              │
     │                │                    │                │              └─► Currency symbol
     │                │                    │                │                  (RM, S$, Rp, etc.)
     │                │                    │                │
     │                │                    │                └─► Separate regular vs subscription
     │                │                    │
     │                │                    └─► GET /wp-json/woo-country-price/v1/product-data
     │                │                           ?product_slug={slug}&country_code={code}
     │                │
     │                └─► Map "Men Guard" → "men-guard-capsule" (verified against API)
     │
     └─► Extract from message or conversation history

Translation Layer (if needed):
English Response → translateWithHistory() → User's Language
```

**Store Locator Flow** (`services/storeLocator.js`):
```
User Message → LLM Intent Analysis → Product + Location Extraction
                                          │
                                          ├─► No product? → Ask user
                                          ├─► No location? → Ask user
                                          └─► Have both? → Fetch Stores
                                                  │
                                                  ▼
                                         MLP API: /wp-json/mlp-api/v1/stores?product={slug}
                                                  │
                                                  ▼
                                    LLM Classification: Is location supported? (Malaysia/Singapore)
                                                  │
                                                  ├─► Unsupported → Inform user
                                                  └─► Supported → Filter by location
                                                          │
                                                          ▼
                                                 Clean addresses → Format list → Translate
```

**Marketplace Query Flow** (handled in `services/deepseek.js`):
```
User Message → Detect Marketplace Intent → Provide Platform Links
     │
     ├─► "Buy on Lazada" → Link to Lazada official store
     ├─► "Shopee" → Link to Shopee official store
     ├─► "TikTok" → Link to TikTok shop
     └─► "Official website" → Link to dyna-nutrition.com

Response includes:
- Platform-specific purchase links
- Shipping information
- Payment methods
```

**General Query Flow** (`services/deepseek.js`):
```
User Message → Build Knowledge Prompt → DeepSeek API
                                              │
                              ┌───────────────┴───────────────┐
                              │                               │
                     Confident Response           Uncertain ("don't know")
                              │                               │
                              │                       Extract Keywords (LLM)
                              │                               │
                              │                       ┌───────┴───────┐
                              │                       │               │
                              │               Website Search    Internet Search
                              │               (dyna-nutrition)   (DuckDuckGo)
                              │                       │               │
                              │                       └───────┬───────┘
                              │                               │
                              └───────────────┬───────────────┘
                                              │
                                      Final Response + Optional Image
                                              │
                                              ▼
                                      Translate to User's Language
```

#### 5. **Response Delivery**

```javascript
// Timeline: After handler completes
1. Clear typing indicator
2. Strip markdown formatting (bold, italic, headers, links, code blocks)
3. Check message length
4. If >450 chars:
   - Call LLM to split into semantic chunks (max 450 chars each)
   - Preserve bullet points, lists, and content block integrity
   - Send each chunk with 800ms delay
5. Add message to conversation history (utils/memory.js)
6. Log transaction
```

### State Management

#### Conversation Memory (`utils/memory.js`)
- **Storage**: JSON file (`conversations.json`)
- **Structure**:
  ```json
  {
    "6591234567@c.us": {
      "messages": [
        {"role": "user", "content": "What is BioNatto?"},
        {"role": "assistant", "content": "BioNatto is..."}
      ],
      "shownProducts": ["bionatto"],
      "lastActive": 1704067200000
    }
  }
  ```
- **Limits**: Max 20 messages per user, max 1000 users
- **Expiry**: 180 days of inactivity
- **Features**: Product mention tracking, automatic cleanup

#### Context Manager (`services/contextManager.js`)
- **Purpose**: Track entities for follow-up questions
- **TTL**: 60 days
- **Fields**:
  - `lastPriceProduct`: Last product asked about for price
  - `lastPriceCurrency`: Currency used in last price query
  - `pendingStoreProduct`: Product for incomplete store query
  - `lastMentionedProduct`: Any product mentioned in conversation
- **Use Case**: Enables queries like "Price?" to use previous product context

#### Human Handoff (`utils/humanHandoff.js`)
- **Storage**: JSON file (`human_sessions.json`)
- **States**:
  - `bot`: Normal AI operation
  - `human`: Escalated to human agent
  - `human_complete`: User ended session
  - `agent_closed`: Admin closed session
- **Auto-return**: 24 hours of silence
- **Platform Support**:
  - WhatsApp: Identified by phone number
  - Messenger: Identified by Facebook name + PSID
- **Working Hours**: Mon-Fri, 9 AM - 5 PM SGT (configurable)

#### Contact Cache (`utils/contactCache.js`)
- **WhatsApp**: Maps user ID → phone number
- **Messenger**: Maps PSID → Facebook name, plus reverse lookup (name → PSID)
- **Persistence**: JSON file (`contact_cache.json`)
- **Use Case**: Enables `!close John Smith` command for Messenger

---

---

## Project Structure

```
/workspace
├── index.js                     # Main entry point, env validation, platform routing
├── package.json                 # Dependencies and scripts
├── .env                         # Environment variables (see Environment Configuration)
│
├── bot/
│   ├── whatsappBot.js           # WhatsApp Web client, message handler, command processor
│   ├── messengerBot.js          # Facebook Messenger webhook server, Graph API integration
│   └── quickReplyButtons.js     # Dynamic translated quick reply buttons (Messenger)
│
├── config/
│   ├── botConfig.js             # Web scraping config, templates, retry logic
│   ├── knowledgeBase.json       # Static Q&A pairs, product info, guidelines
│   ├── storeLocatorConfig.json  # Store locator regions and settings
│   ├── brochures/               # PDF brochure files (JSON/TXT format)
│   └── products/                # Product-specific JSON configurations
│
├── services/
│   ├── messageRouter.js         # LLM-based intent detection (price/store/marketplace/general)
│   ├── deepseek.js              # General AI responses with fallback cascade (web/internet search)
│   ├── priceApi.js              # WooCommerce price lookup, multi-currency, slug normalization
│   ├── storeLocator.js          # MLP API integration, LLM location classification
│   ├── contextManager.js        # Conversation context tracking (60-day TTL)
│   └── knowledgeLoader.js       # Load knowledge base from JSON with file watching
│
├── utils/
│   ├── memory.js                # Persistent conversation history (180-day retention)
│   ├── contactCache.js          # Phone number/Facebook name caching
│   ├── humanHandoff.js          # Human agent session management (multi-platform)
│   ├── keepAlive.js             # Heartbeat utility for hosting platforms
│   ├── llmMessageSplitter.js    # Intelligent LLM-based message chunking (max 450 chars)
│   ├── translateWithHistory.js  # Multi-language translation using DeepSeek API
│   ├── brochures.js             # Brochure content extraction from JSON/TXT files
│   └── stripMarkdown.js         # Remove markdown formatting for platform compatibility
│
├── session-data/                # WhatsApp authentication (auto-generated, persistent)
├── conversations.json           # User conversation history (auto-generated)
├── human_sessions.json          # Active human sessions (auto-generated)
└── contact_cache.json           # Cached contact information (auto-generated)
```

### Module Responsibilities

| Module | Responsibility | Key Functions |
|--------|----------------|---------------|
| `index.js` | Application bootstrap, platform selection | `validateEnv()`, `startWhatsApp()`, `startMessenger()` |
| `whatsappBot.js` | WhatsApp Web automation | QR handling, message events, typing indicators |
| `messengerBot.js` | Facebook Messenger webhooks | Webhook verification, PSID handling, Graph API |
| `messageRouter.js` | Intent classification | `analyzeIntent()`, `routeMessage()` |
| `priceApi.js` | Real-time pricing | `getPriceResponse()`, slug normalization |
| `storeLocator.js` | Store location lookup | `getStoreResponse()`, LLM location filtering |
| `deepseek.js` | General Q&A | `generateResponse()`, keyword extraction, web scraping |
| `contextManager.js` | Follow-up context | `getContext()`, `updatePriceContext()` |
| `memory.js` | Conversation history | `getHistory()`, `addMessage()`, product tracking |
| `humanHandoff.js` | Escalation management | `isHumanMode()`, `setHumanMode()`, session cleanup |
| `translateWithHistory.js` | Multi-language support | `translateWithHistory()` |
| `llmMessageSplitter.js` | Message chunking | `splitIntoChunks()`, semantic splitting |

---

## Setup Instructions

### Prerequisites

- **Node.js**: Version 16 or higher
- **npm/yarn**: Package manager
- **WhatsApp Account**: For QR code authentication (WhatsApp platform only)
- **Facebook Developer Account**: For Messenger platform (create app, get Page Access Token)
- **DeepSeek API Key**: Obtain from [platform.deepseek.com](https://platform.deepseek.com/)
- **Hosting Platform** (optional): Vercel, Railway, Heroku, or similar for 24/7 deployment

### Installation

1. **Clone and install dependencies**
   ```bash
   npm install
   ```

2. **Create environment file**
   ```bash
   cp .env.example .env
   ```
   
   Or create `.env` manually:
   ```bash
   touch .env
   ```

3. **Configure environment variables**
   
   See [Environment Configuration](#environment-configuration) below for complete list.

4. **Start the bot**
   ```bash
   npm start
   ```
   
   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

5. **Platform-specific setup**
   
   **WhatsApp:**
   - Scan QR code when prompted to link your WhatsApp account
   - Session data will be saved in `./session-data/`
   
   **Messenger:**
   - Configure Facebook App webhook URL: `https://your-domain.com/webhook`
   - Set verify token matching your `.env` VERIFY_TOKEN
   - Subscribe to page events: `messages`, `messaging_postbacks`

6. **Deploy to hosting platform** (optional)
   
   **Vercel:**
   ```bash
   vercel deploy
   ```
   
   **Railway:**
   ```bash
   railway up
   ```
   
   Ensure environment variables are set in the hosting platform dashboard.

---

## Environment Configuration

Create a `.env` file in the root directory with the following variables:

### Required Variables

```env
# DeepSeek API Configuration
DEEPSEEK_API_KEY=your_deepseek_api_key_here

# Platform Selection: 'whatsapp' or 'messenger'
PLATFORM=messenger

# Server Configuration
PORT=3000
```

### Messenger-Specific Variables

```env
# Facebook Messenger Configuration
PAGE_ACCESS_TOKEN=EAAxxxxxxxxxxxxxx
VERIFY_TOKEN=your_custom_verify_token
```

### Optional Variables

```env
# Hosting Platform URLs (for heartbeat)
VERCEL_URL=https://your-app.vercel.app
RAILWAY_STATIC_URL=https://your-app.railway.app
```

### Environment Variable Details

| Variable | Required For | Description | Example |
|----------|--------------|-------------|---------|
| `DEEPSEEK_API_KEY` | Both | DeepSeek API key for LLM operations | `sk-abc123...` |
| `PLATFORM` | Both | Select platform: `whatsapp` or `messenger` | `messenger` |
| `PORT` | Both | HTTP server port (Messenger only) | `3000` |
| `PAGE_ACCESS_TOKEN` | Messenger | Facebook Page Access Token | `EAA...` |
| `VERIFY_TOKEN` | Messenger | Webhook verification token | `mytoken123` |
| `VERCEL_URL` | Optional | Vercel deployment URL for heartbeat | `https://app.vercel.app` |
| `RAILWAY_STATIC_URL` | Optional | Railway deployment URL for heartbeat | `https://app.railway.app` |

### Security Best Practices

- **Never commit `.env` to version control** - Add to `.gitignore`
- **Use strong, random tokens** for VERIFY_TOKEN
- **Rotate API keys** periodically
- **Use environment-specific variables** for staging/production
- **Restrict Page Access Token permissions** to minimum required

---

2. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```

3. **Edit `.env` and add your DeepSeek API key**
   ```env
   DEEPSEEK_API_KEY=your_api_key_here
   ```

4. **Start the bot**
   ```bash
   npm start
   ```
   
   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

5. **Scan QR code** when prompted to link your WhatsApp account

---

## Commands

### User Commands

| Command | Platform | Description |
|---------|----------|-------------|
| `!bot` | WhatsApp | Switch back to bot mode (exit human agent session) |
| Quick Reply Buttons (1, 2, 3) | Messenger | Click buttons for Price, Buy Online, Retail Store |

### Admin Commands

| Command | Platform | Description |
|---------|----------|-------------|
| `!status` | Both | View all active human agent sessions with details |
| `!close <value>` | Both | Close a specific session (phone for WhatsApp, name for Messenger) |
| `!closeall` | Both | Close all active human sessions |
| `!escalate` | Messenger | Escalate user to human agent (alternative to keywords) |

### Example Admin Workflow

```
Admin: !status
Bot: 📋 Active human sessions (3):
     📱 [1] 6591234567 (whatsapp)
        Agent: default
        Last: 5 min ago
        Command: !close 6591234567
     
     📱 [2] John Smith (messenger)
        Agent: escalation
        Last: 12 min ago
        Command: !close John Smith
     
     Copy the command above to close a session.

Admin: !close 6591234567
Bot: ✅ Session closed for 6591234567. Bot active.
```

---

## API Reference

### Internal Modules

#### `services/messageRouter.routeMessage(userMessage, userId, phoneNumber, apiKey, history)`

Analyzes user intent and routes to appropriate handler.

**Returns**:
```javascript
{
  handler: 'priceApi' | 'storeLocator' | 'deepseek',
  params: {
    productName: string | null,
    currency: string | null,
    location: string | null,
    phoneNumber: string
  }
}
```

#### `services/priceApi.getPriceResponse(productName, phoneNumber, apiKey, currentMessage, forcedCurrency)`

Fetches real-time pricing from WooCommerce API.

**Returns**: Parsed price object with regular prices and subscriptions, translated to user's language

#### `services/storeLocator.getStoreResponse(userMessage, apiKey, routeParams, currentMessage)`

Finds retail stores for a product in a specified location.

**Returns**:
```javascript
{
  success: boolean,
  text: string,
  needsLocation: boolean,
  stores: array,
  noStoresInArea: boolean
}
```

#### `services/deepseek.generateResponse(userMessage, userId, apiKey, history, routeParams, productName)`

Generates AI response with fallback cascade.

**Returns**:
```javascript
{
  text: string,
  imageUrl: string | null,
  productName: string | null
}
```

#### `utils/translateWithHistory.translateWithHistory(englishText, currentMessage, preserveItems, apiKey)`

Translates English response to match user's language.

**Returns**: Translated string (or original if translation fails)

#### `utils/llmMessageSplitter.splitIntoChunks(text, apiKey)`

Splits long message into semantic chunks for WhatsApp/Messenger.

**Returns**: Array of strings (each ≤450 characters)

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `whatsapp-web.js` | ^1.23.0 | WhatsApp Web API client |
| `express` | ^4.18.2 | HTTP server for Messenger webhooks |
| `axios` | ^1.6.0 | HTTP requests for web scraping and APIs |
| `cheerio` | ^1.0.0-rc.12 | HTML parsing for web scraping |
| `dotenv` | ^16.3.1 | Environment variable management |
| `qrcode-terminal` | ^0.12.0 | QR code display for WhatsApp authentication |
| `nodemon` | ^3.0.1 | Development auto-reload (devDependencies) |

### Peer Dependencies

- **DeepSeek API**: Required for all LLM operations (intent analysis, translation, responses)
- **Facebook Graph API**: Required for Messenger platform (user profile fetching)
- **WooCommerce API**: Used by Dyna-Nutrition for product pricing
- **MLP API**: Used by Dyna-Nutrition for store locator data

---

## Troubleshooting

### Common Issues

**QR Code not appearing** (WhatsApp only)
- Ensure terminal supports ASCII rendering
- Check `puppeteer` installation: `npm install puppeteer`
- Try running with `headless: false` in whatsappBot.js for debugging

**API Key Error**
```
❌ DEEPSEEK_API_KEY missing in .env
```
- Verify `.env` file exists in root directory
- Check for typos in variable name
- Ensure no extra spaces or quotes around the key

**Webhook Verification Failed** (Messenger only)
- Ensure VERIFY_TOKEN matches in Facebook App settings and `.env`
- Check webhook URL is publicly accessible (use ngrok for local testing)
- Verify PAGE_ACCESS_TOKEN has correct permissions

**Connection Drops** (WhatsApp only)
- Bot auto-reconnects with exponential backoff (max 5 attempts)
- Session data persisted in `./session-data/`
- Try deleting `session-data/` folder and re-scanning QR

**Web Scraping Failures**
- Target website may be temporarily unavailable
- Retry logic handles transient errors (3 attempts with 1s, 2s, 4s delays)
- Check network connectivity and firewall rules

**Context Not Working**
- Check `conversations.json` file permissions
- Verify user ID format matches WhatsApp LID or Messenger PSID
- Ensure context hasn't expired (60-day TTL)

**Translation Issues**
- Verify DeepSeek API key is valid
- Check API rate limits (translation calls count toward quota)
- Fallback to English if translation fails

### Debug Mode

Add console logging by modifying service files or run with:
```bash
DEBUG=* npm start
```

### Monitoring

Key log patterns to watch:
- `[ROUTER]` - Intent detection and routing decisions
- `[PRICE API]` - WooCommerce API interactions
- `[STORE]` - Store locator operations
- `[HANDOFF]` - Human agent session changes
- `[MEMORY]` - Conversation history updates
- `[TRANSLATE]` - Translation operations
- `[MESSENGER]` - Messenger webhook events
- `[BOT]` - WhatsApp message handling

### Performance Tuning

- **Increase rate limit**: Modify `COOLDOWN_MS` in bot files (default 2000ms)
- **Adjust context TTL**: Change `CONTEXT_TTL` in contextManager.js (default 60 days)
- **Modify chunk size**: Adjust `MAX_CHUNK_SIZE` in llmMessageSplitter.js (default 450 chars)
- **Reduce retry attempts**: Change `maxRetries` in fetch functions (default 3)

---

## Security Considerations

- **API Keys**: Never commit `.env` file to version control
- **Session Data**: Stored locally in `./session-data/` - secure this directory
- **Phone Numbers**: Cached in memory and persisted in contact_cache.json
- **Facebook Names**: Stored in contact_cache.json for Messenger users
- **Rate Limiting**: Built-in 2-second cooldown between user messages
- **Input Validation**: All user inputs sanitized before API calls
- **Timeout Handling**: All external API calls have timeout limits (10-20 seconds)
- **Webhook Security**: Verify Facebook webhook signatures in production
- **Environment Isolation**: Use separate `.env` files for staging/production

---

## Contributing

### Code Style

- Use ESLint configuration (if available)
- Follow existing code patterns in the project
- Add comments for complex logic
- Use meaningful variable and function names

### Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Testing

Before submitting PR:
- Test on both WhatsApp and Messenger platforms
- Verify all intent types work correctly (price, store, marketplace, general)
- Test multi-language support
- Check human handoff functionality
- Verify admin commands work as expected

---

## License

Proprietary - Dyna-Nutrition

All rights reserved. Unauthorized use, distribution, or reproduction is prohibited.

---

## Support

For technical issues or feature requests, contact the development team.

**Common Contact Points:**
- GitHub Issues: [Link to repository issues]
- Email: [Development team email]
- Documentation: This README file

---

## Frequently Asked Questions (FAQ)

**Q: Can I use this bot for my own business?**
A: This bot is customized for Dyna-Nutrition. You would need to modify product slugs, API endpoints, knowledge base, and branding for your use case.

**Q: How do I add support for a new language?**
A: The translation system uses DeepSeek API and automatically detects language. No code changes needed - just ensure your DeepSeek API key has sufficient quota.

**Q: Can I run both WhatsApp and Messenger simultaneously?**
A: The current architecture supports one platform at a time via the `PLATFORM` environment variable. Running both would require architectural changes.

**Q: How do I add new products?**
A: Update the `PRODUCT_SLUG_MAP` in `priceApi.js` and `storeLocator.js`, and add product info to `config/knowledgeBase.json` or `config/products/`.

**Q: What happens if DeepSeek API is down?**
A: The bot has fallback mechanisms: keyword-based intent detection and cached responses. However, full functionality requires the API.

**Q: How do I change working hours for human handoff?**
A: Modify the `isWithinWorkingHours()` function in `utils/humanHandoff.js`.

---

## Changelog

### v5.0 (Current)
- Added Facebook Messenger platform support
- Implemented LLM-based message chunking (max 450 chars)
- Added dynamic quick reply buttons with translation
- Enhanced multi-language translation with history context
- Added marketplace intent detection
- Improved contact caching for cross-platform support
- Added module responsibilities documentation

### v4.x
- Added context manager for follow-up queries
- Improved human handoff with working hours detection
- Added conversation memory persistence
- Implemented product mention tracking

### v3.x
- Introduced LLM-based intent routing
- Added DeepSeek API integration
- Implemented web scraping fallback

### v2.x
- Added WooCommerce price API integration
- Implemented MLP store locator API
- Added multi-currency support

### v1.x
- Initial WhatsApp bot release
- Basic command processing
- Simple response templates

---