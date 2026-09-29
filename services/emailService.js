import nodemailer from 'nodemailer';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { getDb, getSettings, getSetting } from '../db.js';
import { scrapeWebsite } from './scraperService.js';
import { generateEmailContent } from './aiService.js';
import logger from '../logger.js';

export const emailQueueEmitter = new EventEmitter();

/**
 * Compiles a static subject and body template by replacing placeholders with lead variables.
 * Supports flexible tag formats: {{name}}, {name}, [Name], [First Name], {{company}}, {company}, [Company], {resume_url}, etc.
 */
export function compileStaticTemplate(subjectTemplate, bodyTemplate, lead, fromName, companyName, resumeUrl) {
  let subject = subjectTemplate || 'Partnership inquiry for {{company}}';
  let body = bodyTemplate || 'Hi {{name}},\n\nI came across {{company}} and would love to connect.\n\nBest,\n{{sender_name}}\n\nRef: {{reference}}';

  const leadName = (lead.name || '').trim();
  const leadCompany = (lead.company || '').trim();
  const leadEmail = (lead.email || '').trim();
  const leadWebsite = (lead.website || '').trim();
  const leadCountry = (lead.country || '').trim();
  const leadIndustry = (lead.industry || 'Software / Tech').trim();
  const leadRole = (lead.role || lead.industry || 'Software Engineer').trim();
  const leadRef = (lead.reference_code || '').trim();
  const senderName = (fromName || 'Candidate').trim();
  const senderCompany = (companyName || '').trim();
  const candidateResume = (resumeUrl || '').trim();

  // Flexible Regex Patterns for common placeholder tags
  const nameRegex = /({{\s*name\s*}}|{\s*name\s*}|\[\s*name\s*\]|<\s*name\s*>|{{\s*Name\s*}}|{\s*Name\s*}|\[\s*Name\s*\]|{{\s*hr_name\s*}}|{\s*hr_name\s*}|\[\s*hr_name\s*\]|{{\s*first_name\s*}}|{\s*first_name\s*}|\[\s*first_name\s*\])/gi;
  const companyRegex = /({{\s*company\s*}}|{\s*company\s*}|\[\s*company\s*\]|<\s*company\s*>|{{\s*Company\s*}}|{\s*Company\s*}|\[\s*Company\s*\]|{{\s*company_name\s*}}|{\s*company_name\s*}|\[\s*company_name\s*\])/gi;
  const emailRegex = /({{\s*email\s*}}|{\s*email\s*}|\[\s*email\s*\]|<\s*email\s*>|{{\s*Email\s*}}|{\s*Email\s*}|\[\s*Email\s*\]|{{\s*hr_email\s*}}|{\s*hr_email\s*})/gi;
  const roleRegex = /({{\s*role\s*}}|{\s*role\s*}|\[\s*role\s*\]|<\s*role\s*>|{{\s*position\s*}}|{\s*position\s*}|\[\s*position\s*\]|{{\s*job_role\s*}}|{\s*job_role\s*})/gi;
  const websiteRegex = /({{\s*website\s*}}|{\s*website\s*}|\[\s*website\s*\]|<\s*website\s*>|{{\s*Website\s*}}|{\s*Website\s*}|\[\s*Website\s*\]|{{\s*portfolio\s*}}|{\s*portfolio\s*})/gi;
  const countryRegex = /({{\s*country\s*}}|{\s*country\s*}|\[\s*country\s*\]|<\s*country\s*>|{{\s*Country\s*}}|{\s*Country\s*}|\[\s*Country\s*\])/gi;
  const industryRegex = /({{\s*industry\s*}}|{\s*industry\s*}|\[\s*industry\s*\]|<\s*industry\s*>|{{\s*Industry\s*}}|{\s*Industry\s*}|\[\s*Industry\s*\])/gi;
  const referenceRegex = /({{\s*reference\s*}}|{\s*reference\s*}|\[\s*reference\s*\]|<\s*reference\s*>|{{\s*Reference\s*}}|{\s*Reference\s*}|\[\s*Reference\s*\]|{{\s*ref\s*}}|{\s*ref\s*}|\[\s*ref\s*\])/gi;
  const senderNameRegex = /({{\s*sender_name\s*}}|{\s*sender_name\s*}|\[\s*sender_name\s*\]|<\s*sender_name\s*>|\[\s*Sender\s+Name\s*\]|{{\s*Sender\s+Name\s*}}|{\s*Sender\s+Name\s*}|{{\s*candidate_name\s*}}|{\s*candidate_name\s*}|{{\s*applicant_name\s*}}|{\s*applicant_name\s*})/gi;
  const senderCompanyRegex = /({{\s*sender_company_name\s*}}|{\s*sender_company_name\s*}|\[\s*sender_company_name\s*\]|<\s*sender_company_name\s*>|{{\s*sender_company\s*}}|{\s*sender_company\s*})/gi;
  const resumeRegex = /({{\s*resume_url\s*}}|{\s*resume_url\s*}|\[\s*resume_url\s*\]|<\s*resume_url\s*>|{{\s*resume\s*}}|{\s*resume\s*}|\[\s*resume\s*\])/gi;

  let compiledSubject = subject
    .replace(nameRegex, leadName)
    .replace(companyRegex, leadCompany)
    .replace(emailRegex, leadEmail)
    .replace(roleRegex, leadRole)
    .replace(websiteRegex, leadWebsite)
    .replace(countryRegex, leadCountry)
    .replace(industryRegex, leadIndustry)
    .replace(referenceRegex, leadRef)
    .replace(senderNameRegex, senderName)
    .replace(senderCompanyRegex, senderCompany)
    .replace(resumeRegex, candidateResume);

  let compiledBody = body
    .replace(nameRegex, leadName)
    .replace(companyRegex, leadCompany)
    .replace(emailRegex, leadEmail)
    .replace(roleRegex, leadRole)
    .replace(websiteRegex, leadWebsite)
    .replace(countryRegex, leadCountry)
    .replace(industryRegex, leadIndustry)
    .replace(referenceRegex, leadRef)
    .replace(senderNameRegex, senderName)
    .replace(senderCompanyRegex, senderCompany)
    .replace(resumeRegex, candidateResume);

  return { subject: compiledSubject, body: compiledBody };
}

