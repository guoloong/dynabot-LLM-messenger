# Dyna-Nutrition WhatsApp Bot

A WhatsApp chatbot for Dyna-Nutrition with AI-powered responses using DeepSeek API.

## Features

- AI-powered responses with DeepSeek
- Product information lookup
- Live website search
- Human agent handoff
- Persistent memory

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   ```

3. **Add your DeepSeek API key** in `.env`:
   ```
   DEEPSEEK_API_KEY=your_api_key_here
   ```

4. **Start the bot**
   ```bash
   npm start
   ```

5. **Scan QR code** when prompted to link your WhatsApp

## Commands

- `!bot` - Switch to bot mode
- `!status` - View active human sessions
- `!close <phone>` - Close a specific session
- `!closeall` - Close all human sessions

## Requirements

- Node.js 16+
- WhatsApp account
- DeepSeek API key