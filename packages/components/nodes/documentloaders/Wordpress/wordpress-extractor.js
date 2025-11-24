const axios = require('axios');
const { NodeHtmlMarkdown } = require('node-html-markdown');

// Environment variables (provided by environment)
const siteID = typeof $siteID !== 'undefined' ? $siteID : null;
const siteDomain = typeof $siteDomain !== 'undefined' ? $siteDomain : '';
const token = typeof $token !== 'undefined' ? $token : '';
const includePosts = typeof $includePosts !== 'undefined' ? $includePosts : false;
const includePages = typeof $includePages !== 'undefined' ? $includePages : false;
const modifiedAfterDays = typeof $modifiedAfterDays !== 'undefined' ? $modifiedAfterDays : '';
const number = typeof $number !== 'undefined' ? $number : 20;
const filterPath = typeof $filterPath !== 'undefined' ? $filterPath : '';
const getProtected = typeof $getProtected !== 'undefined' ? $getProtected : false;
const includeTribeEvents = typeof $includeTribeEvents !== 'undefined' ? $includeTribeEvents : true;

const USER_CONFIG = {
  siteID: siteID,
  siteDomain: siteDomain,
  token: token,
  includePosts: includePosts,
  includePages: includePages,
  modifiedAfterDays: modifiedAfterDays,
  number: number,
  filterPath: filterPath,
  getProtected: getProtected,
  includeTribeEvents: includeTribeEvents,
  
  // Content configuration
  charsPerToken: 4,           // Approximate characters per token for estimation
};

// System configuration (typically not changed by users)
const SYSTEM_CONFIG = {
  // API configuration
  api: {
    protocol: 'https://public-api.wordpress.com',
    basePath: '/rest/v1.1/sites/',
  },
  
  // Content configuration
  defaultTitle: 'Untitled',
  
  // Chunking configuration
  chunking: {
    maxTokens: 1000,        // Posts larger than this will be chunked
    chunkSize: 1000,        // Maximum tokens per chunk
    overlap: 200,           // Token overlap between chunks
  },
};

// Combined configuration
const CONFIG = { ...USER_CONFIG, ...SYSTEM_CONFIG };

/**
 * Validate configuration
 */
function validateConfig(config) {
  const errors = [];

  // Either siteID or siteDomain must be provided
  if (!config.siteID && !config.siteDomain) {
    errors.push('Either WordPress SiteID or SiteDomain is required');
  }

  // At least one content type must be enabled
  if (!config.includePosts && !config.includePages && !config.includeTribeEvents) {
    errors.push('At least one content type must be enabled (includePosts, includePages, or includeTribeEvents)');
  }

  // Token is only required if fetching posts or pages (tribe events don't need auth)
  if (!config.token && (config.includePosts || config.includePages)) {
    errors.push('Wordpress auth token is required when fetching posts or pages');
  }

  if (errors.length > 0) {
    const errorMessage = 'Configuration validation failed:\n  • ' + errors.join('\n  • ');
    throw new Error(errorMessage);
  }
}

/**
 * Main execution function
 */
async function main() {
  try {
    const config = CONFIG;

    const extractionTypes = [];
    if (config.includePosts) extractionTypes.push('posts');
    if (config.includePages) extractionTypes.push('pages');
    if (config.includeTribeEvents) extractionTypes.push('tribe events');
    const extractionTypeStr = extractionTypes.join(', ') || 'content';
    
    console.error(`Starting WordPress ${extractionTypeStr} extraction...`);
    console.error('Validating configuration...');
    validateConfig(config);

    const startTime = Date.now();
    const posts = await extractAllPosts(config);
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    // Log summary
    console.error(`\nCompleted processing in ${duration}s`);

    // Return the array directly
    return posts;
  } catch (error) {
    console.error('');
    console.error('Error:', error.message);
    console.error('');
    console.error('Troubleshooting tips:');
    console.error('   - Verify your WordPress SiteID or SiteDomain is correct');
    console.error('   - Check that your auth token is valid and has proper permissions');
    console.error('   - Ensure the site is accessible');
    console.error('');
    throw error;
  }
}

/**
 * Convert days to ISO 8601 datetime string
 */
function daysToISO8601(days) {
  if (!days || days === '') {
    return null;
  }
  const numDays = parseInt(days, 10);
  if (isNaN(numDays)) {
    return null;
  }
  const date = new Date();
  date.setDate(date.getDate() - numDays);
  return date.toISOString();
}

/**
 * Helper to fetch a single post by ID
 */
