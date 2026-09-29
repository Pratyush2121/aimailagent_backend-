import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDb, getSettings, saveSettings } from './db.js';
import { scrapeWebsite } from './services/scraperService.js';
import { generateEmailContent } from './services/aiService.js';
import { startEmailQueue, stopEmailQueue, startFollowupQueue, emailQueueEmitter, compileStaticTemplate } from './services/emailService.js';
import { syncReplies } from './services/imapService.js';
import logger from './logger.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Uploads directory configuration for Resume / Document files
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(cors({ origin: '*' })); // Enable CORS for React frontend (Vite)
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(uploadsDir));

// Multer storage setup for Resume files
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    const safeName = file.originalname.replace(/[^a-zA-Z0-9]/g, '_');
    cb(null, `resume_${Date.now()}_${safeName}${ext}`);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB strict max file size
});

// Utility: Helper to generate a random 8-character unique reference code (e.g. ZN-4F8A2)
function generateReferenceCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `ZN-${code}`;
}

import { isMongoConnected } from './services/mongoService.js';

// Health Check Endpoint (Verifies Express & MongoDB Atlas connection)
app.get('/api/health', async (req, res) => {
  const mongoStatus = isMongoConnected();
  res.json({
    success: true,
    status: 'online',
    appName: 'AI Mail Agent',
    managedBy: 'zonovatechnology.online',
    database: {
      sqlite: 'connected',
      mongodb: mongoStatus ? 'connected' : 'disconnected (set MONGODB_URI)'
    },
    timestamp: new Date().toISOString()
  });
});

