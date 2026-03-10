const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const APP_PASSWORD = String(process.env.APP_PASSWORD || "").trim();
const ASSEMBLYAI_API_KEY = String(process.env.ASSEMBLYAI_API_KEY || "").trim();
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(DATA_DIR, "history.json");
const SESSION_COOKIE = "podcast_reader_session";
const activeSessions = new Set();

const AUDIO_FILE_PATTERN = /\.(mp3|m4a|mp4|wav|aac|ogg)(\?|$)/i;
const APPLE_PODCAST_HOST_PATTERN = /(^|\.)podcasts\.apple\.com$/i;
const MEDIA_PATTERNS = [
  /property=["']og:audio["'][^>]*content=["']([^"']+)["']/i,
  /name=["']twitter:player:stream["'][^>]*content=["']([^"']+)["']/i,
  /<audio[^>]*src=["']([^"']+)["']/i,
  /<source[^>]*src=["']([^"']+)["']/i,
  /enclosure[^>]*url=["']([^"']+)["']/i,
  /"audio"\s*:\s*"([^"]+)"/i,
  /"contentUrl"\s*:\s*"([^"]+)"/i
];

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function sendFile(res, filePath, headers = {}) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(filePath);
    const type = ext === ".css"
      ? "text/css; charset=utf-8"
      : ext === ".js"
        ? "application/javascript; charset=utf-8"
        : "text/html; charset=utf-8";

    res.writeHead(200, { "Content-Type": type, ...headers });
    res.end(content);
  });
}

function sendHead(res, statusCode, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end();
}

