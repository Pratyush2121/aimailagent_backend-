import app from '../server.js';
import { getDb } from '../db.js';

export default async function handler(req, res) {
  try {
    await getDb();
  } catch (err) {
    console.error('Database connection error in Vercel handler:', err);
  }
  return app(req, res);
}