async function fetchPostById(postId, config, axiosHeaders) {
  const params = ['fields=ID,title,URL,modified,date,content'];
  
  // Add context=edit parameter if getProtected is true
  if (config.getProtected) {
    params.unshift('context=edit');
  }
  
  // Use siteID if provided, otherwise use siteDomain
  const siteIdentifier = config.siteID || config.siteDomain;
  const postUri = `${config.api.protocol}${config.api.basePath}${siteIdentifier}/posts/${postId}?${params.join('&')}`;
    
  try {
    const resp = await axios.get(postUri, { headers: axiosHeaders });
    const data = resp.data;

    if (data && data.content) {
      return data;
    } else {
      console.error('Unexpected response format for post:', JSON.stringify(data, null, 2));
      return null;
    }
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const statusText = error.response.statusText;

      if (status === 401) {
        throw new Error(
          `Authentication failed (${status}): Please check your WordPress credentials`
        );
      } else if (status === 403) {
        throw new Error(
          `Access forbidden (${status}): You don't have permission to access this WordPress site`
        );
      } else if (status === 404) {
        console.error(`Post ${postId} not found (404), skipping block reference`);
        return null;
      } else if (status >= 500) {
        throw new Error(
          `WordPress server error (${status}): ${statusText}. Please try again later`
        );
      } else {
        // Log more details for debugging
        const errorDetails = error.response?.data ? JSON.stringify(error.response.data, null, 2) : 'No error details';
        console.error(`Request URL: ${postUri}`);
        console.error(`Error response: ${errorDetails}`);
        throw new Error(`HTTP error (${status}): ${statusText}`);
      }
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new Error(
        `Network error: Cannot connect to WordPress API. Please check your connection`
      );
    } else {
      throw new Error(`Request failed: ${error.message}`);
    }
  }
}

/**
 * Extract wp:block references from content
 * Pattern: <!-- wp:block {"ref":71} /-->
 */
function extractBlockReferences(content) {
  // Match: <!-- wp:block {"ref":71} /-->
  // Handles variations in whitespace
  const blockPattern = /<!--\s*wp:block\s+(\{[^}]*"ref"\s*:\s*(\d+)[^}]*\})\s*\/-->/g;
  const references = [];
  let match;
  
  while ((match = blockPattern.exec(content)) !== null) {
    try {
      const jsonStr = match[1];
      const parsed = JSON.parse(jsonStr);
      if (parsed.ref && typeof parsed.ref === 'number') {
        references.push({
          fullMatch: match[0],
          ref: parsed.ref,
          startIndex: match.index,
          endIndex: match.index + match[0].length
        });
      }
    } catch (e) {
      console.error(`Failed to parse block reference: ${match[0]}`, e.message);
    }
  }
  
  return references;
}

/**
 * Recursively resolve wp:block references in content
 */
async function resolveBlockReferences(content, config, axiosHeaders, visitedRefs = new Set(), depth = 0) {
  // Prevent infinite recursion
  if (depth > 10) {
    console.error('Maximum recursion depth reached for block references');
    return content;
  }
  
  let references = extractBlockReferences(content);
  
  if (references.length === 0) {
    return content;
  }
  
  // Build result by processing references in order
  let result = '';
  let lastIndex = 0;
  
  for (const ref of references) {
    // Add content before this reference
    result += content.substring(lastIndex, ref.startIndex);
    
    // Skip if we've already visited this ref to prevent circular references
    if (visitedRefs.has(ref.ref)) {
      console.error(`Circular reference detected for ref ${ref.ref}, skipping`);
      // Skip the reference (don't add it to result)
      lastIndex = ref.endIndex;
      continue;
    }
    
    // Mark this ref as visited
    visitedRefs.add(ref.ref);
    
    // Fetch the referenced post
    const blockPost = await fetchPostById(ref.ref, config, axiosHeaders);
    
    if (blockPost && blockPost.content) {
      // Recursively resolve any nested block references
      const resolvedBlockContent = await resolveBlockReferences(
        blockPost.content, 
        config, 
        axiosHeaders, 
        new Set(visitedRefs), 
        depth + 1
      );
      
      // Add the resolved content
      result += resolvedBlockContent;
    }
    // If block not found, we just skip it (don't add anything)
    
    // Remove from visited set after processing
    visitedRefs.delete(ref.ref);
    
    lastIndex = ref.endIndex;
  }
  
  // Add remaining content after last reference
  result += content.substring(lastIndex);
  
  // Check if there are any remaining references after replacement
  const remainingRefs = extractBlockReferences(result);
  if (remainingRefs.length > 0) {
    // Recursively resolve any new references that may have been introduced
    return await resolveBlockReferences(result, config, axiosHeaders, visitedRefs, depth + 1);
  }
  
  return result;
}

