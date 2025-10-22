const pino = require('pino');
const path = require('path');
const fs = require('fs');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Pino configuration
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',

  // Dual output: console + file with automatic rotation
  transport: {
    targets: [
      {
        // File output with automatic rotation (pino-roll)
        // Rotates daily OR when file reaches 10MB (whichever comes first)
        target: 'pino-roll',
        level: process.env.LOG_LEVEL_FILE || 'info',
        options: {
          file: path.join(logsDir, 'app.log'),
          frequency: 'daily', // Rotate daily
          size: '10m', // Also rotate when file reaches 10MB
          mkdir: true,
        },
      },
      {
        // Console output - JSON format
        target: 'pino/file',
        level: process.env.LOG_LEVEL_CONSOLE || 'info',
        options: {
          destination: 1, // stdout
        },
      },
    ],
  },
});

module.exports = logger;
