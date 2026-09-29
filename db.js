import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import logger from './logger.js';
import { connectMongo, isMongoConnected, SettingModel } from './services/mongoService.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.VERCEL 
  ? path.join('/tmp', 'database.sqlite') 
  : path.join(__dirname, 'database.sqlite');

let dbInstance = null;

export async function getDb() {
  if (!dbInstance) {
    try {
      dbInstance = await open({
        filename: dbPath,
        driver: sqlite3.Database
      });

      await dbInstance.run('PRAGMA foreign_keys = ON');

      // Create Leads Table
      await dbInstance.exec(`
        CREATE TABLE IF NOT EXISTS leads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          company TEXT NOT NULL,
          website TEXT,
          email TEXT UNIQUE NOT NULL,
          country TEXT,
          industry TEXT,
          reference_code TEXT UNIQUE NOT NULL,
          company_summary TEXT,
          niche TEXT,
          outbound_status TEXT DEFAULT 'Pending',
          reply_status TEXT DEFAULT 'No Reply',
          reply_classification TEXT,
          followup_count INTEGER DEFAULT 0,
          last_sent_at TEXT,
          next_followup_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create Messages Table
      await dbInstance.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lead_id INTEGER,
          type TEXT NOT NULL,
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
        )
      `);

      // Create Settings Table
      await dbInstance.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      logger.info('SQLite database and schemas initialized successfully');
      
      await seedDefaultSettings(dbInstance);

    } catch (error) {
      logger.error(`Database initialization failed: ${error.message}`);
      throw error;
    }
  }

  // Attempt MongoDB Atlas connection in background
  connectMongo().catch(err => logger.error(`MongoDB background connect error: ${err.message}`));

  return dbInstance;
}

async function seedDefaultSettings(db) {
  const existingSettings = await db.all('SELECT key FROM settings');
  if (existingSettings.length > 0) return;

  logger.info('Seeding default settings from environment variables...');
  
  const defaults = {
    ai_provider: process.env.AI_PROVIDER || 'gemini',
    gemini_api_key: process.env.GEMINI_API_KEY || '',
    openai_api_key: process.env.OPENAI_API_KEY || '',
    use_ai: 'true',
    email_subject_template: 'partnership query for {{company}}',
    email_body_template: 'Hi {{name}},\n\nI noticed what you are building at {{company}}.\n\nWe work with companies in the {{industry}} space to handle custom development and automation.\n\nWould you be open to a casual 10-minute chat next Thursday to see if we can collaborate?\n\nBest,\n{{sender_name}}\n\nRef: {{reference}}',
    sender_company_name: process.env.SENDER_COMPANY_NAME || 'Zonava',
    sender_company_description: process.env.SENDER_COMPANY_DESCRIPTION || '',
    smtp_host: process.env.SMTP_HOST || 'smtp.gmail.com',
    smtp_port: process.env.SMTP_PORT || '465',
    smtp_secure: process.env.SMTP_SECURE || 'true',
    smtp_user: process.env.SMTP_USER || '',
    smtp_pass: process.env.SMTP_PASS || '',
    smtp_from_name: process.env.SMTP_FROM_NAME || 'AI Mail Agent',
    imap_host: process.env.IMAP_HOST || 'imap.gmail.com',
    imap_port: process.env.IMAP_PORT || '993',
    imap_secure: process.env.IMAP_SECURE || 'true',
    imap_user: process.env.IMAP_USER || '',
    imap_pass: process.env.IMAP_PASS || ''
  };

  const stmt = await db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaults)) {
    await stmt.run(key, value);
  }
  await stmt.finalize();
  logger.info('Default settings seeded successfully');
}

export async function getSetting(key, defaultValue = '') {
  const db = await getDb();
  const row = await db.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : defaultValue;
}

export async function getSettings() {
  const db = await getDb();
  const rows = await db.all('SELECT key, value FROM settings');
  return rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

export async function saveSettings(settingsObject) {
  const db = await getDb();
  const stmt = await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(settingsObject)) {
    await stmt.run(key, String(value));

    // Sync to MongoDB Atlas if connected
    if (isMongoConnected()) {
      try {
        await SettingModel.findOneAndUpdate(
          { key },
          { key, value: String(value) },
          { upsert: true, new: true }
        );
      } catch (mongoErr) {
        logger.warn(`Mongo setting sync warning for ${key}: ${mongoErr.message}`);
      }
    }
  }
  await stmt.finalize();
  logger.info('Configuration settings updated in database');
}