/**
 * Helper to fetch a single page of tribe events
 */
async function fetchTribeEventsPage(config, page = 1) {
  // Use siteDomain for tribe events endpoint
  const siteDomain = config.siteDomain;
  if (!siteDomain) {
    console.error('SiteDomain is required for fetching tribe events');
    return { events: [], hasMore: false, total: 0 };
  }

  // Build the tribe events endpoint URL
  // Remove protocol if present, then add https://
  let domain = siteDomain;
  if (domain.startsWith('http://') || domain.startsWith('https://')) {
    domain = domain.replace(/^https?:\/\//, '');
  }
  
  let eventsUri = `https://${domain}/wp-json/tribe/events/v1/events`;
  
  // Build query parameters
  const params = [];
  
  // Always include per_page parameter
  const perPage = config.number || 100;
  params.push(`per_page=${perPage}`);
  
  // Include page parameter for pagination
  params.push(`page=${page}`);
  
  // Include _tribe_event_fields=all to get all event fields
  params.push(`_tribe_event_fields=all`);
  
  // Tribe Events API automatically filters by date range (default is ~2 years)
  // To get all events, we need to set a wide date range
  // If modifiedAfterDays is provided, use it as the start date
  // Otherwise, set start_date to a date far in the past to get all events
  if (config.modifiedAfterDays && config.modifiedAfterDays !== '') {
    const modifiedAfter = daysToISO8601(config.modifiedAfterDays);
    if (modifiedAfter) {
      // Use starts_after to filter events that start after the specified date
      params.push(`starts_after=${encodeURIComponent(modifiedAfter)}`);
    }
  } else {
    // Set a very wide date range to get all events (past and future)
    // Start from 10 years ago to 10 years in the future
    const now = new Date();
    const pastDate = new Date(now);
    pastDate.setFullYear(pastDate.getFullYear() - 10);
    const futureDate = new Date(now);
    futureDate.setFullYear(futureDate.getFullYear() + 10);
    
    // Format as YYYY-MM-DD HH:MM:SS (Tribe Events API format)
    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day} 00:00:00`;
    };
    
    params.push(`start_date=${encodeURIComponent(formatDate(pastDate))}`);
    params.push(`end_date=${encodeURIComponent(formatDate(futureDate))}`);
  }
  
  // Always append query string (per_page is always included)
  eventsUri += `?${params.join('&')}`;
  
  console.error(`Fetching tribe events page ${page}: ${eventsUri}`);
  
  try {
    // No authentication headers needed
    const resp = await axios.get(eventsUri);
    const data = resp.data;

    let events = [];
    let hasMore = false;
    let total = 0;

    // The Tribe Events API v1 returns an object with an 'events' array
    if (data && data.events && Array.isArray(data.events)) {
      events = data.events;
      
      // Debug: Log response structure on first page to understand pagination
      if (page === 1) {
        console.error(`Tribe Events API response structure (page 1):`, JSON.stringify({
          hasEvents: !!data.events,
          eventsCount: data.events?.length,
          dataKeys: Object.keys(data || {}),
          total: data.total,
          total_pages: data.total_pages,
          pages: data.pages,
          per_page: data.per_page
        }, null, 2));
      }
      
      // Check for pagination metadata in the response
      // Some APIs include total, total_pages, or similar fields
      if (data.total !== undefined) {
        total = data.total;
      }
      if (data.total_pages !== undefined) {
        hasMore = page < data.total_pages;
        console.error(`Pagination: page ${page} of ${data.total_pages} (total: ${data.total} events)`);
      } else if (data.pages !== undefined) {
        hasMore = page < data.pages;
        console.error(`Pagination: page ${page} of ${data.pages}`);
      } else {
        // If no pagination metadata, we need to be smarter about detecting more pages
        // The API might have a default page size limit (e.g., 10) that's smaller than perPage
        // So we can't just check if events.length < perPage
        // Instead: if we got events, assume there might be more (we'll stop when we get 0)
        // This is safer - we'll make one extra API call but ensure we get everything
        hasMore = events.length > 0;
        console.error(`Pagination: no metadata found, got ${events.length} events, will try next page if > 0`);
      }
    } else if (Array.isArray(data)) {
      // Fallback: if it's a direct array, return it
      events = data;
      // If we got events, assume there might be more
      hasMore = events.length > 0;
    } else {
      console.error('Unexpected response format for tribe events:', JSON.stringify(data, null, 2));
      return { events: [], hasMore: false, total: 0 };
    }

    return { events, hasMore, total };
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const statusText = error.response.statusText;

      if (status === 404) {
        console.error(`Tribe events endpoint not found (404), skipping`);
        return { events: [], hasMore: false, total: 0 };
      } else if (status >= 500) {
        console.error(`WordPress server error (${status}): ${statusText} when fetching tribe events`);
        return { events: [], hasMore: false, total: 0 };
      } else {
        console.error(`Error fetching tribe events (${status}): ${statusText}`);
        return { events: [], hasMore: false, total: 0 };
      }
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      console.error(`Network error: Cannot connect to WordPress site for tribe events`);
      return { events: [], hasMore: false, total: 0 };
    } else {
      console.error(`Request failed for tribe events: ${error.message}`);
      return { events: [], hasMore: false, total: 0 };
    }
  }
}

/**
 * Helper to fetch all tribe events with pagination support
 */
async function fetchTribeEvents(config) {
  const allEvents = [];
  let currentPage = 1;
  let hasMore = true;
  const perPage = config.number || 100;

  console.error('Starting tribe events fetch with pagination...');

  while (hasMore) {
    const result = await fetchTribeEventsPage(config, currentPage);
    
    if (result.events && result.events.length > 0) {
      allEvents.push(...result.events);
      console.error(`Fetched ${result.events.length} events from page ${currentPage} (total so far: ${allEvents.length})`);
      // Continue to next page if we got events (unless pagination metadata says we're done)
      hasMore = result.hasMore;
    } else {
      // Got 0 events, we're done
      hasMore = false;
    }

    currentPage++;

    // Safety limit to prevent infinite loops
    if (currentPage > 1000) {
      console.error('Pagination safety limit reached (1000 pages), stopping');
      break;
    }
  }

  console.error(`Finished fetching tribe events: ${allEvents.length} total events from ${currentPage - 1} page(s)`);
  return allEvents;
}

/**
 * Transform tribe event to required format with chunking support
 * Maps to same structure as posts/pages for consistency
 */
async function transformTribeEvent(event, config) {
  // Map fields to match posts/pages structure
  const eventUrl = event.url || event.link || '';
  const title = event.title || config.defaultTitle;
  const eventId = String(event.id || '');
  
  // Use description as content (full description, not stripped)
  let rawContent = event.description || '';
  
  // Convert HTML to Markdown
  rawContent = htmlToMarkdown(rawContent);
  
  // Prepend title to content (consistent with posts/pages)
  const content = `${title}\n\n${rawContent}`;
  const tokenSize = Math.ceil(content.length / config.charsPerToken);

  // Extract dates (matching posts/pages structure)
  const createdDate = event.date || null;
  const modifiedDate = event.modified || null;

  // Extract venue information
  const venueId = event.venue?.id || null;

  // Extract organizer information (organizer is an array)
  const organizerId = event.organizer && Array.isArray(event.organizer) && event.organizer.length > 0 
    ? event.organizer[0].id || null 
    : null;

  // Extract event-specific dates
  const startDate = event.start_date || null;
  const endDate = event.end_date || null;

  // Extract cost
  const cost = event.cost || null;

  // Extract category names (categories is an array with name field)
  const categoryNames = event.categories && Array.isArray(event.categories)
    ? event.categories.map(cat => cat.name).filter(name => name)
    : [];

  // Extract category IDs (categories is an array with id field)
  const categoryIDs = event.categories && Array.isArray(event.categories)
    ? event.categories.map(cat => cat.id).filter(id => id !== undefined && id !== null)
    : [];

  // Base metadata - matching posts/pages structure with additional event fields
  const baseMetadata = {
    id: eventId,
    url: eventUrl,
    title: title,
    type: 'event',
    createdDate: createdDate,
    modifiedDate: modifiedDate,
    // Event-specific fields
    venueId: venueId,
    organizerId: organizerId,
    startDate: startDate,
    endDate: endDate,
    cost: cost,
    categories: categoryNames,
    categoryIDs: categoryIDs,
  };

  // If event is small enough, return as single document
  if (tokenSize <= config.chunking.maxTokens) {
    return [{
      pageContent: content,
      metadata: baseMetadata,
      tokenSize: tokenSize,
      isChunked: false
    }];
  }

  // Event needs chunking
  const chunks = chunkContent(content, config.chunking.chunkSize, config.chunking.overlap, config.charsPerToken);
  
  return chunks.map(chunk => ({
    pageContent: chunk.content,
    metadata: {
      ...baseMetadata,
      // Keep id as the original document ID for consistent document management
      id: eventId,
      // Add chunkedId for chunk-specific identification
      chunkedId: `${eventId}-${chunk.index + 1}`,
    },
    tokenSize: chunk.tokenSize,
    isChunked: true,
    originalId: eventId,
    chunkIndex: chunk.index + 1,
    totalChunks: chunks.length
  }));
}

/**
 * Helper to fetch a single page of posts or pages
 * @param {string} contentType - 'post' or 'page'
 * @param {number} page - Page number (1-based)
 */
async function fetchPostsPage(config, axiosHeaders, contentType, page = 1) {
  // Use siteID if provided, otherwise use siteDomain
  const siteIdentifier = config.siteID || config.siteDomain;
  // Path always uses /posts endpoint
  let postsUri = `${config.api.protocol}${config.api.basePath}${siteIdentifier}/posts`;
  
  // Build query parameters
  const params = [];
  const perPage = config.number || 100;
  params.push(`number=${perPage}`);
  
  // WordPress.com API v1.1 uses offset for pagination
  // Page 1 = offset 0, Page 2 = offset perPage, etc.
  const offset = (page - 1) * perPage;
  params.push(`offset=${offset}`);
  
  // Add context=edit parameter if getProtected is true
  if (config.getProtected) {
    params.push('context=edit');
  }
  
  params.push('fields=ID,title,URL,modified,date,content');
  
  // Add type parameter (post or page)
  params.push(`type=${contentType}`);
  
  // Add modified_after if provided
  const modifiedAfter = daysToISO8601(config.modifiedAfterDays);
  if (modifiedAfter) {
    params.push(`modified_after=${encodeURIComponent(modifiedAfter)}`);
  }
  
  // Append query string if we have parameters
  if (params.length > 0) {
    postsUri += `?${params.join('&')}`;
  }
  
  console.error(`Fetching ${contentType}s page ${page} (offset ${offset}): ${postsUri}`);
  
  try {
    const resp = await axios.get(postsUri, { headers: axiosHeaders });
    const data = resp.data;

    let posts = [];
    let hasMore = false;
    let found = 0;

    if (data.posts && Array.isArray(data.posts)) {
      posts = data.posts;
      // Check for pagination metadata in the response
      // WordPress.com API v1.1 typically includes 'found' (total count)
      if (data.found !== undefined) {
        found = data.found;
        // Calculate if there are more pages
        hasMore = offset + posts.length < found;
      } else {
        // If no metadata, check if we got a full page
        hasMore = posts.length >= perPage;
      }
    } else {
      console.error('Unexpected response format:', JSON.stringify(data, null, 2));
      return { posts: [], hasMore: false, found: 0 };
    }

    return { posts, hasMore, found };
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const statusText = error.response.statusText;

      if (status === 401) {
        throw new Error(
          `Authentication failed (${status}): Please check your WordPress credentials`
        );
      } else if (status === 403) {
        throw new Error(
          `Access forbidden (${status}): You don't have permission to access this WordPress site`
        );
      } else if (status === 404) {
        throw new Error(`Not found (${status}): The WordPress SiteID may be incorrect`);
      } else if (status >= 500) {
        throw new Error(
          `WordPress server error (${status}): ${statusText}. Please try again later`
        );
      } else {
        // Log more details for debugging
        const errorDetails = error.response?.data ? JSON.stringify(error.response.data, null, 2) : 'No error details';
        console.error(`Request URL: ${postsUri}`);
        console.error(`Error response: ${errorDetails}`);
        throw new Error(`HTTP error (${status}): ${statusText}`);
      }
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new Error(
        `Network error: Cannot connect to WordPress API. Please check your connection`
      );
    } else {
      throw new Error(`Request failed: ${error.message}`);
    }
  }
}

