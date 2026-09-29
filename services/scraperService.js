import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import logger from '../logger.js';

// Relaxed HTTPS agent to fetch sites with invalid/expired SSL certificates (common in local B2B leads)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

const client = axios.create({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
  },
  httpsAgent
});

/**
 * Scrapes the target website and extracts key text and metadata
 * @param {string} url - Target company homepage URL
 * @returns {Promise<{title: string, description: string, bodyText: string, success: boolean}>}
 */
export async function scrapeWebsite(url) {
  if (!url) {
    return { title: '', description: '', bodyText: '', success: false };
  }

  // Ensure protocol is attached
  let formattedUrl = url.trim();
  if (!/^https?:\/\//i.test(formattedUrl)) {
    formattedUrl = `https://${formattedUrl}`;
  }

  try {
    logger.info(`Scraping company website: ${formattedUrl}`);
    const response = await client.get(formattedUrl);
    const html = response.data;
    
    if (typeof html !== 'string') {
      throw new Error('Response data is not a string');
    }

    const $ = cheerio.load(html);

    // Remove script, style, SVG, noscript, and iframe blocks
    $('script, style, svg, noscript, iframe, head').remove();

    // Extract basic page parameters
    const title = $('title').text().trim() || '';
    const description = $('meta[name="description"]').attr('content')?.trim() || 
                        $('meta[property="og:description"]').attr('content')?.trim() || '';

    // Extract headings for structure
    const headings = [];
    $('h1, h2, h3').slice(0, 8).each((i, el) => {
      const text = $(el).text().trim();
      if (text) headings.push(text);
    });

    // Extract body text, normalize whitespaces
    const rawBodyText = $('body').text();
    const cleanBodyText = rawBodyText
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000); // Grab the first 3000 characters to prevent prompt overflow

    const combinedContext = [
      title ? `Title: ${title}` : '',
      description ? `Meta Description: ${description}` : '',
      headings.length > 0 ? `Key Headlines: ${headings.join(' | ')}` : '',
      cleanBodyText ? `Homepage Snippet: ${cleanBodyText}` : ''
    ].filter(Boolean).join('\n\n');

    logger.info(`Successfully scraped ${formattedUrl} (${combinedContext.length} chars of context extracted)`);
    return {
      title,
      description,
      bodyText: combinedContext,
      success: true
    };
  } catch (error) {
    logger.warn(`Failed to scrape website ${formattedUrl}: ${error.message} - falling back to industry info`);
    return {
      title: '',
      description: '',
      bodyText: '',
      success: false
    };
  }
}
