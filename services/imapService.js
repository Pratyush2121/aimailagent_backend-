import { ImapFlow } from 'imapflow';
import { getDb, getSettings } from '../db.js';
import { classifyInboxReply } from './aiService.js';
import { emailQueueEmitter } from './emailService.js';
import logger from '../logger.js';

function emitLog(message, level = 'info') {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  emailQueueEmitter.emit('log', { timestamp, level, message });
  logger.log(level, message);
}

/**
 * Connects to IMAP, scans inbox for replies from active leads,
 * classifies them, and updates lead statuses in the SQLite database.
 * @returns {Promise<{success: boolean, replyCount: number, error: string|null}>}
 */
export async function syncReplies() {
  const settings = await getSettings();
  
  const host = settings.imap_host || 'imap.gmail.com';
  const port = parseInt(settings.imap_port || '993');
  const secure = settings.imap_secure === 'true';
  const user = settings.imap_user;
  const pass = settings.imap_pass;

  if (!user || !pass) {
    emitLog('IMAP configuration is incomplete. Please configure IMAP user/pass in settings.', 'error');
    return { success: false, replyCount: 0, error: 'IMAP settings missing' };
  }

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: {
      user,
      pass
    },
    logger: false // Disable console flood
  });

  const db = await getDb();
  let replyCount = 0;

  try {
    emitLog('Connecting to IMAP server...');
    await client.connect();
    emitLog('Connected to IMAP server successfully.');

    // Find all leads who have been sent an email but haven't replied
    const activeLeads = await db.all(
      "SELECT * FROM leads WHERE outbound_status = 'Sent' AND reply_status = 'No Reply'"
    );

    if (activeLeads.length === 0) {
      emitLog('No active leads pending reply checks.');
      await client.logout();
      return { success: true, replyCount: 0, error: null };
    }

    emitLog(`Scanning inbox for responses from ${activeLeads.length} active leads...`);

    // Lock mailbox to prevent concurrent modifications
    let lock = await client.getMailboxLock('INBOX');
    
    try {
      for (const lead of activeLeads) {
        emitLog(`Searching inbox for messages from: ${lead.email}`);
        
        // Search for emails from the lead
        const uids = await client.search({ from: lead.email });
        
        if (uids.length > 0) {
          // Take the most recent email uid
          const latestUid = uids[uids.length - 1];
          emitLog(`Found reply from ${lead.email}! Fetching content...`);

          // Fetch message envelope and body parts
          const msg = await client.fetchOne(latestUid, {
            envelope: true,
            bodyParts: ['text', 'html']
          });

          const subject = msg.envelope?.subject || 'No Subject';
          let bodyText = '';

          // Extract text content
          if (msg.bodyParts && msg.bodyParts.has('text')) {
            bodyText = msg.bodyParts.get('text').toString();
          } else if (msg.bodyParts && msg.bodyParts.has('html')) {
            // Strip HTML tags for clean AI classification text
            const html = msg.bodyParts.get('html').toString();
            bodyText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          }

          emitLog(`Classifying reply from ${lead.name} using AI...`);
          const classification = await classifyInboxReply(subject, bodyText);
          emitLog(`Classification result: ${classification}`);

          // Update SQLite records
          await db.run(
            `UPDATE leads 
             SET reply_status = 'Replied', 
                 reply_classification = ? 
             WHERE id = ?`,
            classification,
            lead.id
          );

          await db.run(
            `INSERT INTO messages (lead_id, type, subject, body, status, sent_at)
             VALUES (?, 'Lead Reply', ?, ?, 'Received', ?)`,
            lead.id,
            subject,
            bodyText.slice(0, 1000), // Store preview of reply
            new Date().toISOString()
          );

          replyCount++;
          emailQueueEmitter.emit('lead-updated', { 
            id: lead.id, 
            reply_status: 'Replied',
            reply_classification: classification 
          });
          emitLog(`Lead ${lead.name} (${lead.company}) reply processed and marked as [${classification}]`);
        }
      }
    } finally {
      // Make sure we release the lock
      lock.release();
    }

    await client.logout();
    emitLog(`Inbox synchronization complete. Found ${replyCount} new replies.`);
    return { success: true, replyCount, error: null };

  } catch (error) {
    emitLog(`IMAP sync failed: ${error.message}`, 'error');
    try {
      await client.logout();
    } catch (_) {}
    return { success: false, replyCount: 0, error: error.message };
  }
}