/**
 * Helper to fetch all posts or pages with pagination support
 * @param {string} contentType - 'post' or 'page'
 */
async function fetchAllPosts(config, axiosHeaders, contentType) {
  const allPosts = [];
  let currentPage = 1;
  let hasMore = true;
  const perPage = config.number || 100;

  console.error(`Starting ${contentType}s fetch with pagination...`);

  while (hasMore) {
    const result = await fetchPostsPage(config, axiosHeaders, contentType, currentPage);
    
    if (result.posts && result.posts.length > 0) {
      allPosts.push(...result.posts);
      console.error(`Fetched ${result.posts.length} ${contentType}s from page ${currentPage} (total so far: ${allPosts.length}${result.found > 0 ? ` of ${result.found}` : ''})`);
    }

    hasMore = result.hasMore;
    currentPage++;

    // Safety limit to prevent infinite loops
    if (currentPage > 1000) {
      console.error(`Pagination safety limit reached (1000 pages) for ${contentType}s, stopping`);
      break;
    }
  }

  console.error(`Finished fetching ${contentType}s: ${allPosts.length} total ${contentType}s from ${currentPage - 1} page(s)`);
  return allPosts;
}


/**
 * Convert HTML content to Markdown format
 * Strips all HTML tags and converts them to clean markdown
 * @param {string} content - HTML content to convert
 * @returns {string} - Markdown content
 */
