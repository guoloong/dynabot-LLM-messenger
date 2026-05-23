# Dyna-Nutrition WhatsApp Bot

A sophisticated WhatsApp chatbot for Dyna-Nutrition with AI-powered responses using DeepSeek API, featuring live website search, product lookup, price checking, store location services, and human agent handoff capabilities.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture & Design](#architecture--design)
- [Message Flow](#message-flow)
- [Project Structure](#project-structure)
- [Setup Instructions](#setup-instructions)
- [Commands](#commands)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Dependencies](#dependencies)
- [Troubleshooting](#troubleshooting)
- [Security Considerations](#security-considerations)

---

## Overview

This bot serves as an intelligent customer service assistant for Dyna-Nutrition, handling inquiries about health supplements across multiple Southeast Asian markets. It uses a **three-tier routing system** powered by Large Language Models (LLMs) to intelligently direct user queries to specialized handlers:

1. **Price Queries** → Real-time WooCommerce API integration
2. **Store Locator** → MLP API for retail location data
3. **General Questions** → DeepSeek AI with knowledge base and web search fallback

The bot maintains conversation context across sessions, supports multi-currency pricing, and seamlessly escalates to human agents when needed.

---

## Features

### Core Capabilities

| Feature | Description |
|---------|-------------|
| **AI-Powered Responses** | Intelligent conversation handling via DeepSeek API with context awareness |
| **Live Website Search** | Real-time scraping of dyna-nutrition.com for up-to-date product information |
| **Product Information Lookup** | Access to local knowledge base and product configurations |
| **Multi-Currency Price Checking** | Integration with WooCommerce API supporting SGD, MYR, IDR, THB, PHP, VND, and more |
| **Store Locator** | Find nearby retail stores carrying Dyna-Nutrition products in Malaysia/Singapore |
| **Human Agent Handoff** | Seamless escalation to human representatives with working hours detection |
| **Persistent Memory** | Conversation history and product tracking per user (180-day retention) |
| **Contact Caching** | Efficient phone number storage for returning users |

### Smart Features

- **Working Hours Detection**: Automatically informs users outside business hours before escalation (Mon-Fri, 9 AM - 5 PM SGT)
- **Session Management**: Track and manage active human agent sessions with auto-expiry (24 hours)
- **Message Chunking**: Automatic splitting of long messages for WhatsApp compatibility using LLM-based intelligent chunking
- **Auto-Reconnect**: Exponential backoff retry logic for connection stability (max 5 attempts)
- **Rate Limiting**: Built-in 2-second cooldown to prevent message flooding
- **Context-Aware Follow-ups**: Maintains conversation context for 60 days to handle follow-up questions like "Price?" or "How about Malaysia?"
- **Product Mention Tracking**: Remembers products mentioned in general conversation for future queries

---

## Architecture & Design

### System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        WhatsApp Web Client                       │
│                    (whatsapp-web.js + Puppeteer)                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Message Handler Layer                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Command      │  │ Human Mode   │  │ Rate Limit   │          │
│  │ Processor    │  │ Check        │  │ & Cooldown   │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    LLM-Based Intent Router                       │
│              (DeepSeek API with Conversation History)            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Analyzes: intent, product, currency, location, context   │   │
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
└────────────────────┘  └─────────────────┘ └──────────────────┘
```

### Design Patterns Used

1. **Strategy Pattern**: Different response strategies (price, store, general) selected at runtime based on intent
2. **Factory Pattern**: Dynamic module loading for human handoff to ensure fresh state
3. **Observer Pattern**: Event-driven WhatsApp client with listeners for QR, ready, disconnected, message
4. **Repository Pattern**: Centralized data access for memory, context, and contact cache
5. **Circuit Breaker Pattern**: Retry logic with exponential backoff for external API calls
6. **Singleton Pattern**: Shared client instance and session state across modules

### Data Flow Architecture

```
User Message
    │
    ├─► Contact Cache (phone number extraction)
    │
    ├─► Command Check (!bot, !status, !close, !closeall)
    │
    ├─► Human Mode Check (is user in human session?)
    │       │
    │       ├─ YES → Ignore message (human agent handling)
    │       └─ NO  → Continue
    │
    ├─► Escalation Trigger Check (keywords: "talk to human", etc.)
    │       │
    │       ├─ TRIGGERED → Working Hours Check
    │       │               ├─ Outside hours → Info message
    │       │               └─ Within hours → Enable human mode
    │       │
    │       └─ NOT TRIGGERED → Continue
    │
    ├─► Rate Limit Check (2s cooldown)
    │
    ├─► LLM Intent Analysis (DeepSeek API)
    │       │
    │       ├─ Intent: "price" → Price API Handler
    │       ├─ Intent: "store" → Store Locator Handler
    │       └─ Intent: "general" → DeepSeek General Response
    │
    ├─► Context Update (track product, currency, location)
    │
    ├─► Response Generation
    │       │
    │       ├─ Price: Fetch from WooCommerce → Format with currency
    │       ├─ Store: Fetch from MLP API → Filter by location
    │       └─ General: Knowledge Base → Web Search → Internet Search
    │
    ├─► Message Splitting (LLM-based chunking if >4096 chars)
    │
    └─► Send to User (with typing indicator)
```

---

## Message Flow

### Detailed Request Lifecycle

#### 1. **Incoming Message Processing** (`bot/whatsappBot.js`)

```javascript
// Timeline: 0-50ms
1. Extract message body and sender ID
2. Cache contact phone number from WhatsApp metadata
3. Check for special commands (!bot, !status, !close, !closeall)
4. Verify user is not in human mode
5. Apply rate limiting (2s cooldown per user)
6. Send typing indicator to chat
```

#### 2. **Intent Analysis** (`services/messageRouter.js`)

```javascript
// Timeline: 50-15000ms (depends on LLM response)
1. Build conversation context from last 10 messages
2. Retrieve stored context (last price product, pending store product)
3. Call DeepSeek API with prompt:
   - User message
   - Conversation history
   - Existing context
   - Product/currency/location detection instructions
4. Parse JSON response: { intent, product, currency, location, needsMoreInfo }
5. Fallback to keyword-based detection if LLM fails
6. Update context manager with detected entities
```

#### 3. **Handler Execution**

**Price Query Flow** (`services/priceApi.js`):
```
Product Name → Slug Normalization → WooCommerce API → LLM Parsing → Format Response
     │                │                    │                │              │
     │                │                    │                │              └─► Currency symbol
     │                │                    │                │                  (RM, S$, etc.)
     │                │                    │                │
     │                │                    │                └─► Separate regular vs subscription
     │                │                    │
     │                │                    └─► GET /wp-json/woo-country-price/v1/product-data
     │                │                           ?product_slug={slug}
     │                │
     │                └─► Map "Men Guard" → "men-guard-capsule"
     │
     └─► Extract from message or conversation history
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
                                         Filter by location → Clean addresses → Format list
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
```

#### 4. **Response Delivery**

```javascript
// Timeline: After handler completes
1. Clear typing indicator
2. Check message length
3. If >4096 chars:
   - Call LLM to split into semantic chunks
   - Send each chunk with 800ms delay
4. Add message to conversation history (utils/memory.js)
5. Log transaction
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
- **Limits**: Max 10 messages per user, max 1000 users
- **Expiry**: 180 days of inactivity

#### Context Manager (`services/contextManager.js`)
- **Purpose**: Track entities for follow-up questions
- **TTL**: 60 days
- **Fields**:
  - `lastPriceProduct`: Last product asked about for price
  - `lastPriceCurrency`: Currency used in last price query
  - `pendingStoreProduct`: Product for incomplete store query
  - `lastMentionedProduct`: Any product mentioned in conversation

#### Human Handoff (`utils/humanHandoff.js`)
- **Storage**: JSON file (`human_sessions.json`)
- **States**:
  - `bot`: Normal AI operation
  - `human`: Escalated to human agent
  - `human_complete`: User ended session
  - `agent_closed`: Admin closed session
- **Auto-return**: 24 hours of silence

---

## Project Structure

```
/workspace
├── index.js                     # Main entry point, env validation, heartbeat
├── package.json                 # Dependencies and scripts
├── .env                         # Environment variables (DEEPSEEK_API_KEY)
│
├── bot/
│   └── whatsappBot.js           # WhatsApp client, message handler, command processor
│
├── config/
│   ├── botConfig.js             # Web scraping config, templates, retry logic
│   ├── knowledgeBase.json       # Static Q&A pairs
│   ├── storeLocatorConfig.json  # Store locator regions and settings
│   ├── brochures/               # PDF brochure files
│   └── products/                # Product-specific JSON configs
│
├── services/
│   ├── messageRouter.js         # LLM-based intent detection and routing
│   ├── deepseek.js              # General AI responses with fallback cascade
│   ├── priceApi.js              # WooCommerce price lookup, multi-currency
│   ├── storeLocator.js          # MLP API integration, location filtering
│   ├── contextManager.js        # Conversation context tracking
│   └── knowledgeLoader.js       # Load knowledge base from JSON
│
├── utils/
│   ├── memory.js                # Persistent conversation history
│   ├── contactCache.js          # Phone number caching
│   ├── humanHandoff.js          # Human agent session management
│   ├── keepAlive.js             # Heartbeat utility
│   ├── llmMessageSplitter.js    # Intelligent message chunking
│   └── brochures.js             # Brochure content extraction
│
├── session-data/                # WhatsApp authentication (auto-generated)
├── conversations.json           # User conversation history (auto-generated)
└── human_sessions.json          # Active human sessions (auto-generated)
```

---

## Setup Instructions

### Prerequisites

- **Node.js**: Version 16 or higher
- **npm/yarn**: Package manager
- **WhatsApp Account**: For QR code authentication
- **DeepSeek API Key**: Obtain from [platform.deepseek.com](https://platform.deepseek.com/)

### Installation

1. **Clone and install dependencies**
   ```bash
   npm install
   ```

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

| Command | Description |
|---------|-------------|
| `!bot` | Switch back to bot mode (exit human agent session) |

### Admin Commands

| Command | Description |
|---------|-------------|
| `!status` | View all active human agent sessions with details |
| `!close <phone>` | Close a specific human session by phone number |
| `!closeall` | Close all active human sessions |

### Example Admin Workflow

```
Admin: !status
Bot: 📋 Active human sessions (3):
     📱 [1] 6591234567
        Agent: default
        Last: 5 min ago
        Command: !close 6591234567
     
     📱 [2] 60123456789
        Agent: escalation
        Last: 12 min ago
        Command: !close 60123456789
     
     Copy the command above to close a session.

Admin: !close 6591234567
Bot: ✅ Session closed for 6591234567. Bot active.
```

---

## Configuration

### Working Hours (Human Handoff)

Configure in `utils/humanHandoff.js`:
- **Default**: Monday-Friday, 9 AM - 5 PM (Singapore timezone)
- **Outside hours**: Users receive informational message instead of escalation

### Knowledge Base

- **Local**: Edit `config/knowledgeBase.json` for static Q&A
- **Products**: Add JSON files to `config/products/` for product-specific data
- **Brochures**: Place PDF files in `config/brochures/`

### Web Scraping

The bot scrapes `dyna-nutrition.com` for:
- Product pages with linked internal content
- Search results for general queries
- Retry logic with exponential backoff (1s, 2s, 4s delays)

### Context TTL Settings

| Context Type | Duration | File |
|--------------|----------|------|
| Conversation Memory | 180 days | `utils/memory.js` |
| Price/Store Context | 60 days | `services/contextManager.js` |
| Human Session Auto-return | 24 hours | `utils/humanHandoff.js` |
| Product/Store Cache | 60 days | `services/storeLocator.js` |

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

#### `services/priceApi.getProductPrice(productName, phoneNumber, apiKey, forcedCurrency)`

Fetches real-time pricing from WooCommerce API.

**Returns**: Parsed price object with regular prices and subscriptions

#### `services/storeLocator.findStores(userMessage, apiKey, routeParams)`

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

#### `services/deepseek.generateResponse(userMessage, userId, apiKey, history)`

Generates AI response with fallback cascade.

**Returns**:
```javascript
{
  text: string,
  imageUrl: string | null,
  productName: string | null
}
```

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `whatsapp-web.js` | ^1.23.0 | WhatsApp Web API client |
| `axios` | ^1.6.0 | HTTP requests for web scraping and APIs |
| `cheerio` | ^1.0.0-rc.12 | HTML parsing for scraping |
| `dotenv` | ^16.3.1 | Environment variable management |
| `qrcode-terminal` | ^0.12.0 | QR code display for authentication |
| `nodemon` | ^3.0.1 | Development auto-reload (devDependencies) |

---

## Troubleshooting

### Common Issues

**QR Code not appearing**
- Ensure terminal supports ASCII rendering
- Check `puppeteer` installation: `npm install puppeteer`

**API Key Error**
```
❌ DEEPSEEK_API_KEY missing in .env
```
- Verify `.env` file exists in root directory
- Check for typos in variable name

**Connection Drops**
- Bot auto-reconnects with exponential backoff (max 5 attempts)
- Session data persisted in `./session-data/`

**Web Scraping Failures**
- Target website may be temporarily unavailable
- Retry logic handles transient errors (3 attempts)

**Context Not Working**
- Check `conversations.json` file permissions
- Verify user ID format matches WhatsApp LID

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

---

## Security Considerations

- **API Keys**: Never commit `.env` file to version control
- **Session Data**: Stored locally in `./session-data/` - secure this directory
- **Phone Numbers**: Cached in memory only (contactCache.js), persisted in conversation history
- **Rate Limiting**: Built-in 2-second cooldown between user messages
- **Input Validation**: All user inputs sanitized before API calls
- **Timeout Handling**: All external API calls have timeout limits (10-20 seconds)

---

## License

Proprietary - Dyna-Nutrition

## Support

For technical issues or feature requests, contact the development team.

---

## Admin Commands (Human Handoff Management)

### Overview

The bot supports human agent handoff for both **WhatsApp** and **Facebook Messenger** platforms. Admin commands work the same way on both platforms - send a message to the bot with the command.

### Session Identification

| Platform | User Identifier | Display Name | Close Command |
|----------|-----------------|--------------|----------------|
| WhatsApp | WhatsApp User ID | Phone Number | `!close <phone>` |
| Messenger | PSID (Facebook Page-Scoped ID) | Facebook Name | `!close <name>` |

### Admin Commands

Send these commands from any WhatsApp number or via Facebook Messenger:

```
!status          - List all active human sessions with close commands
!close <value>   - Close session (phone for WhatsApp, name for Messenger)
!closeall        - Close all active human sessions
!bot             - Return user to bot mode (WhatsApp only)
```

### How It Works

**WhatsApp Flow:**
1. User says "talk to human"
2. Bot extracts phone number from contact
3. Session stored with phone number
4. Agent uses `!status` to see sessions, `!close 91234567` to close

**Messenger Flow:**
1. User says "talk to human"
2. Bot fetches Facebook name via Graph API
3. Session stored with facebookName
4. Agent uses `!status` to see sessions, `!close John Smith` to close

### !status Output Example

```
Active human sessions (2):

[1] 91234567 (whatsapp) | Agent: escalation | Last: 5 min ago
Command: !close 91234567

[2] John Smith (messenger) | Agent: escalation | Last: 3 min ago
Command: !close John Smith

Copy the command above to close a session.
```