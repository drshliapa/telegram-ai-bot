// Load environment variables from .env file
require('dotenv').config();

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const fs = require('fs');
const path = require('path');
const llm = require('./llm');
const logger = require('./logger');

// Configuration: environment variables only
const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const SESSION_STRING = process.env.SESSION_STRING || '';

// Basic validation to prevent common mistakes
if (!API_ID || Number.isNaN(API_ID)) {
  logger.error('TELEGRAM_API_ID environment variable is missing or invalid. Set it with: export TELEGRAM_API_ID=your_api_id');
  process.exit(1);
}
if (!API_HASH || typeof API_HASH !== 'string' || API_HASH.length < 30) {
  logger.error('TELEGRAM_API_HASH environment variable is missing or invalid. Set it with: export TELEGRAM_API_HASH=your_api_hash');
  process.exit(1);
}

// Create client instance
const createTelegramClient = () => {
  const session = new StringSession(SESSION_STRING);
  const connectionRetries = parseInt(process.env.TELEGRAM_CONNECTION_RETRIES) || 5;
  return new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries,
  });
};


// Authenticate the client
const authenticateClient = async (client) => {
  try {
    // Ensure transport is up before checking auth
    if (!client.connected) {
      await client.connect();
    }

    const isAuthorized = await client.isUserAuthorized();
    if (!isAuthorized) {
      await client.start({
        phoneNumber: async () => {
          const readline = require('readline');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });

          return new Promise((resolve) => {
            rl.question('📞 Enter your phone number (with country code, e.g. +1234567890): ', (phone) => {
              rl.close();
              resolve(phone.trim());
            });
          });
        },
        phoneCode: async () => {
          const readline = require('readline');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });

          return new Promise((resolve) => {
            rl.question('🔢 Enter the verification code sent to your Telegram: ', (code) => {
              rl.close();
              resolve(code.trim());
            });
          });
        },
        password: async () => {
          const readline = require('readline');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });

          return new Promise((resolve) => {
            rl.question('🔑 Enter your 2FA password: ', (pwd) => {
              rl.close();
              resolve(pwd);
            });
          });
        },
        onError: (err) => {
          logger.error({ err }, 'Authentication error');
          throw err;
        },
      });

      // Persist session to .env file so next run skips login
      try {
        const sessionString = client.session.save();
        const envPath = path.join(process.cwd(), '.env');

        // Read existing .env file or create new one
        let envContent = '';
        if (fs.existsSync(envPath)) {
          envContent = fs.readFileSync(envPath, 'utf8');
        }

        // Update or add SESSION_STRING
        const sessionLine = `SESSION_STRING=${sessionString}`;
        if (envContent.includes('SESSION_STRING=')) {
          // Replace existing SESSION_STRING
          envContent = envContent.replace(/SESSION_STRING=.*/g, sessionLine);
        } else {
          // Add new SESSION_STRING
          envContent += (envContent ? '\n' : '') + sessionLine;
        }

        fs.writeFileSync(envPath, envContent, { encoding: 'utf8' });
      } catch (e) {
        logger.warn({ err: e }, 'Failed to save session to .env file');
      }
    }
    logger.info('Client authenticated successfully');
    return true;
  } catch (error) {
    logger.error({ err: error }, 'Authentication failed');
    return false;
  }
};

// Helper function to handle FloodWaitError from Telegram API
const handleFloodWait = async (fn, maxRetries = null) => {
  const maxRetriesConfig = maxRetries ?? (parseInt(process.env.FLOOD_WAIT_MAX_RETRIES) || 2);
  const maxWaitSeconds = parseInt(process.env.FLOOD_WAIT_MAX_SECONDS) || 300;

  let retries = 0;
  while (retries <= maxRetriesConfig) {
    try {
      return await fn();
    } catch (error) {
      // Check if this is a FloodWaitError
      if (error.errorMessage && error.errorMessage.startsWith('FLOOD_WAIT_')) {
        const seconds = parseInt(error.errorMessage.split('_')[2]) || 60;
        if (retries < maxRetriesConfig && seconds <= maxWaitSeconds) {
          logger.warn({ seconds, retry: retries + 1, maxWaitSeconds }, 'FloodWaitError, waiting before retry');
          await new Promise(resolve => setTimeout(resolve, seconds * 1000));
          retries++;
          continue;
        }
      }
      throw error;
    }
  }
};