function htmlToMarkdown(content) {
  if (!content || typeof content !== 'string') {
    return content;
  }

  // Initialize the HTML to Markdown converter
  const nhm = new NodeHtmlMarkdown({
    // Configure options for cleaner output
    maxConsecutiveNewlines: 2,
    useInlineLinks: true,
    codeFence: '```',
    bulletMarker: '-',
    ignore: ['script', 'style', 'meta', 'link', 'head', 'title', 'html', 'body'],
  });

  try {
    // Convert HTML to Markdown
    let markdown = nhm.translate(content);
    
    // Clean up extra whitespace
    // Replace multiple spaces with single space, but preserve line breaks
    markdown = markdown.replace(/[ \t]+/g, ' ');
    // Remove excessive newlines (3+ newlines become 2)
    markdown = markdown.replace(/\n{3,}/g, '\n\n');
    markdown = markdown.trim();
    
    return markdown;
  } catch (error) {
    console.error('Error converting HTML to Markdown:', error.message);
    // Fallback: return content as-is if conversion fails
    return content;
  }
}

/**
 * Chunk text content based on token limits
 */
function chunkContent(content, chunkSize, overlap, charsPerToken) {
  const chunks = [];
  const contentLength = content.length;
  const chunkCharSize = chunkSize * charsPerToken;
  const overlapCharSize = overlap * charsPerToken;
  
  let start = 0;
  let chunkIndex = 0;
  
  while (start < contentLength) {
    const end = Math.min(start + chunkCharSize, contentLength);
    const chunk = content.substring(start, end);
    
    chunks.push({
      content: chunk,
      index: chunkIndex,
      tokenSize: Math.ceil(chunk.length / charsPerToken)
    });
    
    chunkIndex++;
    
    // Move start position, accounting for overlap
    if (end >= contentLength) break;
    start = end - overlapCharSize;
  }
  
  return chunks;
}

