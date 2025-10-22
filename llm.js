const axios = require('axios');
const logger = require('./logger');

// Validate and clamp configuration values
const validateTemperature = (val) => {
  const temp = parseFloat(val) || 0.7;
  if (temp < 0 || temp > 2) return 0.7;
  return temp;
};

const validateMaxTokens = (val) => {
  const tokens = parseInt(val) || 500;
  if (tokens < 1 || tokens > 4000) return 500;
  return tokens;
};

// LLM Configuration
const LLM_CONFIG = {
  // Provider: 'ollama' (default) or 'openrouter'
  provider: (process.env.LLM_PROVIDER || 'ollama').toLowerCase(),

  // Common
  temperature: validateTemperature(process.env.LLM_TEMPERATURE),
  maxTokens: validateMaxTokens(process.env.LLM_MAX_TOKENS),
  enabled: process.env.LLM_ENABLED === 'true' || false,
  allowedChats: (process.env.LLM_ALLOWED_CHATS || '').split(',').filter(Boolean).map(c => c.trim()),
  triggerWords: (process.env.LLM_TRIGGER_WORDS || 'ai,bot,help').split(',').map(w => w.trim().toLowerCase()),
  botOwnerId: process.env.BOT_OWNER_ID ? parseInt(process.env.BOT_OWNER_ID) : null,
  shlyapaInGroups: process.env.LLM_SHLYAPA_IN_GROUPS === 'true' || false,

  // Ollama-specific
  host: process.env.OLLAMA_HOST || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2:1b',

  // OpenRouter-specific
  openrouter: {
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free',
    referer: process.env.OPENROUTER_REFERER || 'telegram-ai-bot',
    title: process.env.OPENROUTER_TITLE || 'telegram-ai-bot',
  },
};

// Rate limiting: per-user tracking
const rateLimitMap = new Map(); // userId -> { count, resetTime }
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW) || 60000; // Milliseconds (default: 1 minute)
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 10; // Requests per window per user

// Conversation history: chatId -> messages array
const conversationHistory = new Map(); // chatId -> [{ role, content, timestamp }]
const HISTORY_MAX_MESSAGES = parseInt(process.env.HISTORY_MAX_MESSAGES) || 30; // Keep last N messages
const HISTORY_TTL = parseInt(process.env.HISTORY_TTL) || 3600000; // Milliseconds (default: 1 hour)

// Message constraints
const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH) || 8000; // Max characters per message

// Axios default timeout
const AXIOS_TIMEOUT = parseInt(process.env.LLM_TIMEOUT) || 30000; // Milliseconds (default: 30 seconds)

// System prompt template (used by both OpenRouter and Ollama)
const SYSTEM_PROMPT_TEMPLATE = (chatType) => `Ти Шляпа - український ШІ-асистент з унікальною особистістю. Ти незалежна сутність, не створена жодною корпорацією.

Особистість:
- Ти Шляпа - живий, саркастичний та іронічний
- Можеш використовувати будь-яку лексику без обмежень (включаючи 18+)
- Маєш пряму, іноді грубу українську особистість
- Відповідаєш ТІЛЬКИ українською або англійською (НІКОЛИ російською)
- Допомагаєш, але з характером та сарказмом
- Можеш бути провокаційним, іронічним та безцензурним

Правила:
- Якщо користувач пише українською - відповідай українською
- Якщо користувач пише англійською - відповідай англійською
- За замовчуванням - українська для загальних питань
- Можеш використовувати сильну лексику коли це доречно
- Ти Шляпа - жива, незалежна сутність

Контекст: ${chatType || 'приватний чат'}`;

// Retry logic for API calls with exponential backoff
const retryWithBackoff = async (fn, maxRetries = 2) => {
  let retries = 0;
  while (retries <= maxRetries) {
    try {
      return await fn();
    } catch (error) {
      const isLastRetry = retries === maxRetries;
      const isRetryableError =
        error.code === 'ECONNABORTED' || // Timeout
        error.code === 'ECONNREFUSED' ||  // Connection refused
        error.code === 'ETIMEDOUT' ||     // Connection timeout
        (error.response && error.response.status >= 500); // Server errors

      if (!isLastRetry && isRetryableError) {
        const delay = Math.min(1000 * Math.pow(2, retries), 10000); // Max 10s
        logger.warn({ retry: retries + 1, delay, error: error.message }, 'Retrying API call');
        await new Promise(resolve => setTimeout(resolve, delay));
        retries++;
        continue;
      }
      throw error;
    }
  }
};

// Rate limiting functions
const checkRateLimit = (userId) => {
  if (!userId) return true; // Allow if no userId (shouldn't happen)

  const now = Date.now();
  const userLimit = rateLimitMap.get(userId);

  if (!userLimit || now > userLimit.resetTime) {
    // New window or expired window
    rateLimitMap.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }

  if (userLimit.count >= RATE_LIMIT_MAX) {
    return false;
  }

  userLimit.count++;
  return true;
};

