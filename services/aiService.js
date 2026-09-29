import axios from 'axios';
import OpenAI from 'openai';
import { getSettings } from '../db.js';
import logger from '../logger.js';

/**
 * Sends a prompt to the configured LLM (Gemini or OpenAI)
 * @param {string} systemPrompt 
 * @param {string} userPrompt 
 * @returns {Promise<string>} JSON response text
 */
async function callLLM(systemPrompt, userPrompt) {
  const settings = await getSettings();
  const provider = settings.ai_provider || 'gemini';

  if (provider === 'gemini') {
    const apiKey = settings.gemini_api_key;
    if (!apiKey) {
      throw new Error('Gemini API key is not configured in settings');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    
    // For Gemini, we combine system instruction and user content
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: `System Instruction:\n${systemPrompt}\n\nUser Input:\n${userPrompt}` }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json'
      }
    };

    try {
      const response = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('Invalid response structure from Gemini API');
      }
      return text;
    } catch (error) {
      const apiErr = error.response?.data?.error?.message || error.message;
      logger.error(`Gemini API Call failed: ${apiErr}`);
      throw new Error(`Gemini API Error: ${apiErr}`);
    }
  } else if (provider === 'openai') {
    const apiKey = settings.openai_api_key;
    if (!apiKey) {
      throw new Error('OpenAI API Key is not configured in settings');
    }

    try {
      const openai = new OpenAI({ apiKey });
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' }
      });
      return response.choices[0].message.content;
    } catch (error) {
      logger.error(`OpenAI API Call failed: ${error.message}`);
      throw new Error(`OpenAI API Error: ${error.message}`);
    }
  } else {
    throw new Error(`Unsupported AI Provider: ${provider}`);
  }
}

/**
 * Generates a highly personalized, human-sounding cold email or follow-up
 * @param {Object} lead - Lead database row
 * @param {string} websiteContext - Text scraped from website (if any)
 * @param {string} emailType - 'Cold Email', 'Follow-up 1', 'Follow-up 2', 'Follow-up 3'
 * @param {Array} previousThread - Array of previously sent messages (for follow-up context)
 * @returns {Promise<{subject: string, body: string}>}
 */
