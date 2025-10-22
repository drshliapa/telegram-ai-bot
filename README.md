# Telegram AI Bot

AI-powered Telegram bot using MTProto API with support for OpenRouter and Ollama.

## Features

- 🤖 AI auto-replies with conversation history
- 🔒 Rate limiting and prompt injection protection
- 🌍 Ukrainian and English support
- 📊 Automatic log rotation with pino-roll

## Quick Start

### 1. Get Telegram API Credentials

1. Visit https://my.telegram.org/apps
2. Create an application
3. Save your `api_id` and `api_hash`

### 2. Install

```bash
npm install
```

### 3. Configure

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

**Required settings:**

```bash
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
BOT_OWNER_ID=your_telegram_user_id

# AI Provider (choose one)
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=your_key
# or
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3.2:1b
```

### 4. Run

```bash
npm start
```

On first run, you'll be prompted to authenticate with your phone number.

## Configuration

### Trigger Words

Bot responds to messages containing trigger words (default: `ai`, `bot`, `help`) or the word "шляпа" (all Ukrainian case forms).

```bash
LLM_TRIGGER_WORDS=ai,bot,help
```

### Group Chats

To allow bot in specific groups/channels, add their IDs:

```bash
LLM_ALLOWED_CHATS=1234567890,9876543210
```

Get chat ID: invite bot to group and check logs.

### Advanced Options

See `.env.example` for all configuration options including:
- Temperature and max tokens
- Conversation history size
- Rate limiting
- Log levels

## License

MIT © Marian Leontiev