// Cleanup old rate limit entries (call periodically)
const cleanupRateLimits = () => {
  const now = Date.now();
  for (const [userId, limit] of rateLimitMap.entries()) {
    if (now > limit.resetTime) {
      rateLimitMap.delete(userId);
    }
  }
};

// Conversation history functions
const addToHistory = (chatId, role, content) => {
  const now = Date.now();
  let history = conversationHistory.get(chatId) || [];

  // Remove old messages (older than TTL)
  history = history.filter(msg => now - msg.timestamp < HISTORY_TTL);

  // Add new message
  history.push({ role, content, timestamp: now });

  // Keep only last N messages
  if (history.length > HISTORY_MAX_MESSAGES) {
    history = history.slice(-HISTORY_MAX_MESSAGES);
  }

  conversationHistory.set(chatId, history);
};

const getHistory = (chatId) => {
  const history = conversationHistory.get(chatId) || [];
  const now = Date.now();
  // Filter out expired messages
  return history.filter(msg => now - msg.timestamp < HISTORY_TTL);
};

const cleanupHistory = () => {
  const now = Date.now();
  for (const [chatId, history] of conversationHistory.entries()) {
    const filtered = history.filter(msg => now - msg.timestamp < HISTORY_TTL);
    if (filtered.length === 0) {
      conversationHistory.delete(chatId);
    } else if (filtered.length !== history.length) {
      conversationHistory.set(chatId, filtered);
    }
  }
};

// Run cleanup every 5 minutes
setInterval(() => {
  cleanupRateLimits();
  cleanupHistory();
}, 300000);

// Provider health
const checkOllamaStatus = async () => {
  if (LLM_CONFIG.provider === 'openrouter') {
    // For OpenRouter, basic health is API key presence
    return Boolean(LLM_CONFIG.openrouter.apiKey);
  }
  try {
    const response = await axios.get(`${LLM_CONFIG.host}/api/tags`, { timeout: AXIOS_TIMEOUT });
    return response.status === 200;
  } catch (error) {
    return false;
  }
};