// Resolve proper InputPeer for any peerId
const resolveInputPeer = async (client, peerId) => {
  if (!peerId || !peerId.className) {
    throw new Error('Invalid peerId');
  }
  if (peerId.className === 'PeerChat') {
    return new Api.InputPeerChat({ chatId: peerId.chatId });
  }
  if (peerId.className === 'PeerChannel') {
    const entity = await client.getEntity(peerId.channelId);
    if (entity && entity.className === 'Channel' && entity.accessHash) {
      return new Api.InputPeerChannel({ channelId: entity.id, accessHash: entity.accessHash });
    }
    throw new Error('Channel entity/accessHash not found');
  }
  if (peerId.className === 'PeerUser') {
    const entity = await client.getEntity(peerId.userId);
    if (entity && entity.className === 'User') {
      if (entity.self) {
        return new Api.InputPeerSelf();
      }
      if (entity.accessHash) {
        return new Api.InputPeerUser({ userId: entity.id, accessHash: entity.accessHash });
      }
    }
    throw new Error('User entity/accessHash not found');
  }
  throw new Error(`Unsupported peer type: ${peerId.className}`);
};

// Enhanced send message function with group support
const sendMessage = async (client, target, message) => {
  // Ensure target is a string (declare before try so it's visible in catch)
  const targetStr = String(target);
  try {
    const isConnected = client.connected;
    if (!isConnected) {
      await client.connect();
    }

    // Handle different target types
    let peer;
    if (targetStr === 'me') {
      peer = 'me'; // Special case for self
    } else if (targetStr.startsWith('@')) {
      peer = targetStr; // Username
    } else if (targetStr.startsWith('+')) {
      peer = targetStr; // Phone number
    } else if (targetStr.startsWith('-')) {
      peer = targetStr; // Group/chat ID (negative numbers)
    } else if (/^\d+$/.test(targetStr)) {
      peer = targetStr; // Positive number (could be user ID or phone without +)
    } else {
      peer = targetStr; // Try as username without @
    }

    // Send with FloodWait handling
    await handleFloodWait(async () => {
      await client.sendMessage(peer, { message });
    });
    logger.info({ target: targetStr }, 'Message sent');
    return { success: true, target: targetStr, message };
  } catch (error) {
    logger.error({ err: error, target: targetStr }, 'Failed to send message');
    return { success: false, target: targetStr, error: error.message };
  }
};

// Menu and UI functions removed - bot runs in background mode only

