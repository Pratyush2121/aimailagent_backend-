import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(info => `${info.timestamp} [${info.level.toUpperCase()}]: ${info.message}`)
);

const transports = [];

// In Vercel serverless environments, write logs to Console (stdout/stderr)
if (process.env.VERCEL) {
  transports.push(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(info => `${info.timestamp} [${info.level}]: ${info.message}`)
    )
  }));
} else {
  // Local environment: create logs directory and use File transports
  const logsDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logsDir)) {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
    } catch (e) {
      // Ignore directory creation error
    }
  }

  transports.push(
    new winston.transports.File({ 
      filename: path.join(logsDir, 'error.log'), 
      level: 'error' 
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, 'combined.log') 
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
      )
    })
  );
}

const logger = winston.createLogger({
  level: 'info',
  format: logFormat,
  transports
});

export default logger;