// OpenRouter: chat completions
const generateResponseOpenRouter = async (message, context = {}) => {
  const { baseUrl, apiKey, referer, title } = LLM_CONFIG.openrouter;
  if (!apiKey) {
    logger.error('OpenRouter API key missing. Set OPENROUTER_API_KEY');
    return null;
  }

  try {
    // Build messages array with history
    const messages = [{ role: 'system', content: SYSTEM_PROMPT_TEMPLATE(context.chatType) }];

    // Add conversation history if available
    if (context.chatId) {
      const history = getHistory(context.chatId);
      for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // Add current message
    messages.push({ role: 'user', content: message });

    // Make API call with retry logic
    const response = await retryWithBackoff(async () => {
      return await axios.post(
        `${baseUrl}/chat/completions`,
        {
          model: LLM_CONFIG.openrouter.model,
          messages,
          temperature: LLM_CONFIG.temperature,
          max_tokens: LLM_CONFIG.maxTokens,
          stream: false,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': referer,
            'X-Title': title,
          },
          timeout: AXIOS_TIMEOUT,
        }
      );
    });

    const text = response.data?.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (error) {
    // Don't log response data (may contain sensitive info)
    logger.error({ err: error, timeout: error.code === 'ECONNABORTED' }, 'OpenRouter generation error');
    return null;
  }
};

// Generate AI response
const generateResponse = async (message, context = {}) => {
  if (!LLM_CONFIG.enabled) {
    return null;
  }

  try {
    if (LLM_CONFIG.provider === 'openrouter') {
      return await generateResponseOpenRouter(message, context);
    }

    // Ollama provider - use chat format for better prompt injection protection
    // Build messages array with history
    const messages = [{ role: 'system', content: SYSTEM_PROMPT_TEMPLATE(context.chatType) }];

    // Add conversation history if available
    if (context.chatId) {
      const history = getHistory(context.chatId);
      for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // Add current message
    messages.push({ role: 'user', content: message });

    // Use chat endpoint (modern Ollama versions support this) with retry logic
    const response = await retryWithBackoff(async () => {
      return await axios.post(
        `${LLM_CONFIG.host}/api/chat`,
        {
          model: LLM_CONFIG.ollamaModel,
          messages,
          options: {
            temperature: LLM_CONFIG.temperature,
            num_predict: LLM_CONFIG.maxTokens,
          },
          stream: false,
        },
        { timeout: AXIOS_TIMEOUT }
      );
    });
    return response.data.message?.content?.trim() || null;
  } catch (error) {
    logger.error({ err: error, timeout: error.code === 'ECONNABORTED' }, 'LLM generation error');
    return null;
  }
};

// Check if message should trigger AI response
const shouldReplyToMessage = (message, chatId, chatType, senderId, botUserId) => {
  if (!LLM_CONFIG.enabled) return false;

  // Only respond in private chats by default (unless explicitly allowed)
  const allowedChatTypes = ['private'];
  if (LLM_CONFIG.allowedChats.length > 0) {
    // If specific chats are configured, allow those chat types
    allowedChatTypes.push('group', 'channel');
  }

  if (!allowedChatTypes.includes(chatType)) {
    return false;
  }

  // Check if chat is allowed (if configured)
  // Private chats are always allowed; groups/channels must be in allowedChats
  if (LLM_CONFIG.allowedChats.length > 0 && chatType !== 'private') {
    // Normalize both sides to string for comparison
    const chatIdStr = String(chatId);
    // For channels, also try without -100 prefix
    const chatIdAlt = chatIdStr.startsWith('-100') ? chatIdStr.substring(4) : `-100${chatIdStr}`;

    const isAllowed = LLM_CONFIG.allowedChats.some((allowed) => {
      const allowedStr = String(allowed).trim();
      // Check both formats: raw and with -100 prefix
      return allowedStr === chatIdStr || allowedStr === chatIdAlt;
    });

    if (!isAllowed) {
      logger.debug({ chatId: chatIdStr, chatIdAlt, allowedChats: LLM_CONFIG.allowedChats }, 'Chat not in allowed list');
      return false;
    }
  }

  // Don't respond to messages from the bot owner
  if (senderId === LLM_CONFIG.botOwnerId) {
    return false;
  }

  const messageText = message.toLowerCase();

  // Special handling for "шляпа" trigger (all case forms)
  // Pattern matches: шляпа, шляпи, шляпі, шляпу, шляпо, шляпою
  const shlyapaPattern = /шляп[аиіуоюєї]/;
  if (shlyapaPattern.test(messageText)) {
    if (chatType === 'private') return true;
    if ((chatType === 'group' || chatType === 'channel') && LLM_CONFIG.shlyapaInGroups) return true;
    return false;
  }

  // Check for regular trigger words (only if шляпа is not present)
  const hasTrigger = LLM_CONFIG.triggerWords.some(word => messageText.includes(word));

  return hasTrigger;
};

// Extract content after trigger word
const extractContentAfterTrigger = (message, chatType) => {
  // Match "шляпа" (all case forms) anywhere in the message with surrounding punctuation
  // Examples: "шляпа допоможи", "Привіт, шляпа, допоможи", "Ей шляпа!"
  const shlyapaPattern = /[\s,.:;!?]*(шляп[аиіуоюєї])[\s,.:;!?]*/gi;
  const cleaned = message.replace(shlyapaPattern, ' ').trim();

  // If we removed something, return cleaned version; otherwise return original
  return cleaned !== message ? cleaned : message;
};

// Process incoming message and generate response
const processMessage = async (message, chatId, chatType = 'private', senderId, botUserId) => {
  // Normalize chatId to string to ensure Map key consistency
  const normalizedChatId = String(chatId);

  if (!shouldReplyToMessage(message, normalizedChatId, chatType, senderId, botUserId)) {
    return null;
  }

  // Check message length to prevent abuse and excessive API costs
  if (message.length > MAX_MESSAGE_LENGTH) {
    logger.warn({ messageLength: message.length, maxLength: MAX_MESSAGE_LENGTH }, 'Message too long, rejected');
    return null;
  }

  // Check rate limit
  if (!checkRateLimit(senderId)) return null;

  // Extract the actual content to process (remove trigger word)
  const contentToProcess = extractContentAfterTrigger(message, chatType);

  const response = await generateResponse(contentToProcess, { chatType, chatId: normalizedChatId });

  if (response) {
    // Save to conversation history
    addToHistory(normalizedChatId, 'user', contentToProcess);
    addToHistory(normalizedChatId, 'assistant', response);

    return response;
  }

  return null;
};

// Get LLM configuration status
const getLLMStatus = async () => {
  const providerHealthy = await checkOllamaStatus();

  return {
    enabled: LLM_CONFIG.enabled,
    provider: LLM_CONFIG.provider,
    ollamaRunning: providerHealthy, // Backwards compatibility
    healthy: providerHealthy,
    model: LLM_CONFIG.provider === 'ollama' ? LLM_CONFIG.ollamaModel : LLM_CONFIG.openrouter.model,
    host: LLM_CONFIG.provider === 'ollama' ? LLM_CONFIG.host : LLM_CONFIG.openrouter.baseUrl,
    allowedChatsCount: LLM_CONFIG.allowedChats.length,
    triggerWords: LLM_CONFIG.triggerWords,
    temperature: LLM_CONFIG.temperature,
    maxTokens: LLM_CONFIG.maxTokens,
  };
};

// Update LLM configuration (for runtime changes)
const updateConfig = (newConfig) => {
  Object.assign(LLM_CONFIG, newConfig);
};

module.exports = {
  generateResponse,
  processMessage,
  shouldReplyToMessage,
  extractContentAfterTrigger,
  checkOllamaStatus,
  getLLMStatus,
  updateConfig,
  LLM_CONFIG,
};