let isQueueRunning = false;
let stopQueueRequested = false;

// Statistics for the active run
let runStats = {
  totalLeads: 0,
  processedCount: 0,
  successCount: 0,
  failedCount: 0,
  currentLeadName: ''
};

/**
 * Creates a Nodemailer Transporter using settings stored in the database
 */
async function createTransporter() {
  const settings = await getSettings();
  
  const host = settings.smtp_host || 'smtp.gmail.com';
  const port = parseInt(settings.smtp_port || '465');
  const secure = settings.smtp_secure === 'true';
  const user = settings.smtp_user;
  const pass = settings.smtp_pass;

  if (!user || !pass) {
    throw new Error('SMTP user and pass credentials are not configured in settings');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass
    }
  });
}

function emitLog(message, level = 'info') {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  emailQueueEmitter.emit('log', { timestamp, level, message });
  logger.log(level, message);
}

function emitProgress() {
  emailQueueEmitter.emit('progress', {
    ...runStats,
    percentage: runStats.totalLeads > 0 
      ? Math.round((runStats.processedCount / runStats.totalLeads) * 100) 
      : 0
  });
}

/**
 * Helper to sleep for a given number of milliseconds
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stops any running email campaign queue
 */
export function stopEmailQueue() {
  if (isQueueRunning) {
    stopQueueRequested = true;
    emitLog('Campaign pause requested. Completing current send, then pausing...', 'warn');
  }
}

/**
 * Launches the email queue for pending outbound cold emails
 */