/**
 * Transform post to required format with chunking support
 * @param {string} contentType - 'post' or 'page' (optional, defaults to 'post')
 */
async function transformPost(post, config, axiosHeaders, contentType = 'post') {
  const postUrl = post.URL || '';
  const title = post.title || config.defaultTitle;
  let rawContent = post.content || '';
  
  // Resolve wp:block references recursively
  rawContent = await resolveBlockReferences(rawContent, config, axiosHeaders);
  
  // Convert HTML to Markdown
  rawContent = htmlToMarkdown(rawContent);
  
  // Prepend title to content
  const content = `${title}\n\n${rawContent}`;
  const tokenSize = Math.ceil(content.length / config.charsPerToken);
  // ID is site_ID + ID
  const postId = `${post.site_ID || ''}${post.ID || ''}`;
  
  // Extract dates
  const createdDate = post.date || null;
  const modifiedDate = post.modified || null;

  // Base metadata
  const baseMetadata = {
    id: postId,
    url: postUrl,
    title: title,
    type: contentType,
    createdDate: createdDate,
    modifiedDate: modifiedDate,
  };

  // If post is small enough, return as single document
  if (tokenSize <= config.chunking.maxTokens) {
    return [{
      pageContent: content,
      metadata: baseMetadata,
      tokenSize: tokenSize,
      isChunked: false
    }];
  }

  // Post needs chunking
  const chunks = chunkContent(content, config.chunking.chunkSize, config.chunking.overlap, config.charsPerToken);
  
  return chunks.map(chunk => ({
    pageContent: chunk.content,
    metadata: {
      ...baseMetadata,
      // Keep id as the original document ID for consistent document management
      id: postId,
      // Add chunkedId for chunk-specific identification
      chunkedId: `${postId}-${chunk.index + 1}`,
    },
    tokenSize: chunk.tokenSize,
    isChunked: true,
    originalId: postId,
    chunkIndex: chunk.index + 1,
    totalChunks: chunks.length
  }));
}