async function ensureHistoryStore() {
  await fs.promises.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  try {
    await fs.promises.access(HISTORY_FILE);
  } catch {
    await fs.promises.writeFile(HISTORY_FILE, "[]\n", "utf8");
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return raw.split(";").reduce((cookies, item) => {
    const [key, ...rest] = item.trim().split("=");
    if (!key) {
      return cookies;
    }
    cookies[key] = decodeURIComponent(rest.join("=") || "");
    return cookies;
  }, {});
}

function createSessionToken() {
  return crypto.randomBytes(24).toString("hex");
}

function buildSessionCookie(token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400${secure}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

function isAuthenticated(req) {
  if (!APP_PASSWORD) {
    return true;
  }
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  return Boolean(token && activeSessions.has(token));
}

function requireAuth(req, res) {
  if (isAuthenticated(req)) {
    return true;
  }
  sendJson(res, 401, { error: "Unauthorized" });
  return false;
}

async function readHistory() {
  await ensureHistoryStore();
  const raw = await fs.promises.readFile(HISTORY_FILE, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function writeHistory(entries) {
  await ensureHistoryStore();
  await fs.promises.writeFile(HISTORY_FILE, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

function buildHistoryEntry(result) {
  return {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    input_url: result.input_url,
    resolved_audio_url: result.resolved_audio_url,
    resolved_episode_link: result.resolved_episode_link,
    resolved_rss_feed_url: result.resolved_rss_feed_url,
    resolved_from: result.resolved_from,
    interest_goal: result.interest_goal,
    transcript_id: result.transcript_id,
    speech_model_used: result.speech_model_used,
    audio_minutes: result.audio_minutes,
    estimated_value_score: result.estimated_value_score,
    recommendation: result.recommendation,
    assemblyai_summary: result.assemblyai_summary,
    key_highlights: result.key_highlights,
    chapters: result.chapters,
    transcript: result.transcript
  };
}

async function saveHistoryEntry(result) {
  const history = await readHistory();
  history.unshift(buildHistoryEntry(result));
  await writeHistory(history.slice(0, 100));
}

async function deleteHistoryEntry(entryId) {
  const history = await readHistory();
  const nextHistory = history.filter((entry) => entry.id !== entryId);
  const deleted = nextHistory.length !== history.length;
  if (deleted) {
    await writeHistory(nextHistory);
  }
  return deleted;
}

async function clearHistory() {
  await writeHistory([]);
}

function clampScore(score) {
  return Math.max(1, Math.min(10, score));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeXml(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)));
}

function normalizeText(value = "") {
  return decodeXml(String(value))
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function extractTag(block, tagName) {
  const pattern = new RegExp(`<${escapeRegExp(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "i");
  const match = block.match(pattern);
  return match ? decodeXml(match[1].trim()) : "";
}

function extractAttribute(block, tagName, attributeName) {
  const pattern = new RegExp(
    `<${escapeRegExp(tagName)}\\b[^>]*\\b${escapeRegExp(attributeName)}=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const match = block.match(pattern);
  return match ? decodeXml(match[1].trim()) : "";
}

function parseRssItems(xml) {
  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return itemBlocks.map((block) => ({
    title: extractTag(block, "title"),
    link: extractTag(block, "link"),
    guid: extractTag(block, "guid"),
    description: extractTag(block, "description"),
    enclosureUrl: extractAttribute(block, "enclosure", "url"),
    raw: block
  }));
}

function buildAppleSlugHints(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const podcastIndex = segments.findIndex((segment) => segment === "podcast");
    const slug = podcastIndex >= 0 ? segments[podcastIndex + 1] || "" : "";
    return decodeURIComponent(slug).replace(/-/g, " ");
  } catch {
    return "";
  }
}

function parseApplePodcastUrl(url) {
  try {
    const parsed = new URL(url);
    if (!APPLE_PODCAST_HOST_PATTERN.test(parsed.hostname)) {
      return null;
    }

    const match = parsed.pathname.match(/\/id(\d+)/i);
    if (!match) {
      return null;
    }

    return {
      podcastId: match[1],
      episodeId: parsed.searchParams.get("i") || "",
      slugHint: buildAppleSlugHints(url)
    };
  } catch {
    return null;
  }
}

function extractAppleTitle(html, fallbackSlug) {
  const metaTitle =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<title>([^<]+)<\/title>/i)?.[1] ||
    "";
  const cleanedTitle = decodeXml(metaTitle)
    .replace(/\s+on Apple Podcasts\s*$/i, "")
    .replace(/\s+-\s+Apple Podcasts\s*$/i, "")
    .trim();
  return cleanedTitle || fallbackSlug;
}

async function fetchApplePodcastLookup(podcastId) {
  const response = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(podcastId)}`, {
    redirect: "follow"
  });
  if (!response.ok) {
    throw new Error(`Apple lookup failed: ${response.status}`);
  }
  const data = await response.json();
  const podcast = Array.isArray(data.results)
    ? data.results.find((item) => item.wrapperType === "track" || item.kind === "podcast")
    : null;

  if (!podcast?.feedUrl) {
    throw new Error("Could not find podcast RSS feed from Apple metadata.");
  }

  return podcast;
}

function scoreFeedItem(item, hints) {
  const title = normalizeText(item.title);
  const candidateTexts = [item.link, item.guid, item.description].map(normalizeText).join(" ");
  let score = 0;

  if (hints.episodeId && candidateTexts.includes(hints.episodeId)) {
    score += 10;
  }
  if (hints.title && title === hints.title) {
    score += 8;
  }
  if (hints.title && title.includes(hints.title)) {
    score += 6;
  }
  if (hints.title && hints.title.includes(title) && title) {
    score += 4;
  }
  if (hints.slug && title.includes(hints.slug)) {
    score += 3;
  }

  return score;
}

function findBestFeedItem(items, hints) {
  let bestItem = null;
  let bestScore = 0;

  for (const item of items) {
    const score = scoreFeedItem(item, hints);
    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }

  return bestScore > 0 ? bestItem : null;
}

async function resolveApplePodcastEpisode(url) {
  const parsedAppleUrl = parseApplePodcastUrl(url);
  if (!parsedAppleUrl) {
    return null;
  }

  const [lookup, pageResponse] = await Promise.all([
    fetchApplePodcastLookup(parsedAppleUrl.podcastId),
    fetch(url, { redirect: "follow" })
  ]);

  if (!pageResponse.ok) {
    throw new Error(`Failed to load Apple Podcasts page: ${pageResponse.status}`);
  }

  const pageHtml = await pageResponse.text();
  const appleTitle = extractAppleTitle(pageHtml, parsedAppleUrl.slugHint);
  const rssResponse = await fetch(lookup.feedUrl, { redirect: "follow" });
  if (!rssResponse.ok) {
    throw new Error(`Failed to load podcast RSS feed: ${rssResponse.status}`);
  }

  const rssXml = await rssResponse.text();
  const items = parseRssItems(rssXml);
  const matchedItem = findBestFeedItem(items, {
    episodeId: normalizeText(parsedAppleUrl.episodeId),
    title: normalizeText(appleTitle),
    slug: normalizeText(parsedAppleUrl.slugHint)
  });

  if (!matchedItem?.enclosureUrl) {
    throw new Error("Could not match this Apple Podcasts episode to an RSS item with audio.");
  }

  return {
    audioUrl: matchedItem.enclosureUrl,
    episodeLink: matchedItem.link,
    rssFeedUrl: lookup.feedUrl,
    resolvedFrom: "apple_podcasts"
  };
}

function pickMediaUrl(html, baseUrl) {
  for (const pattern of MEDIA_PATTERNS) {
    const match = html.match(pattern);
    if (match && match[1]) {
      try {
        return new URL(match[1], baseUrl).href;
      } catch {
        return match[1];
      }
    }
  }
  return null;
}

async function resolveMediaUrl(url) {
  if (AUDIO_FILE_PATTERN.test(url)) {
    return { audioUrl: url, episodeLink: "", rssFeedUrl: "", resolvedFrom: "direct_audio" };
  }

  const appleEpisode = await resolveApplePodcastEpisode(url);
  if (appleEpisode) {
    return appleEpisode;
  }

  let headResponse = null;
  try {
    headResponse = await fetch(url, { method: "HEAD", redirect: "follow" });
  } catch {
    headResponse = null;
  }

  const headType = headResponse?.headers?.get("content-type") || "";
  const finalHeadUrl = headResponse?.url || url;
  if (headType.startsWith("audio/") || headType.startsWith("video/")) {
    return { audioUrl: finalHeadUrl, episodeLink: "", rssFeedUrl: "", resolvedFrom: "direct_media_head" };
  }
  if (AUDIO_FILE_PATTERN.test(finalHeadUrl)) {
    return { audioUrl: finalHeadUrl, episodeLink: "", rssFeedUrl: "", resolvedFrom: "direct_media_redirect" };
  }

  const pageResponse = await fetch(url, { redirect: "follow" });
  if (!pageResponse.ok) {
    throw new Error(`Failed to load page: ${pageResponse.status}`);
  }

  const html = await pageResponse.text();
  const mediaUrl = pickMediaUrl(html, pageResponse.url);
  if (mediaUrl) {
    return { audioUrl: mediaUrl, episodeLink: pageResponse.url, rssFeedUrl: "", resolvedFrom: "page_scrape" };
  }

  throw new Error("Could not find an audio URL on this page. Try a direct MP3/M4A link or an RSS episode link.");
}

async function createTranscript(audioUrl, apiKey) {
  const response = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      speech_models: ["universal-3-pro", "universal-2"],
      auto_chapters: true,
      auto_highlights: true,
      speaker_labels: false,
      language_detection: true,
      punctuate: true
    })
  });

  const data = await response.json();
  if (!response.ok || !data.id) {
    throw new Error(`AssemblyAI submit failed: ${JSON.stringify(data)}`);
  }
  return data.id;
}

async function pollTranscript(transcriptId, apiKey) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      headers: { Authorization: apiKey }
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`AssemblyAI poll failed: ${JSON.stringify(data)}`);
    }
    if (data.status === "completed") {
      return data;
    }
    if (data.status === "error") {
      throw new Error(`AssemblyAI transcription error: ${data.error || "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }

  throw new Error("Timed out waiting for transcript. Increase polling duration if your podcast is very long.");
}

function buildAnalysisResult({ rawUrl, mediaResolution, goal, transcript }) {
  const highlights = (transcript.auto_highlights_result?.results || [])
    .slice(0, 10)
    .map((item) => item.text);
  const chapters = (transcript.chapters || []).map((item) => ({
    headline: item.headline,
    summary: item.summary,
    start_ms: item.start,
    end_ms: item.end
  }));
  const chapterSummary = chapters
    .slice(0, 5)
    .map((item) => `- ${item.headline || "Untitled"}: ${item.summary || ""}`)
    .join("\n");
  const derivedSummary = chapterSummary || highlights.slice(0, 5).map((item) => `- ${item}`).join("\n");
  const minutes = Math.round((transcript.audio_duration || 0) / 60);

  let score = 5;
  if (highlights.length >= 3) score += 1;
  if (highlights.length >= 6) score += 1;
  if (chapters.length >= 2) score += 1;
  if (chapters.length >= 4) score += 1;
  if (derivedSummary) score += 1;
  if (minutes >= 15 && minutes <= 90) score += 1;
  if (minutes > 120) score -= 1;

  const estimatedValueScore = clampScore(score);
  const recommendation = estimatedValueScore >= 8
    ? "Worth a full listen."
    : "Read the summary first, then decide.";

  return {
    input_url: rawUrl,
    resolved_audio_url: mediaResolution.audioUrl,
    resolved_episode_link: mediaResolution.episodeLink || "",
    resolved_rss_feed_url: mediaResolution.rssFeedUrl || "",
    resolved_from: mediaResolution.resolvedFrom,
    interest_goal: goal,
    transcript_id: transcript.id,
    speech_model_used: transcript.speech_model_used || "",
    audio_minutes: minutes,
    estimated_value_score: estimatedValueScore,
    recommendation,
    note: "The score is heuristic. Use chapters, highlights, and summary to make the final decision.",
    assemblyai_summary: derivedSummary,
    key_highlights: highlights,
    chapters,
    transcript: transcript.text || ""
  };
}

async function analyzePodcast(body) {
  const rawUrl = String(body.podcast_url || body.audio_url || body.url || "").trim();
  const goal = String(body.interest_goal || "General learning value for a busy knowledge worker").trim();
  const apiKey = ASSEMBLYAI_API_KEY;

  if (!rawUrl) {
    throw new Error("Missing `podcast_url` or `audio_url`.");
  }
  if (!apiKey) {
    throw new Error("Missing `ASSEMBLYAI_API_KEY` environment variable.");
  }

  const mediaResolution = await resolveMediaUrl(rawUrl);
  const transcriptId = await createTranscript(mediaResolution.audioUrl, apiKey);
  const transcript = await pollTranscript(transcriptId, apiKey);
  const result = buildAnalysisResult({ rawUrl, mediaResolution, goal, transcript });
  await saveHistoryEntry(result);
  return result;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      if (!isAuthenticated(req)) {
        res.writeHead(302, { Location: "/login" });
        res.end();
        return;
      }
      sendFile(res, path.join(PUBLIC_DIR, "index.html"));
      return;
    }

    if (req.method === "HEAD" && req.url === "/") {
      if (!isAuthenticated(req)) {
        sendHead(res, 302, "text/html; charset=utf-8");
        return;
      }
      sendHead(res, 200, "text/html; charset=utf-8");
      return;
    }

    if (req.method === "GET" && req.url === "/login") {
      if (isAuthenticated(req)) {
        res.writeHead(302, { Location: "/" });
        res.end();
        return;
      }
      sendFile(res, path.join(PUBLIC_DIR, "login.html"));
      return;
    }

    if (req.method === "GET" && req.url === "/history") {
      if (!isAuthenticated(req)) {
        res.writeHead(302, { Location: "/login" });
        res.end();
        return;
      }
      sendFile(res, path.join(PUBLIC_DIR, "history.html"));
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "HEAD" && req.url === "/health") {
      sendHead(res, 200, "application/json; charset=utf-8");
      return;
    }

    if (req.method === "GET" && req.url === "/styles.css") {
      sendFile(res, path.join(PUBLIC_DIR, "styles.css"));
      return;
    }

    if (req.method === "GET" && req.url === "/app.js") {
      sendFile(res, path.join(PUBLIC_DIR, "app.js"));
      return;
    }

    if (req.method === "GET" && req.url === "/history.js") {
      sendFile(res, path.join(PUBLIC_DIR, "history.js"));
      return;
    }

    if (req.method === "GET" && req.url === "/login.js") {
      sendFile(res, path.join(PUBLIC_DIR, "login.js"));
      return;
    }

    if (req.method === "GET" && req.url === "/api/session") {
      sendJson(res, 200, { authenticated: isAuthenticated(req), passwordEnabled: Boolean(APP_PASSWORD) });
      return;
    }

    if (req.method === "GET" && req.url === "/api/debug/env") {
      if (!requireAuth(req, res)) {
        return;
      }
      sendJson(res, 200, {
        appPasswordConfigured: Boolean(APP_PASSWORD),
        assemblyAiApiKeyConfigured: Boolean(ASSEMBLYAI_API_KEY),
        historyFile: HISTORY_FILE,
        nodeEnv: process.env.NODE_ENV || "",
        host: HOST,
        port: PORT
      });
      return;
    }

    if (req.method === "GET" && req.url === "/api/history") {
      if (!requireAuth(req, res)) {
        return;
      }
      const history = await readHistory();
      sendJson(res, 200, { items: history });
      return;
    }

    if (req.method === "DELETE" && req.url.startsWith("/api/history/")) {
      if (!requireAuth(req, res)) {
        return;
      }
      const entryId = decodeURIComponent(req.url.slice("/api/history/".length));
      if (!entryId) {
        sendJson(res, 400, { error: "Missing history entry id." });
        return;
      }
      const deleted = await deleteHistoryEntry(entryId);
      if (!deleted) {
        sendJson(res, 404, { error: "History entry not found." });
        return;
      }
      sendJson(res, 200, { ok: true, deletedId: entryId });
      return;
    }

    if (req.method === "DELETE" && req.url === "/api/history") {
      if (!requireAuth(req, res)) {
        return;
      }
      await clearHistory();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && req.url === "/api/login") {
      if (!APP_PASSWORD) {
        sendJson(res, 200, { ok: true, passwordEnabled: false });
        return;
      }

      const body = await readJsonBody(req);
      const password = String(body.password || "");
      if (password !== APP_PASSWORD) {
        sendJson(res, 401, { error: "Wrong password." });
        return;
      }

      const token = createSessionToken();
      activeSessions.add(token);
      sendJson(res, 200, { ok: true }, { "Set-Cookie": buildSessionCookie(token) });
      return;
    }

    if (req.method === "POST" && req.url === "/api/logout") {
      const cookies = parseCookies(req);
      const token = cookies[SESSION_COOKIE];
      if (token) {
        activeSessions.delete(token);
      }
      res.writeHead(204, { "Set-Cookie": clearSessionCookie() });
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/api/analyze") {
      if (!requireAuth(req, res)) {
        return;
      }
      const body = await readJsonBody(req);
      const result = await analyzePodcast(body);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Podcast Summary web app listening on http://${HOST}:${PORT}`);
});