export async function startEmailQueue() {
  if (isQueueRunning) {
    emitLog('Campaign is already running', 'warn');
    return;
  }

  isQueueRunning = true;
  stopQueueRequested = false;
  
  const db = await getDb();
  
  try {
    // Fetch pending leads
    const leads = await db.all(
      "SELECT * FROM leads WHERE outbound_status IN ('Pending', 'Failed') ORDER BY id ASC"
    );

    if (leads.length === 0) {
      emitLog('No pending or failed leads found to process.');
      isQueueRunning = false;
      return;
    }

    runStats = {
      totalLeads: leads.length,
      processedCount: 0,
      successCount: 0,
      failedCount: 0,
      currentLeadName: ''
    };
    
    emitLog(`Starting campaign for ${leads.length} leads...`);
    emitProgress();

    const transporter = await createTransporter();
    // Verify connection configuration
    await transporter.verify();
    emitLog('SMTP Connection successfully verified.');

    const settings = await getSettings();
    const fromName = settings.smtp_from_name || 'Zonava Team';
    const fromEmail = settings.smtp_user;

    for (let i = 0; i < leads.length; i++) {
      if (stopQueueRequested) {
        emitLog('Campaign paused by user.', 'warn');
        break;
      }

      const lead = leads[i];
      runStats.currentLeadName = `${lead.name} (${lead.company})`;
      emitProgress();

      emitLog(`[${i+1}/${leads.length}] Processing lead: ${lead.name} from ${lead.company}`);

      // 1. Update lead status to Personalizing
      await db.run("UPDATE leads SET outbound_status = 'Personalizing' WHERE id = ?", lead.id);
      emailQueueEmitter.emit('lead-updated', { id: lead.id, outbound_status: 'Personalizing' });

      // 2. Scrape website if available
      let websiteContext = '';
      if (lead.website) {
        emitLog(`Scraping website for lead: ${lead.website}`);
        const scrapeResult = await scrapeWebsite(lead.website);
        if (scrapeResult.success) {
          websiteContext = scrapeResult.bodyText;
        }
      }

      // 3. Generate email subject and body (AI or Static Template)
      let emailContent;
      const isResumeMode = settings.campaign_mode === 'resume' || settings.enable_resume_attachment === 'true';
      const useAi = settings.use_ai === 'true' && !isResumeMode;

      if (useAi) {
        emitLog('Generating email copy using AI...');
        try {
          emailContent = await generateEmailContent(lead, websiteContext, 'Cold Email');
        } catch (aiError) {
          emitLog(`AI Generation failed: ${aiError.message}. Using default fallback copy.`, 'warn');
          emailContent = {
            subject: `Job Application for ${lead.company} - ${fromName}`,
            body: `Dear ${lead.name},\n\nI am writing to express my strong interest in opportunities at ${lead.company}.\n\nPlease find my resume attached for your review.\n\nBest regards,\n${fromName}`
          };
        }
      } else {
        emitLog('Compiling configured Job Application / Candidate Resume email template...');
        const subjectTpl = settings.email_subject_template || 'Application for {{role}} at {{company}} - {{candidate_name}}';
        const bodyTpl = settings.email_body_template || 'Dear {{name}},\n\nI am writing to express my interest in {{role}} opportunities at {{company}}.\n\nMy resume is attached for your review.\n\nBest regards,\n{{candidate_name}}';
        emailContent = compileStaticTemplate(subjectTpl, bodyTpl, lead, fromName, settings.sender_company_name, settings.resume_url);
      }

      // Replace custom [Sender Name] token with the fromName setting
      const customizedBody = emailContent.body.replace(/\[Sender Name\]/g, fromName);

      // 4. Send Email via SMTP
      await db.run("UPDATE leads SET outbound_status = 'Sending' WHERE id = ?", lead.id);
      emailQueueEmitter.emit('lead-updated', { id: lead.id, outbound_status: 'Sending' });

      const mailOptions = {
        from: `"${fromName}" <${fromEmail}>`,
        to: lead.email,
        subject: emailContent.subject,
        text: customizedBody
      };

      // Attach Resume PDF ONLY IF enable_resume_attachment is explicitly 'true' OR campaign_mode is 'resume'
      if (isResumeMode && settings.resume_saved_file) {
        const filePath = path.join(process.cwd(), 'uploads', settings.resume_saved_file);
        if (fs.existsSync(filePath)) {
          mailOptions.attachments = [{
            filename: settings.resume_filename || 'Resume.pdf',
            path: filePath
          }];
        }
      }

      let success = false;
      let errorMsg = null;
      let attempt = 0;
      const maxRetries = 3;

      while (attempt < maxRetries && !success) {
        attempt++;
        try {
          emitLog(`Dispatching email to ${lead.email} (Attempt ${attempt}/${maxRetries})...`);
          await transporter.sendMail(mailOptions);
          success = true;
        } catch (smtpError) {
          errorMsg = smtpError.message;
          emitLog(`Attempt ${attempt} failed: ${smtpError.message}`, 'warn');
          if (attempt < maxRetries) {
            // Short backoff delay on retry
            await sleep(3000);
          }
        }
      }

      const timestamp = new Date().toISOString();

      if (success) {
        // 5. Success states - Update database
        await db.run(
          `UPDATE leads 
           SET outbound_status = 'Sent', 
               company_summary = ?, 
               niche = ?, 
               last_sent_at = ?,
               next_followup_at = datetime('now', '+3 days') 
           WHERE id = ?`,
          websiteContext.slice(0, 1000), // Summarized text
          lead.industry || 'Unknown Niche',
          timestamp,
          lead.id
        );

        await db.run(
          `INSERT INTO messages (lead_id, type, subject, body, status, sent_at) 
           VALUES (?, 'Cold Email', ?, ?, 'Success', ?)`,
          lead.id,
          emailContent.subject,
          customizedBody,
          timestamp
        );

        runStats.successCount++;
        emitLog(`Email successfully sent to ${lead.email}`);
        emailQueueEmitter.emit('lead-updated', { id: lead.id, outbound_status: 'Sent', last_sent_at: timestamp });
      } else {
        // 6. Fail states - Update database
        await db.run("UPDATE leads SET outbound_status = 'Failed' WHERE id = ?", lead.id);
        
        await db.run(
          `INSERT INTO messages (lead_id, type, subject, body, status, error_message, sent_at) 
           VALUES (?, 'Cold Email', ?, ?, 'Failed', ?, ?)`,
          lead.id,
          emailContent.subject,
          customizedBody,
          errorMsg,
          timestamp
        );

        runStats.failedCount++;
        emitLog(`Failed to send email to ${lead.email} after ${maxRetries} attempts: ${errorMsg}`, 'error');
        emailQueueEmitter.emit('lead-updated', { id: lead.id, outbound_status: 'Failed' });
      }

      runStats.processedCount++;
      emitProgress();

      // 7. High-speed send delay (Default: 1 second per email)
      if (i < leads.length - 1 && !stopQueueRequested) {
        const delaySec = settings.send_delay_seconds !== undefined && settings.send_delay_seconds !== '' 
          ? Math.max(0, parseInt(settings.send_delay_seconds)) 
          : 1;
        if (delaySec > 0) {
          emitLog(`Fast queue: Waiting ${delaySec}s before sending next email...`);
          for (let sec = 0; sec < delaySec; sec++) {
            if (stopQueueRequested) break;
            await sleep(1000);
          }
        }
      }
    }

    emitLog(`Campaign sequence completed. Successes: ${runStats.successCount}, Failures: ${runStats.failedCount}`);

  } catch (error) {
    emitLog(`Campaign critical failure: ${error.message}`, 'error');
  } finally {
    isQueueRunning = false;
    stopQueueRequested = false;
    emailQueueEmitter.emit('campaign-finished');
  }
}

