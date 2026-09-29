import mongoose from 'mongoose';
import logger from '../logger.js';

let isConnected = false;

// Lead Mongoose Schema
const leadSchema = new mongoose.Schema({
  name: { type: String, required: true },
  company: { type: String, required: true },
  website: { type: String },
  email: { type: String, required: true, unique: true },
  country: { type: String },
  industry: { type: String },
  reference_code: { type: String, required: true, unique: true },
  company_summary: { type: String },
  niche: { type: String },
  outbound_status: { type: String, default: 'Pending' },
  reply_status: { type: String, default: 'No Reply' },
  reply_classification: { type: String },
  followup_count: { type: Number, default: 0 },
  last_sent_at: { type: String },
  next_followup_at: { type: String },
  created_at: { type: Date, default: Date.now }
});

// Message Mongoose Schema
const messageSchema = new mongoose.Schema({
  lead_id: { type: String, required: true },
  type: { type: String, required: true },
  subject: { type: String, required: true },
  body: { type: String, required: true },
  status: { type: String, required: true },
  error_message: { type: String },
  sent_at: { type: Date, default: Date.now }
});

// Setting Mongoose Schema
const settingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: String, required: true }
});

export const LeadModel = mongoose.model('Lead', leadSchema);
export const MessageModel = mongoose.model('Message', messageSchema);
export const SettingModel = mongoose.model('Setting', settingSchema);

/**
 * Connects to MongoDB Atlas securely using MONGODB_URI
 */
export async function connectMongo() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    logger.warn('MONGODB_URI not provided. Skipping MongoDB Atlas connection.');
    return false;
  }

  if (isConnected) return true;

  try {
    mongoose.set('strictQuery', false);
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    isConnected = true;
    logger.info('✅ Successfully connected to MongoDB Atlas Production Database!');

    mongoose.connection.on('error', (err) => {
      logger.error(`MongoDB connection error: ${err.message}`);
      isConnected = false;
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected. Attempting reconnection...');
      isConnected = false;
    });

    return true;
  } catch (error) {
    logger.error(`❌ MongoDB Atlas Connection Failed: ${error.message}`);
    isConnected = false;
    return false;
  }
}

export function isMongoConnected() {
  return isConnected && mongoose.connection.readyState === 1;
}