// ----------------------------------------------------
// 1. Settings Routes
// ----------------------------------------------------
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await getSettings();
    // Mask sensitive credentials
    const maskedSettings = { ...settings };
    if (maskedSettings.smtp_pass) maskedSettings.smtp_pass = '********';
    if (maskedSettings.imap_pass) maskedSettings.imap_pass = '********';
    if (maskedSettings.gemini_api_key) maskedSettings.gemini_api_key = '********';
    if (maskedSettings.openai_api_key) maskedSettings.openai_api_key = '********';
    
    res.json({ success: true, settings: maskedSettings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const incoming = req.body;
    const current = await getSettings();
    
    // Merge, keeping previous passwords/keys if they are sent as the masked placeholder
    const toSave = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (value === '********') {
        toSave[key] = current[key] || '';
      } else {
        toSave[key] = value;
      }
    }
    
    await saveSettings(toSave);
    res.json({ success: true, message: 'Settings updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Resume File Upload Endpoint (Saves to local /uploads & records in DB settings for CDN/Mongo readiness)
app.post('/api/resume/upload', (req, res, next) => {
  upload.single('resume')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: 'File size limit exceeded! Resume file must be under 10MB.' });
      }
      return res.status(400).json({ success: false, error: err.message });
    } else if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No resume file uploaded' });
    }
    
    const protocol = req.protocol || 'http';
    const host = req.get('host') || 'localhost:3000';
    const fileUrl = `${protocol}://${host}/uploads/${req.file.filename}`;
    
    const settingsUpdate = {
      resume_filename: req.file.originalname,
      resume_saved_file: req.file.filename,
      resume_url: fileUrl,
      enable_resume_attachment: 'true'
    };

    await saveSettings(settingsUpdate);
    logger.info(`Resume uploaded: ${req.file.originalname} -> ${fileUrl}`);

    res.json({
      success: true,
      message: 'Resume PDF uploaded successfully! (Max 10MB limit enforced)',
      resume_url: fileUrl,
      resume_filename: req.file.originalname,
      resume_saved_file: req.file.filename
    });
  } catch (error) {
    logger.error(`Resume upload error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Download Endpoint for Malaysia Builders Leads CSV
app.get('/api/download/malaysia-leads', (req, res) => {
  const filePath = path.join(process.cwd(), 'malaysia_builders_leads.csv');
  if (fs.existsSync(filePath)) {
    res.download(filePath, 'malaysia_builders_leads.csv');
  } else {
    res.status(404).json({ success: false, error: 'CSV file not found' });
  }
});

// 1-Click Auto Seed Endpoint for Malaysian Builder Leads
app.post('/api/leads/seed-malaysia', async (req, res) => {
  try {
    const malaysiaLeads = [
      { name: 'Tan Sri Ahmad', company: 'Gamuda Berhad', website: 'https://gamuda.com.my', email: 'contact@gamuda.com.my', country: 'Malaysia', industry: 'Construction' },
      { name: 'Datuk Ken Lee', company: 'Sunway Construction', website: 'https://sunwayconstruction.com.my', email: 'info@sunwayconstruction.com.my', country: 'Malaysia', industry: 'Construction & Building' },
      { name: 'Steven Wong', company: 'IJM Corporation', website: 'https://ijm.com', email: 'enquiry@ijm.com', country: 'Malaysia', industry: 'Building & Infrastructure' },
      { name: 'David Chen', company: 'WCT Holdings', website: 'https://wct.com.my', email: 'enquiry@wct.com.my', country: 'Malaysia', industry: 'Construction & Engineering' },
      { name: 'Farhan Ismail', company: 'Kerjaya Prospek Group', website: 'https://kerjayagroup.com', email: 'info@kerjayagroup.com', country: 'Malaysia', industry: 'Building Construction' },
      { name: 'Rajesh Kumar', company: 'Binastra Construction', website: 'https://binastra.com.my', email: 'sales@binastra.com.my', country: 'Malaysia', industry: 'Building & Development' },
      { name: 'Grace Tan', company: 'Mitrajaya Holdings', website: 'https://mitrajaya.com.my', email: 'contact@mitrajaya.com.my', country: 'Malaysia', industry: 'Civil Engineering & Building' },
      { name: 'Marcus Lim', company: 'Gadang Holdings', website: 'https://gadang.com.my', email: 'info@gadang.com.my', country: 'Malaysia', industry: 'Construction & Infrastructure' },
      { name: 'Azman Yusof', company: 'Econpile Holdings', website: 'https://econpile.com', email: 'enquiry@econpile.com', country: 'Malaysia', industry: 'Foundation & Construction' },
      { name: 'Kelvin Ho', company: 'Inta Bina Group', website: 'https://intabina.com', email: 'info@intabina.com', country: 'Malaysia', industry: 'Building Contractor' },
      { name: 'Raymond Tee', company: 'Tuju Setia Berhad', website: 'https://tujusetia.my', email: 'info@tujusetia.my', country: 'Malaysia', industry: 'High-Rise Construction' },
      { name: 'Siti Aminah', company: 'Pesona Metro Holdings', website: 'https://pesonametro.com.my', email: 'contact@pesonametro.com.my', country: 'Malaysia', industry: 'Building Construction' },
      { name: 'Vikram Shah', company: 'Vizione Holdings', website: 'https://vizione.com.my', email: 'enquiry@vizione.com.my', country: 'Malaysia', industry: 'Construction & Property' },
      { name: 'Jason Ong', company: 'Crest Builder Holdings', website: 'https://crestbuilder.com.my', email: 'info@crestbuilder.com.my', country: 'Malaysia', industry: 'Building Contractor' },
      { name: 'Daniel Yong', company: 'Advancecon Holdings', website: 'https://advancecon.com.my', email: 'contact@advancecon.com.my', country: 'Malaysia', industry: 'Earthworks & Infrastructure' },
      { name: 'Nurul Huda', company: 'Southern Score Builders', website: 'https://southernscore.com.my', email: 'info@southernscore.com.my', country: 'Malaysia', industry: 'Residential & Commercial Building' },
      { name: 'Bernard Kwek', company: 'TRC Synergy', website: 'https://trc.com.my', email: 'enquiry@trc.com.my', country: 'Malaysia', industry: 'Infrastructure & Building' },
      { name: 'Chung Wei', company: 'Fajarbaru Builder Group', website: 'https://fajarbaru.com.my', email: 'info@fajarbaru.com.my', country: 'Malaysia', industry: 'Building Construction' },
      { name: 'Hafiz Razak', company: 'MGB Berhad', website: 'https://mgbgroup.com.my', email: 'contact@mgbgroup.com.my', country: 'Malaysia', industry: 'Construction & Precast' },
      { name: 'Alvin Yeoh', company: 'Melati Ehsan Holdings', website: 'https://melatiehsan.com.my', email: 'info@melatiehsan.com.my', country: 'Malaysia', industry: 'Turnkey Construction' },
      { name: 'Roslan Ibrahim', company: 'Systech Builders', website: 'https://systechbuilders.my', email: 'info@systechbuilders.my', country: 'Malaysia', industry: 'Smart Building & Construction' },
      { name: 'Gary Teoh', company: 'Apex Construction Enterprise', website: 'https://apexbuild.com.my', email: 'sales@apexbuild.com.my', country: 'Malaysia', industry: 'Commercial Builders' },
      { name: 'Kavitha Nair', company: 'Nusantara Builders', website: 'https://nusantarabuild.com.my', email: 'contact@nusantarabuild.com.my', country: 'Malaysia', industry: 'General Contractor' },
      { name: 'Desmond Liew', company: 'Summit Engineering & Building', website: 'https://summitbuild.com.my', email: 'info@summitbuild.com.my', country: 'Malaysia', industry: 'Industrial Construction' },
      { name: 'Zainal Abidin', company: 'Perdana Development & Construction', website: 'https://perdanabuilders.my', email: 'contact@perdanabuilders.my', country: 'Malaysia', industry: 'Building & Infrastructure' }
    ];

    const db = await getDb();
    const stmt = await db.prepare(
      `INSERT OR IGNORE INTO leads 
       (name, company, website, email, country, industry, reference_code) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    let importCount = 0;
    for (const lead of malaysiaLeads) {
      const refCode = generateReferenceCode();
      const result = await stmt.run(
        lead.name,
        lead.company,
        lead.website,
        lead.email.toLowerCase(),
        lead.country,
        lead.industry,
        refCode
      );
      if (result.changes > 0) importCount++;
    }
    await stmt.finalize();

    res.json({
      success: true,
      message: `Successfully loaded ${importCount} Malaysian builder leads into database!`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// 2. Leads Routes
// ----------------------------------------------------
app.get('/api/leads', async (req, res) => {
  try {
    const db = await getDb();
    const leads = await db.all('SELECT * FROM leads ORDER BY id DESC');
    res.json({ success: true, leads });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/leads', async (req, res) => {
  try {
    const { leads } = req.body; // Expects an array of leads
    if (!Array.isArray(leads)) {
      return res.status(400).json({ success: false, error: 'Leads must be an array' });
    }

    const db = await getDb();
    const stmt = await db.prepare(
      `INSERT OR IGNORE INTO leads 
       (name, company, website, email, country, industry, reference_code) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    let importCount = 0;
    for (const lead of leads) {
      if (!lead.email || !lead.name || !lead.company) continue;

      const refCode = lead.reference_code || generateReferenceCode();
      const result = await stmt.run(
        lead.name.trim(),
        lead.company.trim(),
        lead.website ? lead.website.trim() : null,
        lead.email.trim().toLowerCase(),
        lead.country ? lead.country.trim() : null,
        lead.industry ? lead.industry.trim() : null,
        refCode
      );

      // result.changes is 1 if inserted, 0 if ignored (duplicate email)
      if (result.changes > 0) {
        importCount++;
      }
    }
    await stmt.finalize();

    res.json({ success: true, message: `Successfully imported ${importCount} new leads.` });
  } catch (error) {
    logger.error(`Import failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/leads', async (req, res) => {
  try {
    const db = await getDb();
    await db.run('DELETE FROM leads');
    await db.run('DELETE FROM messages');
    res.json({ success: true, message: 'All leads and campaign histories cleared.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Single lead email generation preview (no send)
app.get('/api/leads/preview/:id', async (req, res) => {
  try {
    const db = await getDb();
    const lead = await db.get('SELECT * FROM leads WHERE id = ?', req.params.id);
    
    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    let webContext = '';
    if (lead.website) {
      const scrape = await scrapeWebsite(lead.website);
      if (scrape.success) webContext = scrape.bodyText;
    }

    const settings = await getSettings();
    const fromName = settings.smtp_from_name || 'Zonava Team';
    const useAi = settings.use_ai !== 'false';

    let emailContent;
    if (useAi) {
      emailContent = await generateEmailContent(lead, webContext, 'Cold Email');
    } else {
      const subjectTpl = settings.email_subject_template || 'partnership query for {{company}}';
      const bodyTpl = settings.email_body_template || 'Hi {{name}},\n\nRef: {{reference}}';
      emailContent = compileStaticTemplate(subjectTpl, bodyTpl, lead, fromName, settings.sender_company_name);
    }
    
    // Replace placeholder
    emailContent.body = emailContent.body.replace(/\[Sender Name\]/g, fromName);

    res.json({
      success: true,
      lead,
      preview: {
        subject: emailContent.subject,
        body: emailContent.body,
        scrapedContext: webContext ? webContext.slice(0, 500) + '...' : 'No context scraped'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// 3. Campaign Orchestration Routes
// ----------------------------------------------------
app.post('/api/campaign/start', async (req, res) => {
  // Start queue in background and return immediate confirmation
  startEmailQueue().catch(err => logger.error(`Background campaign queue error: ${err.message}`));
  res.json({ success: true, message: 'Campaign queue started in background' });
});

app.post('/api/campaign/stop', async (req, res) => {
  stopEmailQueue();
  res.json({ success: true, message: 'Campaign pause signal sent' });
});

app.post('/api/campaign/followups', async (req, res) => {
  const days = req.body.daysInterval || 3;
  startFollowupQueue(days).catch(err => logger.error(`Background follow-up queue error: ${err.message}`));
  res.json({ success: true, message: 'Follow-up campaign started in background' });
});

app.post('/api/campaign/sync-replies', async (req, res) => {
  // Sync inbox replies in background and return immediate response
  syncReplies()
    .then(result => {
      logger.info(`Sync replies completed in background. Success: ${result.success}, Count: ${result.replyCount}`);
    })
    .catch(err => logger.error(`Background reply sync error: ${err.message}`));
  
  res.json({ success: true, message: 'Inbox reply scanning triggered in background' });
});

// ----------------------------------------------------
// 4. Live Progress Server-Sent Events (SSE)
// ----------------------------------------------------
app.get('/api/campaign/status', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send a heartbeat ping every 10 seconds to keep connection alive
  const pingInterval = setInterval(() => {
    res.write(':\n\n');
  }, 10000);

  const onLog = (logData) => {
    res.write(`data: ${JSON.stringify({ type: 'log', data: logData })}\n\n`);
  };

  const onProgress = (progressData) => {
    res.write(`data: ${JSON.stringify({ type: 'progress', data: progressData })}\n\n`);
  };

  const onLeadUpdated = (leadData) => {
    res.write(`data: ${JSON.stringify({ type: 'lead-updated', data: leadData })}\n\n`);
  };

  const onFinished = () => {
    res.write(`data: ${JSON.stringify({ type: 'finished' })}\n\n`);
  };

  // Register listeners on global emitter
  emailQueueEmitter.on('log', onLog);
  emailQueueEmitter.on('progress', onProgress);
  emailQueueEmitter.on('lead-updated', onLeadUpdated);
  emailQueueEmitter.on('campaign-finished', onFinished);

  logger.info('Frontend dashboard subscribed to campaign status SSE stream');

  req.on('close', () => {
    clearInterval(pingInterval);
    emailQueueEmitter.off('log', onLog);
    emailQueueEmitter.off('progress', onProgress);
    emailQueueEmitter.off('lead-updated', onLeadUpdated);
    emailQueueEmitter.off('campaign-finished', onFinished);
    logger.info('Frontend dashboard unsubscribed from SSE stream');
  });
});

// ----------------------------------------------------
// 5. Campaign History Reports Export
// ----------------------------------------------------
app.get('/api/export/csv', async (req, res) => {
  try {
    const db = await getDb();
    const leads = await db.all('SELECT * FROM leads ORDER BY id ASC');
    
    // Construct CSV Header
    let csv = 'Name,Company,Website,Email,Country,Industry,Reference Code,Outbound Status,Reply Status,Reply Classification,Follow-ups Sent,Last Sent At\n';
    
    // Construct CSV Rows
    for (const lead of leads) {
      const escape = (text) => text ? `"${String(text).replace(/"/g, '""')}"` : '""';
      csv += [
        escape(lead.name),
        escape(lead.company),
        escape(lead.website),
        escape(lead.email),
        escape(lead.country),
        escape(lead.industry),
        escape(lead.reference_code),
        escape(lead.outbound_status),
        escape(lead.reply_status),
        escape(lead.reply_classification || ''),
        lead.followup_count,
        escape(lead.last_sent_at || '')
      ].join(',') + '\n';
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=cold_campaign_report.csv');
    res.status(200).send(csv);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/export/json', async (req, res) => {
  try {
    const db = await getDb();
    const leads = await db.all('SELECT * FROM leads ORDER BY id ASC');
    
    // For rich JSON export, we append actual email logs to each lead object
    const richLeads = [];
    for (const lead of leads) {
      const messages = await db.all('SELECT type, subject, body, status, error_message, sent_at FROM messages WHERE lead_id = ?', lead.id);
      richLeads.push({
        ...lead,
        messages
      });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=cold_campaign_report.json');
    res.status(200).json(richLeads);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Serve static frontend build if dist folder exists (Production single-port deployment)
const distPath = path.join(process.cwd(), '../frontend/dist');
const distLocalPath = path.join(process.cwd(), 'dist');
const finalDistPath = fs.existsSync(distLocalPath) ? distLocalPath : (fs.existsSync(distPath) ? distPath : null);

if (finalDistPath) {
  logger.info(`Serving production frontend from ${finalDistPath}`);
  app.use(express.static(finalDistPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
      return next();
    }
    res.sendFile(path.join(finalDistPath, 'index.html'));
  });
}

// Initialize database, then run server
getDb()
  .then(() => {
    app.listen(PORT, () => {
      logger.info(`Express server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    logger.error(`Failed to launch Express server: ${err.message}`);
    process.exit(1);
  });