/**
 * Checks for follow-up emails that are due and dispatches them
 */
export async function startFollowupQueue(daysInterval = 3) {
  if (isQueueRunning) {
    emitLog('Cannot run follow-up campaign. Outbound campaign queue is currently running.', 'warn');
    return;
  }

  isQueueRunning = true;
  stopQueueRequested = false;
  const db = await getDb();

  try {
    // Find leads where:
    // 1. outbound_status is 'Sent' (initial was sent)
    // 2. reply_status is 'No Reply' (they haven't replied)
    // 3. followup_count < 3 (maximum 3 follow-ups allowed)
    // 4. next_followup_at is in the past (due to send)
    const leads = await db.all(
      `SELECT * FROM leads 
       WHERE outbound_status = 'Sent' 
         AND reply_status = 'No Reply' 
         AND followup_count < 3 
         AND next_followup_at <= datetime('now')`
    );

    if (leads.length === 0) {
      emitLog('No follow-up emails are currently scheduled or due.');
      isQueueRunning = false;
      return;
    }

    runStats = {
      totalLeads: leads.length,
      processedCount: 0,
      successCount: 0,
      failedCount: 0,
      currentLeadName: ''
    };

    emitLog(`Starting follow-up campaign for ${leads.length} due leads...`);
    emitProgress();

    const transporter = await createTransporter();
    const settings = await getSettings();
    const fromName = settings.smtp_from_name || 'Zonava Team';
    const fromEmail = settings.smtp_user;

    for (let i = 0; i < leads.length; i++) {
      if (stopQueueRequested) {
        emitLog('Follow-up campaign paused by user.', 'warn');
        break;
      }

      const lead = leads[i];
      runStats.currentLeadName = `${lead.name} (${lead.company})`;
      emitProgress();

      const nextFollowupIndex = lead.followup_count + 1;
      const emailType = `Follow-up ${nextFollowupIndex}`;

      emitLog(`[${i+1}/${leads.length}] Creating follow-up email ${nextFollowupIndex}/3 for ${lead.name}`);

      // Get previous thread history for context
      const previousMessages = await db.all(
        'SELECT type, subject, body FROM messages WHERE lead_id = ? AND status = "Success" ORDER BY id ASC',
        lead.id
      );

      // Scrape website again or fetch previous context summary
      let websiteContext = lead.company_summary || '';

      // Generate Follow-up body (AI or Static Template)
      let emailContent;
      const useAi = settings.use_ai !== 'false';

      if (useAi) {
        emitLog(`Generating follow-up AI content...`);
        try {
          emailContent = await generateEmailContent(lead, websiteContext, emailType, previousMessages);
        } catch (aiError) {
          emitLog(`AI follow-up generation failed: ${aiError.message}. Using default copy.`, 'warn');
          emailContent = {
            subject: `Re: partnership query for ${lead.company}`,
            body: `Hi ${lead.name},\n\nJust checking if you saw my previous note. Let me know if next week works for a quick 10-minute chat.\n\nBest,\n[Sender Name]\n\nRef: ${lead.reference_code}`
          };
        }
      } else {
        emitLog(`Bypassing AI. Compiling static follow-up template...`);
        const subjectTpl = `Re: ${previousMessages[0]?.subject || 'quick question'}`;
        const bodyTpl = `Hi {{name}},\n\nJust wanted to follow up on my previous note. Let me know if next week works for a quick 10-minute chat.\n\nBest,\n{{sender_name}}\n\nRef: ${lead.reference_code}`;
        emailContent = compileStaticTemplate(subjectTpl, bodyTpl, lead, fromName, settings.sender_company_name);
      }

      const customizedBody = emailContent.body.replace(/\[Sender Name\]/g, fromName);

      // Construct mail options
      const mailOptions = {
        from: `"${fromName}" <${fromEmail}>`,
        to: lead.email,
        subject: emailContent.subject,
        text: customizedBody
      };

      let success = false;
      let errorMsg = null;
      let attempt = 0;
      const maxRetries = 3;

      while (attempt < maxRetries && !success) {
        attempt++;
        try {
          emitLog(`Dispatching follow-up to ${lead.email} (Attempt ${attempt}/${maxRetries})...`);
          await transporter.sendMail(mailOptions);
          success = true;
        } catch (smtpError) {
          errorMsg = smtpError.message;
          emitLog(`Attempt ${attempt} failed: ${smtpError.message}`, 'warn');
          if (attempt < maxRetries) {
            await sleep(3000);
          }
        }
      }

      const timestamp = new Date().toISOString();

      if (success) {
        // Update database with next follow-up scheduled for 3 days in the future
        await db.run(
          `UPDATE leads 
           SET followup_count = followup_count + 1, 
               last_sent_at = ?,
               next_followup_at = datetime('now', ? || ' days') 
           WHERE id = ?`,
          timestamp,
          `+${daysInterval}`,
          lead.id
        );

        await db.run(
          `INSERT INTO messages (lead_id, type, subject, body, status, sent_at) 
           VALUES (?, ?, ?, ?, 'Success', ?)`,
          lead.id,
          emailType,
          emailContent.subject,
          customizedBody,
          timestamp
        );

        runStats.successCount++;
        emitLog(`Follow-up sent successfully to ${lead.email}`);
        emailQueueEmitter.emit('lead-updated', { id: lead.id, followup_count: nextFollowupIndex, last_sent_at: timestamp });
      } else {
        await db.run(
          `INSERT INTO messages (lead_id, type, subject, body, status, error_message, sent_at) 
           VALUES (?, ?, ?, ?, 'Failed', ?, ?)`,
          lead.id,
          emailType,
          emailContent.subject,
          customizedBody,
          errorMsg,
          timestamp
        );

        runStats.failedCount++;
        emitLog(`Failed to send follow-up to ${lead.email}: ${errorMsg}`, 'error');
      }

      runStats.processedCount++;
      emitProgress();

      // High-speed send delay (Default: 1 second per email)
      if (i < leads.length - 1 && !stopQueueRequested) {
        const delaySec = settings.send_delay_seconds !== undefined && settings.send_delay_seconds !== '' 
          ? Math.max(0, parseInt(settings.send_delay_seconds)) 
          : 1;
        if (delaySec > 0) {
          emitLog(`Fast queue: Waiting ${delaySec}s before sending next email...`);
          for (let sec = 0; sec < delaySec; sec++) {
            if (stopQueueRequested) break;
            await sleep(1000);
          }
        }
      }
    }

    emitLog(`Follow-up campaign completed. Successes: ${runStats.successCount}, Failures: ${runStats.failedCount}`);

  } catch (error) {
    emitLog(`Follow-up campaign critical failure: ${error.message}`, 'error');
  } finally {
    isQueueRunning = false;
    stopQueueRequested = false;
    emailQueueEmitter.emit('campaign-finished');
  }
}