/**
 * Extract all posts from WordPress
 */
async function extractAllPosts(config) {
  const allTransformedPosts = [];
  const tokenSizes = [];
  const chunkedPosts = [];

  // Setup authentication headers - Bearer token (only if token is provided)
  let axiosHeaders = {};
  if (config.token) {
    console.error('Setting up authentication...');
    axiosHeaders = {
      Authorization: `Bearer ${config.token}`,
    };
  }

  // Helper function to process posts/pages
  async function processContentItems(items, contentType) {
    console.error(`Processing ${items.length} ${contentType}s...`);
    
    // Print items with content truncated to 100 characters
    console.error(`\n${contentType.charAt(0).toUpperCase() + contentType.slice(1)}s:`);
    items.forEach((item, index) => {
      const content = item.content || '';
      const truncatedContent = content.length > 100 ? content.substring(0, 100) + '...' : content;
      console.error(`${index + 1}. Title: "${item.title || 'Untitled'}"`);
      console.error(`   URL: ${item.URL || 'N/A'}`);
      console.error(`   Content: ${truncatedContent}`);
      console.error('');
    });

    // Transform each item to the required format
    for (const item of items) {
      const transformedChunks = await transformPost(item, config, axiosHeaders, contentType);
      const originalContent = `${item.title || ''}\n\n${item.content || ''}`;
      const originalTokenSize = Math.ceil(originalContent.length / config.charsPerToken);
      
      // Process each chunk (will be 1 chunk for small items)
      for (const chunk of transformedChunks) {
        // Track token sizes for summary (only original items, not individual chunks)
        if (!chunk.isChunked) {
          tokenSizes.push({
            title: item.title || 'Untitled',
            tokenSize: chunk.tokenSize,
            id: chunk.metadata.id
          });
        }
        
        // Track chunked items for summary
        if (chunk.isChunked && chunk.chunkIndex === 1) {
          // Only track once per original item
          chunkedPosts.push({
            title: item.title || 'Untitled',
            originalId: chunk.originalId,
            originalTokenSize: originalTokenSize,
            totalChunks: chunk.totalChunks,
            chunkSizes: transformedChunks.map(c => c.tokenSize)
          });
          
          // Add to token sizes summary with original size
          tokenSizes.push({
            title: item.title || 'Untitled',
            tokenSize: originalTokenSize,
            id: chunk.originalId
          });
        }
        
        // Remove chunking metadata from final output
        const finalChunk = {
          pageContent: chunk.pageContent,
          metadata: chunk.metadata
        };
        
        allTransformedPosts.push(finalChunk);
      }
    }
  }

  // Fetch posts if enabled
  if (config.includePosts) {
    console.error('Accessing WordPress posts...');

    try {
      let posts = await fetchAllPosts(config, axiosHeaders, 'post');
      console.error(`Fetched ${posts.length} posts...`);
      
      // Filter posts by filterPath if configured
      if (config.filterPath && config.filterPath !== '') {
        const beforeFilterCount = posts.length;
        posts = posts.filter(post => {
          const postUrl = post.URL || '';
          return postUrl.includes(config.filterPath);
        });
        console.error(`Filtered to ${posts.length} posts matching filterPath: "${config.filterPath}" (removed ${beforeFilterCount - posts.length})`);
      }
      
      await processContentItems(posts, 'post');
    } catch (error) {
      console.error(`Error processing posts:`, error.message);
      throw error;
    }
  }

  // Fetch pages if enabled
  if (config.includePages) {
    console.error('Accessing WordPress pages...');

    try {
      let pages = await fetchAllPosts(config, axiosHeaders, 'page');
      console.error(`Fetched ${pages.length} pages...`);
      
      // Filter pages by filterPath if configured
      if (config.filterPath && config.filterPath !== '') {
        const beforeFilterCount = pages.length;
        pages = pages.filter(page => {
          const pageUrl = page.URL || '';
          return pageUrl.includes(config.filterPath);
        });
        console.error(`Filtered to ${pages.length} pages matching filterPath: "${config.filterPath}" (removed ${beforeFilterCount - pages.length})`);
      }
      
      await processContentItems(pages, 'page');
    } catch (error) {
      console.error(`Error processing pages:`, error.message);
      throw error;
    }
  }

  // Fetch tribe events if enabled
  if (config.includeTribeEvents) {
    console.error('Accessing WordPress tribe events...');

    try {
      let events = await fetchTribeEvents(config);
      console.error(`Fetched ${events.length} tribe events...`);
      
      console.error(`Processing ${events.length} tribe events...`);
      
      // Print tribe events with key fields (description truncated to 100 chars for display)
      console.error('\nTribe Events:');
      events.forEach((event, index) => {
        const title = event.title || 'Untitled';
        const description = event.description || '';
        const truncatedDescription = description.length > 100 ? description.substring(0, 100) + '...' : description;
        
        // Extract key fields for display
        const venueId = event.venue?.id || 'N/A';
        const venueName = event.venue?.venue || 'N/A';
        const organizerId = event.organizer && Array.isArray(event.organizer) && event.organizer.length > 0 
          ? event.organizer[0].id || 'N/A' 
          : 'N/A';
        const organizerName = event.organizer && Array.isArray(event.organizer) && event.organizer.length > 0 
          ? event.organizer[0].organizer || 'N/A' 
          : 'N/A';
        const categoryNames = event.categories && Array.isArray(event.categories)
          ? event.categories.map(cat => cat.name).filter(name => name).join(', ') || 'N/A'
          : 'N/A';
        
        console.error(`${index + 1}. Title: "${title}"`);
        console.error(`   ID: ${event.id || 'N/A'}`);
        console.error(`   URL: ${event.url || event.link || 'N/A'}`);
        console.error(`   Description (first 100 chars): ${truncatedDescription}`);
        console.error(`   Venue ID: ${venueId}, Venue: ${venueName}`);
        console.error(`   Organizer ID: ${organizerId}, Organizer: ${organizerName}`);
        console.error(`   Start Date: ${event.start_date || 'N/A'}`);
        console.error(`   End Date: ${event.end_date || 'N/A'}`);
        console.error(`   Cost: ${event.cost || 'N/A'}`);
        console.error(`   Categories: ${categoryNames}`);
        console.error('');
      });

      // Transform each event to the required format
      for (const event of events) {
        const transformedChunks = await transformTribeEvent(event, config);
        const title = event.title || '';
        const description = event.description || '';
        const originalContent = `${title}\n\n${description}`;
        const originalTokenSize = Math.ceil(originalContent.length / config.charsPerToken);
        
        // Process each chunk (will be 1 chunk for small events)
        for (const chunk of transformedChunks) {
          // Track token sizes for summary (only original events, not individual chunks)
          if (!chunk.isChunked) {
            tokenSizes.push({
              title: title || 'Untitled',
              tokenSize: chunk.tokenSize,
              id: chunk.metadata.id
            });
          }
          
          // Track chunked events for summary
          if (chunk.isChunked && chunk.chunkIndex === 1) {
            // Only track once per original event
            chunkedPosts.push({
              title: title || 'Untitled',
              originalId: chunk.originalId,
              originalTokenSize: originalTokenSize,
              totalChunks: chunk.totalChunks,
              chunkSizes: transformedChunks.map(c => c.tokenSize)
            });
            
            // Add to token sizes summary with original size
            tokenSizes.push({
              title: title || 'Untitled',
              tokenSize: originalTokenSize,
              id: chunk.originalId
            });
          }
          
          // Remove chunking metadata from final output
          const finalChunk = {
            pageContent: chunk.pageContent,
            metadata: chunk.metadata
          };
          
          allTransformedPosts.push(finalChunk);
        }
      }
    } catch (error) {
      console.error(`Error processing tribe events:`, error.message);
      // Don't throw - just log the error and continue
    }
  }

  // Show largest 5 token sizes
  const largest5 = tokenSizes
    .sort((a, b) => b.tokenSize - a.tokenSize)
    .slice(0, 5);
  
  console.error('\nLargest 5 posts by token size:');
  largest5.forEach((item, index) => {
    console.error(`${index + 1}. "${item.title}" - ${item.tokenSize} tokens (ID: ${item.id})`);
  });

  // Log final stats
  console.error(`\nFinal Summary:`);
  console.error(`Original posts: ${tokenSizes.length}`);
  console.error(`Total documents created: ${allTransformedPosts.length}`);
  if (chunkedPosts.length > 0) {
    console.error(`Posts that were chunked: ${chunkedPosts.length}`);
  }
  return allTransformedPosts;
}

// Run the script
return main().catch(error => {
  console.error('Script failed:', error.message);
  throw error;
});