export async function generateEmailContent(lead, websiteContext, emailType = 'Cold Email', previousThread = []) {
  const settings = await getSettings();
  const companyName = settings.sender_company_name || 'Zonava';
  const companyDesc = settings.sender_company_description || '';

  const isFollowUp = emailType !== 'Cold Email';

  const systemPrompt = `You are an expert, elite sales copywriter who specializes in highly personalized, conversion-driven B2B cold outbound campaigns.
Your goal is to write a short, direct, highly human-sounding email.

CRITICAL INSTRUCTIONS:
1. WORD COUNT LIMIT: Strictly keep the email under 120 words for cold emails, and under 80 words for follow-up emails.
2. TONE & HUMANITY:
   - Use a casual, warm, conversational, professional human tone.
   - Do NOT use typical AI opening hooks (e.g. "I hope this email finds you well", "Dear [Name]", "Greetings", "Hope you're having a great week", "My name is...").
   - Open directly with the hook or visual detail.
   - Do not sound overly excited, no multiple exclamation marks.
   - No salesy fluff, buzzwords, or fake-sounding compliments.
3. CONTEXT MATCHING:
   - Identify the lead's niche, core product, or operational bottleneck from the lead details.
   - Pitch the specific service from ${companyName} that matches their profile.
   - ${companyName}'s offerings: ${companyDesc}.
   - Bring up ${companyName} naturally and contextually. Do not just pitch immediately; bridge it with a specific observation from their business.
4. NO REPETITION / DUPLICATION:
   - Ensure the hook is unique and mentions specific details from their industry/country/website.
5. JSON OUTPUT FORMAT:
   You must respond ONLY with a JSON object in this format:
   {
     "subject": "Subject line here (must be catchy, low-pressure, lowercase friendly, e.g. 'quick question')",
     "body": "Plain text email body here. Use single line breaks for paragraphs. Keep it short. End with a simple signature like 'Best, [Sender Name]'. Use [Sender Name] as a placeholder for the sender signature."
   }`;

  let userPrompt = `## Sender Context
Sender Company: ${companyName}
Sender Offerings: ${companyDesc}

## Lead Details
Lead Name: ${lead.name}
Lead Company: ${lead.company}
Lead Website: ${lead.website || 'N/A'}
Lead Country: ${lead.country || 'N/A'}
Lead Industry: ${lead.industry || 'N/A'}
Lead Unique Reference Code: ${lead.reference_code}

## Scraped Website Context
${websiteContext || 'No homepage text available. Use their industry/company name for context.'}`;

  if (isFollowUp) {
    const threadHistory = previousThread.map(m => `Type: ${m.type}\nSubject: ${m.subject}\nBody:\n${m.body}`).join('\n\n---\n\n');
    userPrompt += `\n\n## Action Required
Write a follow-up email. This is ${emailType} (Max 3 follow-ups total).
Do NOT rewrite a long pitch. Keep it to 1-3 sentences (under 80 words). Be casual, low pressure, checking in on the previous note. Reference the unique code if helpful.

Here is the thread history of what we sent previously:
${threadHistory}`;
  } else {
    userPrompt += `\n\n## Action Required
Write the initial 'Cold Email'. Leverage their website context to make a specific observation about their company/niche and bridge it to one of ${companyName}'s offerings (e.g., MVP development, custom AI automation, growth consulting, SEO/marketing). Place their unique reference code (${lead.reference_code}) organically inside the email as a reference identifier (e.g., 'Ref: ${lead.reference_code}' at the bottom, or in a sentence).`;
  }

  try {
    const responseText = await callLLM(systemPrompt, userPrompt);
    const parsed = JSON.parse(responseText);

    if (!parsed.subject || !parsed.body) {
      throw new Error('AI response is missing subject or body field');
    }

    return {
      subject: parsed.subject.trim(),
      body: parsed.body.trim()
    };
  } catch (error) {
    logger.warn(`AI generation failed: ${error.message} - Using high-quality default fallback`);
    // Safe fallback copy
    const pitch = lead.industry === 'Startup' 
      ? `building custom MVPs or scaling startup dev sprints`
      : `automating manual operations and integrating custom AI/LLM tools`;
    
    if (isFollowUp) {
      return {
        subject: `Re: quick question for ${lead.company}`,
        body: `Hi ${lead.name},\n\nJust checking if you saw my previous note about how we're helping companies in the ${lead.industry || 'software'} space scale their tech. Open to a 10-minute chat next week?\n\nBest,\n[Sender Name]\n\nRef: ${lead.reference_code}`
      };
    } else {
      return {
        subject: `partnership query for ${lead.company}`,
        body: `Hi ${lead.name},\n\nI came across ${lead.company} and noticed what you are building. We work with companies like yours at ${companyName} to handle ${pitch}.\n\nWould you be open to a casual 10-minute chat next Thursday to see if we can collaborate?\n\nBest,\n[Sender Name]\n\nRef: ${lead.reference_code}`
      };
    }
  }
}

/**
 * Classifies an incoming reply into one of five categories
 * @param {string} replySubject 
 * @param {string} replyBody 
 * @returns {Promise<string>} 'Interested', 'Not Interested', 'Follow Later', 'Pricing', 'Meeting Request'
 */
export async function classifyInboxReply(replySubject, replyBody) {
  const systemPrompt = `You are an AI email classifier. Your task is to read an incoming reply to a cold email outreach and classify it into EXACTLY one of these five categories:
1. "Interested" - The lead shows general interest, asks questions, or asks for more info.
2. "Not Interested" - The lead explicitly declines, tells you to stop emailing, says they already have a solution, or unsubscribes.
3. "Follow Later" - The lead asks you to contact them at a later date, next quarter, or when they are less busy.
4. "Pricing" - The lead specifically asks about costs, pricing, packages, or rates.
5. "Meeting Request" - The lead proposes a call, asks for a calendar link, suggests a time, or requests a meeting.

You must respond ONLY with a JSON object in this format:
{
  "classification": "Interested" | "Not Interested" | "Follow Later" | "Pricing" | "Meeting Request"
}`;

  const userPrompt = `Subject: ${replySubject}\nBody:\n${replyBody}`;

  try {
    const responseText = await callLLM(systemPrompt, userPrompt);
    const parsed = JSON.parse(responseText);
    
    const validCategories = ['Interested', 'Not Interested', 'Follow Later', 'Pricing', 'Meeting Request'];
    const classification = parsed.classification;

    if (validCategories.includes(classification)) {
      return classification;
    }
    return 'Interested'; // Default fallback classification
  } catch (error) {
    logger.warn(`AI classification failed: ${error.message} - defaulting to 'Interested'`);
    return 'Interested';
  }
}