// Process incoming message for AI responses
const processIncomingMessage = async (message, client) => {
  try {
    // Skip our own messages - use 'out' flag as primary check
    if (message.out === true) return;

    // Skip messages without text
    if (!message.message || typeof message.message !== 'string') return;

    // Determine chat type and ID
    let chatId, chatType = 'private';
    if (message.peerId.className === 'PeerChat') {
      chatId = message.peerId.chatId;
      chatType = 'group';
    } else if (message.peerId.className === 'PeerChannel') {
      chatId = message.peerId.channelId;
      chatType = 'channel';
    } else if (message.peerId.className === 'PeerUser') {
      chatId = message.peerId.userId;
      chatType = 'private';
    }

    // Process message with LLM
    const senderId = message.fromId?.userId;
    const botUserId = client.botUserId;
    const aiResponse = await llm.processMessage(message.message, chatId, chatType, senderId, botUserId);

    if (aiResponse) {
      try {
        // Resolve proper InputPeer and send with FloodWait handling
        const inputPeer = await resolveInputPeer(client, message.peerId);
        await handleFloodWait(async () => {
          await client.sendMessage(inputPeer, { message: aiResponse });
        });
        logger.info({ chatType, chatId }, 'AI replied');
      } catch (peerErr) {
        logger.warn({ err: peerErr }, 'InputPeer failed, using fallback');
        try {
          // For groups/channels, build proper peer string
          let fallbackTarget = String(chatId);
          // Channels (supergroups) need -100 prefix if not already present
          if (chatType === 'channel' && !fallbackTarget.startsWith('-')) {
            fallbackTarget = `-100${fallbackTarget}`;
          }
          const result = await sendMessage(client, fallbackTarget, aiResponse);
          if (result.success) {
            logger.info({ chatType, chatId: fallbackTarget }, 'AI replied via fallback');
          }
        } catch (error) {
          logger.error({ err: error }, 'Failed to send AI response');
        }
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Message processing error');
  }
};

// Message event handler for AI responses
const setupMessageListener = (client) => {
  client.addEventHandler(async (update) => {
    try {
      if (update.className === 'UpdateNewMessage' || update.className === 'UpdateNewChannelMessage') {
        const message = update.message;
        // Skip our own outgoing messages (out flag)
        if (message.out === true) return;
        await processIncomingMessage(message, client);
      } else if (update.className === 'UpdateShortMessage') {
        // Handle short messages (private chats)
        const message = {
          message: update.message,
          fromId: { className: 'PeerUser', userId: update.userId },
          peerId: { className: 'PeerUser', userId: update.userId },
          id: update.id,
          date: update.date,
          out: update.out === true
        };
        // Skip our own outgoing messages (out flag)
        if (message.out === true) return;
        await processIncomingMessage(message, client);
      } else if (update.className === 'UpdateShortChatMessage') {
        // Handle short chat messages (group chats)
        const message = {
          message: update.message,
          fromId: { className: 'PeerUser', userId: update.fromId },
          peerId: { className: 'PeerChat', chatId: update.chatId },
          id: update.id,
          date: update.date,
          out: update.out === true
        };
        // Skip our own outgoing messages (out flag)
        if (message.out === true) return;
        await processIncomingMessage(message, client);
      }
    } catch (error) {
      logger.error({ err: error }, 'Message event handler error');
    }
  });
};

// Main function - background AI bot mode
const main = async () => {
  const client = createTelegramClient();

  // Graceful shutdown handler
  let isShuttingDown = false;
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, 'Shutting down gracefully');
    try {
      if (client.connected) {
        await client.disconnect();
        logger.info('Client disconnected');
      }
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  // Register signal handlers
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Authenticate
  const isAuthenticated = await authenticateClient(client);
  if (!isAuthenticated) {
    logger.error('Failed to authenticate. Please check your API credentials');
    process.exit(1);
  }

  // Setup message listener for AI responses
  setupMessageListener(client);
  logger.info('Message listener activated for AI responses');

  // Test connection by getting user info
  try {
    const me = await client.getMe();
    logger.info({ username: me.username || me.firstName, id: me.id }, 'Logged in successfully');
    // Store bot user ID for later use
    client.botUserId = me.id;
  } catch (error) {
    logger.error({ err: error }, 'Connection test failed');
  }

  // Bot runs in background mode only
  logger.info('Telegram AI Bot started. Press Ctrl+C to stop');

  // Send a test message to self (if enabled)
  if (process.env.TEST_MESSAGE_ENABLED === 'true') {
    setTimeout(async () => {
      try {
        await sendMessage(client, 'me', '🤖 AI Bot started and ready!');
        logger.info('Test message sent to self');
      } catch (error) {
        logger.error({ err: error }, 'Failed to send test message');
      }
    }, 2000);
  }

  // Keep the process alive - signal handlers will terminate properly
  await new Promise((resolve) => {
    // This will be resolved by signal handlers
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
  await shutdown('manual');
};

// Export functions for use in other modules
module.exports = {
  createTelegramClient,
  sendMessage,
  authenticateClient,
};

// Run main if this file is executed directly
if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'Fatal error in main');
    process.exit(1);
  });
}
