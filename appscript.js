// ============================================================
//  📌 收藏它 — Google Apps Script 後端 v3（安全強化版）
//
//  安全機制：
//  1. API Secret — Shortcut POST 必須帶正確的 secret 才能寫入
//  2. Web 密碼 — 開啟 Web UI 需要輸入密碼，session 存 24 小時
//  3. 速率限制 — 同一分鐘內最多 10 次 POST，防灌爆
//  4. 安全日誌 — 所有驗證失敗都記錄到「安全日誌」工作表
// ============================================================

// ── 設定區（你只需要改這裡）──────────────────────────────
const scriptProperties = PropertiesService.getScriptProperties();

const CONFIG = {

  OPENAI_API_KEY: scriptProperties.getProperty('openai-key'),

  // ★ 安全設定
  API_SECRET: scriptProperties.getProperty('API_SECRET'),     // Shortcut POST 時要帶這個值
  WEB_PASSWORD: scriptProperties.getProperty('API_SECRET'),    // 開 Web UI 時要輸入的密碼
  RATE_LIMIT_PER_MIN: 10,                   // 每分鐘最多幾次 POST

  SHEET_NAME: '收藏庫',
  DRIVE_FOLDER_NAME: '收藏截圖',

  CATEGORIES: [
    '設計靈感', '技術文章', '影片內容',
    '商業觀點', '生活靈感', '工具資源', '其他'
  ]
};


// ── 安全：驗證 API Secret ───────────────────────────────
function verifyAPISecret(data) {
  var secret = data.secret || data.api_key || '';
  return secret === CONFIG.API_SECRET;
}


// ── 安全：驗證 Web 密碼 ─────────────────────────────────
function verifyWebPassword(password) {
  return password === CONFIG.WEB_PASSWORD;
}


// ── 安全：生成 Session Token ────────────────────────────
function generateSessionToken() {
  // 用時間戳 + 隨機數 + 密碼的 hash 當 token
  var raw = CONFIG.WEB_PASSWORD + '_' + new Date().getTime() + '_' + Math.random();
  var hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw);
  var token = hash.map(function(b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');

  // 存到 Script Properties，24 小時過期
  var props = PropertiesService.getScriptProperties();
  var sessions = JSON.parse(props.getProperty('sessions') || '{}');

  // 清理過期的 session
  var now = new Date().getTime();
  Object.keys(sessions).forEach(function(t) {
    if (now - sessions[t] > 24 * 60 * 60 * 1000) {
      delete sessions[t];
    }
  });

  sessions[token] = now;
  props.setProperty('sessions', JSON.stringify(sessions));

  return token;
}


// ── 安全：驗證 Session Token ────────────────────────────
function verifySessionToken(token) {
  if (!token) return false;

  var props = PropertiesService.getScriptProperties();
  var sessions = JSON.parse(props.getProperty('sessions') || '{}');

  if (!sessions[token]) return false;

  // 檢查是否過期（24 小時）
  var now = new Date().getTime();
  if (now - sessions[token] > 24 * 60 * 60 * 1000) {
    delete sessions[token];
    props.setProperty('sessions', JSON.stringify(sessions));
    return false;
  }

  return true;
}

// Web UI 呼叫的登入函式
function webLogin(password) {
  if (verifyWebPassword(password)) {
    var token = generateSessionToken();
    return { success: true, token: token };
  }
  logSecurityEvent('WEB_LOGIN_FAILED', '密碼錯誤');
  return { success: false };
}

// Web UI 呼叫的 session 驗證
function webVerifySession(token) {
  return verifySessionToken(token);
}


// ── 安全：速率限制 ──────────────────────────────────────
function checkRateLimit() {
  var props = PropertiesService.getScriptProperties();
  var now = new Date().getTime();
  var windowKey = 'ratelimit_' + Math.floor(now / 60000);  // 每分鐘一個 key

  var count = parseInt(props.getProperty(windowKey) || '0', 10);

  if (count >= CONFIG.RATE_LIMIT_PER_MIN) {
    return false;  // 超過限制
  }

  props.setProperty(windowKey, String(count + 1));

  // 清理舊的 rate limit key（2 分鐘前的）
  var oldKey = 'ratelimit_' + Math.floor(now / 60000 - 2);
  props.deleteProperty(oldKey);

  return true;
}


// ── 安全：記錄安全事件 ──────────────────────────────────
function logSecurityEvent(eventType, details) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('安全日誌');

    if (!sheet) {
      sheet = ss.insertSheet('安全日誌');
      sheet.appendRow(['時間', '事件類型', '詳情']);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    }

    sheet.insertRowAfter(1);
    sheet.getRange(2, 1, 1, 3).setValues([[
      new Date(),
      eventType,
      details
    ]]);
  } catch (err) {
    Logger.log('logSecurityEvent error: ' + err.toString());
  }
}


// ── POST 端點：接收 iOS Shortcut 的資料 ─────────────────
function doPost(e) {
  try {
    let data;

    console.log('')

    // 安全解析 JSON
    try {
      data = JSON.parse(e.postData.contents);
    } catch (jsonErr) {
      let raw = e.postData.contents || '';
      raw = raw.replace(/[\x00-\x1F\x7F]/g, '');
      data = JSON.parse(raw);
    }

    // ★ 安全檢查 1：驗證 API Secret
    if (!verifyAPISecret(data)) {
      logSecurityEvent('AUTH_FAILED', 'Invalid API secret. Type: ' + (data.type || 'unknown'));
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error',
        message: '驗證失敗：API Secret 不正確'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // ★ 安全檢查 2：速率限制
    if (!checkRateLimit()) {
      logSecurityEvent('RATE_LIMITED', 'Too many requests');
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error',
        message: '請求過於頻繁，請稍後再試'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const inputType = data.type || 'url';

    let result;

    if (inputType === 'image') {
      result = processImage(data);
    } else if (inputType === 'text') {
      result = processText(data);
    } else {
      result = processURL(data);
    }

    // 寫入 Google Sheet
    saveToSheet(result);

    // 回傳 JSON 給 Shortcut
    return ContentService.createTextOutput(JSON.stringify({
      status: 'ok',
      category: result.category,
      tags: result.tags,
      summary: result.summary,
      listName: '收藏-' + result.category,
      ocrText: result.ocrText || '',
      platform: result.platform || '',
      originalTitle: result.title || '',
      url: result.url || ''
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log('doPost error: ' + error.toString());
    Logger.log('Raw input: ' + (e.postData ? e.postData.contents : 'none').substring(0, 500));
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: error.toString(),
      category: '其他',
      tags: '⚡待分類',
      summary: '收藏失敗，請手動分類',
      listName: '收藏-其他',
      ocrText: '',
      platform: '',
      originalTitle: '',
      url: ''
    })).setMimeType(ContentService.MimeType.JSON);
  }
}


// ── GET 端點：提供 Web UI（需要登入）───────────────────
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('我的收藏庫')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}


// ── Web UI：取得收藏（★ 需要 session）──────────────────
function getBookmarksSecure(token) {
  if (!verifySessionToken(token)) {
    return { error: 'unauthorized' };
  }
  return getBookmarks();
}


// ── 處理 URL 輸入 ──────────────────────────────────────
function processURL(data) {
  const rawUrl = data.url || '';
  const title = data.title || '';
  const shareText = data.shareText || data.text || '';
  const memo = data.memo || '';

  // 清理 URL（移除追蹤參數）
  const url = cleanURL(rawUrl);

  // 偵測平台
  const platform = detectPlatform(url);

  // 從 URL 結構提取線索
  const urlHints = extractURLHints(url);

  // 嘗試抓取網頁 OG 標籤
  let pageContent = '';
  let fetchSuccess = false;
  let previewImage = '';

  try {
    if (url && url.startsWith('http')) {
      const response = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
        }
      });

      const statusCode = response.getResponseCode();
      const html = response.getContentText();

      if (statusCode >= 200 && statusCode < 400 && html.length > 200) {
        const parsed = parseMetaTags(html);
        pageContent = parsed.text;
        previewImage = parsed.image;
        fetchSuccess = pageContent.length > 10;
      }
    }
  } catch (err) {
    Logger.log('URL fetch failed for: ' + url + ' — ' + err.toString());
  }

  // Instagram: fallback to JSON endpoints when HTML is blocked
  if (!fetchSuccess && platform === 'Instagram') {
    const igMeta = fetchInstagramMeta(url);
    if (igMeta.success) {
      pageContent = igMeta.text;
      previewImage = igMeta.image;
      fetchSuccess = true;
    }
  }

  // 組合標題
  const finalTitle = title
    || (pageContent ? pageContent.split(' | ')[0] : '')
    || urlHints.displayName
    || url;

  // 組合 AI 上下文
  let aiContext = '';

  if (fetchSuccess) {
    aiContext = pageContent;
    if (memo) {
      aiContext = '使用者備註（優先參考）：' + memo.substring(0, 800) + '\n\n' + aiContext;
    }
    if (shareText && shareText !== rawUrl && shareText !== url) {
      aiContext += '\n\n分享時附帶文字：' + shareText.substring(0, 500);
    }
  } else {
    // 抓不到內容 → 用所有其他線索
    const hints = [];
    if (memo) hints.push('使用者備註（優先參考）：' + memo.substring(0, 800));
    if (platform && platform !== 'Web') hints.push('來源平台：' + platform);
    if (urlHints.username) hints.push('帳號：@' + urlHints.username);
    if (urlHints.contentType) hints.push('內容類型：' + urlHints.contentType);
    if (urlHints.displayName) hints.push('描述：' + urlHints.displayName);
    if (shareText && shareText !== rawUrl && shareText !== url) {
      hints.push('分享時附帶文字：' + shareText.substring(0, 500));
    }
    if (url) hints.push('原始連結：' + url);

    aiContext = hints.length > 0
      ? hints.join('\n') + '\n（注意：此為封閉平台或 SPA 頁面，無法抓取完整內容，請根據以上有限資訊盡力分類）'
      : '(無法取得任何內容)';
  }

  // 呼叫 AI
  const aiResult = callOpenAI_Text(finalTitle, url, aiContext);

  return {
    timestamp: new Date(),
    type: 'url',
    title: finalTitle,
    url: rawUrl,
    category: aiResult.category,
    tags: aiResult.tags,
    summary: fetchSuccess ? aiResult.summary : '🔒 ' + aiResult.summary,
    memo: memo,
    fullText: pageContent || '',
    ocrText: '',
    platform: platform,
    imageUrl: previewImage || ''
  };
}


// ── 處理純文字輸入 ──────────────────────────────────────
function processText(data) {
  const text = data.text || '';
  const aiResult = callOpenAI_Text(text, '', text);

  return {
    timestamp: new Date(),
    type: 'text',
    title: text.substring(0, 100),
    url: '',
    category: aiResult.category,
    tags: aiResult.tags,
    summary: aiResult.summary,
    memo: '',
    fullText: text,
    ocrText: '',
    platform: '文字',
    imageUrl: ''
  };
}


// ── 處理截圖/圖片輸入 ───────────────────────────────────
function processImage(data) {
  const base64 = data.image || '';

  let imageUrl = '';
  let fileId = '';
  try {
    const folder = getOrCreateFolder(CONFIG.DRIVE_FOLDER_NAME);
    const filename = '收藏_' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd_HHmmss') + '.jpg';
    const blob = Utilities.newBlob(Utilities.base64Decode(base64), 'image/jpeg', filename);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    fileId = file.getId();
    imageUrl = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w800';
  } catch (err) {
    Logger.log('Image save failed: ' + err.toString());
  }

  const aiResult = callOpenAI_Vision(base64);

  return {
    timestamp: new Date(),
    type: 'image',
    title: aiResult.summary,
    url: fileId ? ('https://drive.google.com/file/d/' + fileId + '/view') : '',
    category: aiResult.category,
    tags: aiResult.tags,
    summary: aiResult.summary,
    memo: '',
    fullText: aiResult.ocr_text || '',
    ocrText: aiResult.ocr_text || '',
    platform: '截圖',
    imageUrl: imageUrl
  };
}


// ── AI：處理文字/URL ────────────────────────────────────
function callOpenAI_Text(title, url, excerpt) {
  const categoriesList = CONFIG.CATEGORIES.join('、');

  // ★ 清洗文字：移除可能炸 JSON 的字元，並截斷
  var cleanTitle = sanitizeForAPI(title).substring(0, 200);
  var cleanExcerpt = sanitizeForAPI(excerpt).substring(0, 800);

  const messages = [
    {
      role: 'system',
      content: '你是一個內容分類助手。根據使用者提供的網頁標題、網址和內容摘要，回傳 JSON 格式的分類結果。\n\n分類必須是以下之一：' + categoriesList + '\n\n嚴格回傳以下 JSON 格式，不要有任何其他文字、不要 markdown code block：\n{"category": "分類名", "tags": "#標籤1 #標籤2 #標籤3", "summary": "一句話中文摘要（30字以內）"}'
    },
    {
      role: 'user',
      content: '標題：' + cleanTitle + '\n網址：' + url + '\n內容摘要：' + cleanExcerpt
    }
  ];

  return callOpenAI(messages);
}


// ── AI：處理圖片（Vision）───────────────────────────────
function callOpenAI_Vision(base64Image) {
  const categoriesList = CONFIG.CATEGORIES.join('、');

  const messages = [
    {
      role: 'system',
      content: '你是一個內容分類助手。根據使用者提供的截圖，辨識其中的內容。\n\n如果圖片中有文字，請 OCR 辨識重點文字。\n如果是設計/UI 截圖，描述其視覺內容。\n如果是社群貼文截圖，擷取貼文重點。\n\n分類必須是以下之一：' + categoriesList + '\n\n嚴格回傳以下 JSON 格式，不要有任何其他文字、不要 markdown code block：\n{"category": "分類名", "tags": "#標籤1 #標籤2 #標籤3", "summary": "一句話中文摘要（30字以內）", "ocr_text": "圖中關鍵文字（100字以內，沒有則空字串）"}'
    },
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: 'data:image/jpeg;base64,' + base64Image,
            detail: 'low'
          }
        },
        {
          type: 'text',
          text: '請分析這張截圖的內容並分類。'
        }
      ]
    }
  ];

  return callOpenAI(messages);
}


// ── AI：共用呼叫函式 ────────────────────────────────────
function callOpenAI(messages) {
  const payload = {
    model: 'gpt-4o-mini',
    temperature: 0.3,
    max_tokens: 300,
    messages: messages
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + CONFIG.OPENAI_API_KEY
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    var payloadStr = JSON.stringify(payload);
    Logger.log('API payload size: ' + payloadStr.length + ' bytes');
    
    const response = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', options);
    const responseText = response.getContentText();
    const json = JSON.parse(responseText);

    if (json.error) {
      Logger.log('OpenAI API error: ' + JSON.stringify(json.error));
      return { category: '其他', tags: '⚡待分類', summary: 'AI 錯誤: ' + (json.error.message || '').substring(0, 50), ocr_text: '' };
    }

    let content = json.choices[0].message.content.trim();
    content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    Logger.log('AI raw response: ' + content);

    const result = JSON.parse(content);

    if (!CONFIG.CATEGORIES.includes(result.category)) {
      result.category = '其他';
    }

    return result;

  } catch (err) {
    Logger.log('callOpenAI error: ' + err.toString());
    Logger.log('Payload preview: ' + JSON.stringify(messages[messages.length - 1]).substring(0, 300));
    return { category: '其他', tags: '⚡待分類', summary: 'AI 分類失敗', ocr_text: '' };
  }
}


// ── 儲存到 Google Sheet ─────────────────────────────────
function saveToSheet(result) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    sheet.appendRow([
      '時間戳記', '類型', '標題', 'URL', '分類',
      '標籤', '摘要', '備註', '全文內容', 'OCR文字', '來源平台', '圖片URL'
    ]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 12).setFontWeight('bold');
  }

  sheet.insertRowAfter(1);
  sheet.getRange(2, 1, 1, 12).setValues([[
    result.timestamp,
    result.type,
    result.title,
    result.url,
    result.category,
    result.tags,
    result.summary,
    result.memo || '',
    result.fullText || '',
    result.ocrText || '',
    result.platform || '',
    result.imageUrl || ''
  ]]);
}


// ── Web UI：取得收藏 ────────────────────────────────────
function getBookmarks() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) return [];

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 12).getValues();

  return data.map(function(row) {
    return {
      timestamp: row[0] ? Utilities.formatDate(new Date(row[0]), 'Asia/Taipei', 'yyyy/MM/dd HH:mm') : '',
      type: row[1],
      title: row[2],
      url: row[3],
      category: row[4],
      tags: row[5],
      summary: row[6],
      memo: row[7],
      fullText: row[8],
      ocrText: row[9],
      platform: row[10],
      imageUrl: row[11]
    };
  });
}


// ── Web UI：取得統計 ────────────────────────────────────
function getStats() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return { total: 0, categories: {}, platforms: {} };
  }

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 12).getValues();
  const categories = {};
  const platforms = {};

  data.forEach(function(row) {
    categories[row[4] || '其他'] = (categories[row[4] || '其他'] || 0) + 1;
    platforms[row[10] || '未知'] = (platforms[row[10] || '未知'] || 0) + 1;
  });

  return { total: data.length, categories: categories, platforms: platforms };
}


// ================================================================
//  工具函式
// ================================================================

// ── ★ 新增：清洗文字（送 API 前）────────────────────────
function sanitizeForAPI(str) {
  if (!str) return '';
  return str
    // 移除 null bytes 和控制字元（保留換行和 tab）
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // 移除零寬字元
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    // 多個空白壓縮成一個
    .replace(/[ \t]+/g, ' ')
    // 多個換行壓縮成一個
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


// ── ★ 修正：偵測來源平台（加入 threads.com）─────────────
function detectPlatform(url) {
  if (!url) return '未知';
  var u = url.toLowerCase();
  if (u.includes('instagram.com')) return 'Instagram';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
  if (u.includes('threads.net') || u.includes('threads.com')) return 'Threads';
  if (u.includes('facebook.com') || u.includes('fb.com') || u.includes('fb.watch')) return 'Facebook';
  if (u.includes('x.com') || u.includes('twitter.com')) return 'X';
  if (u.includes('tiktok.com')) return 'TikTok';
  if (u.includes('linkedin.com')) return 'LinkedIn';
  if (u.includes('medium.com')) return 'Medium';
  if (u.includes('github.com')) return 'GitHub';
  if (u.includes('reddit.com')) return 'Reddit';
  if (u.includes('notion.so') || u.includes('notion.site')) return 'Notion';
  return 'Web';
}


// ── ★ 新增：清理 URL（移除追蹤參數）────────────────────
function cleanURL(url) {
  if (!url) return '';
  try {
    var trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
      'fbclid', 'gclid', 'igshid', 'igsh',
      'xmt', 'slof',           // Threads 追蹤參數
      'si',                     // YouTube
      'ref', 'ref_src',
      '_nc_ht', '_nc_cat',      // Meta 追蹤
      'feature', 'app'
    ];

    // Apps Script 沒有 URL 物件，手動處理
    var parts = url.split('?');
    if (parts.length < 2) return url;

    var base = parts[0];
    var params = parts[1].split('&').filter(function(p) {
      var key = p.split('=')[0].toLowerCase();
      return trackingParams.indexOf(key) === -1;
    });

    return params.length > 0 ? base + '?' + params.join('&') : base;
  } catch (err) {
    return url;
  }
}


// ── ★ HTML Entity 解碼 ──────────────────────────────────
function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    // &#x4e0a; → Unicode hex
    .replace(/&#x([0-9a-fA-F]+);/g, function(m, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    })
    // &#064; → Unicode decimal
    .replace(/&#(\d+);/g, function(m, dec) {
      return String.fromCharCode(parseInt(dec, 10));
    })
    // &amp; &lt; &gt; &quot; &apos;
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}


// ── ★ 強化：解析 HTML meta 標籤（含 decode）─────────────
function parseMetaTags(html) {
  var result = { text: '', image: '' };

  try {
    var headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    var head = headMatch ? headMatch[1] : html.substring(0, 8000);

    function getMeta(attrName, attrValue) {
      var r1 = new RegExp(
        '<meta[^>]*' + attrName + '=["\']' + attrValue + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'
      );
      var r2 = new RegExp(
        '<meta[^>]*content=["\']([^"\']*)["\'][^>]*' + attrName + '=["\']' + attrValue + '["\']', 'i'
      );
      var m1 = head.match(r1);
      var m2 = head.match(r2);
      var raw = (m1 && m1[1]) || (m2 && m2[1]) || '';
      // ★ 解碼 HTML entities
      return decodeHtmlEntities(raw);
    }

    // OG 標籤
    var ogTitle = getMeta('property', 'og:title');
    var ogDesc = getMeta('property', 'og:description');
    var ogImage = getMeta('property', 'og:image');

    // Twitter Card
    var twTitle = getMeta('name', 'twitter:title') || getMeta('property', 'twitter:title');
    var twDesc = getMeta('name', 'twitter:description') || getMeta('property', 'twitter:description');
    var twImage = getMeta('name', 'twitter:image') || getMeta('property', 'twitter:image');

    // 標準 meta
    var metaDesc = getMeta('name', 'description');

    // <title>
    var titleMatch = head.match(/<title[^>]*>([^<]+)<\/title>/i);
    var pageTitle = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

    // 組合（★ 強化去重：如果文字被包含在另一段裡就跳過）
    var texts = [];
    [ogTitle, pageTitle, twTitle, ogDesc, twDesc, metaDesc].forEach(function(t) {
      var trimmed = (t || '').trim();
      if (!trimmed) return;
      // 檢查是否已有相似的內容（包含關係）
      var dominated = texts.some(function(existing) {
        return existing.includes(trimmed) || trimmed.includes(existing);
      });
      if (dominated) {
        // 如果新的比既有的長，替換掉（保留最完整版）
        for (var i = 0; i < texts.length; i++) {
          if (trimmed.includes(texts[i]) && trimmed.length > texts[i].length) {
            texts[i] = trimmed;
            return;
          }
        }
        return;
      }
      texts.push(trimmed);
    });

    result.text = texts.join(' | ');
    // ★ 圖片 URL 也要解碼（&amp; → &）
    result.image = decodeHtmlEntities(ogImage || twImage || '');

  } catch (err) {
    Logger.log('parseMetaTags error: ' + err.toString());
  }

  return result;
}


// ── Instagram JSON fallback ─────────────────────────────
function extractInstagramInfo(url) {
  if (!url) return { shortcode: '', type: '' };
  var m = url.match(/instagram\.com\/(p|reel|tv)\/([^\/\?]+)/i);
  return m ? { shortcode: m[2], type: m[1].toLowerCase() } : { shortcode: '', type: '' };
}

function fetchInstagramMeta(url) {
  var result = { text: '', image: '', success: false };
  var info = extractInstagramInfo(url);
  if (!info.shortcode) return result;

  var primaryPath = info.type === 'reel' ? 'reel' : 'p';
  var endpoints = [
    'https://www.instagram.com/' + primaryPath + '/' + info.shortcode + '/?__a=1&__d=dis',
    'https://www.instagram.com/' + primaryPath + '/' + info.shortcode + '/?__a=1',
    // fallback to /p/ in case reels endpoint is blocked
    'https://www.instagram.com/p/' + info.shortcode + '/?__a=1&__d=dis',
    'https://www.instagram.com/p/' + info.shortcode + '/?__a=1'
  ];

  for (var i = 0; i < endpoints.length; i++) {
    try {
      var response = UrlFetchApp.fetch(endpoints[i], {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json,text/plain,*/*',
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
        }
      });

      var statusCode = response.getResponseCode();
      var body = response.getContentText();

      if (statusCode >= 200 && statusCode < 400 && body) {
        var json = JSON.parse(body);
        var media = null;

        if (json.graphql && json.graphql.shortcode_media) {
          media = json.graphql.shortcode_media;
        } else if (json.items && json.items.length > 0) {
          media = json.items[0];
        }

        if (media) {
          var owner = (media.owner && media.owner.username) || '';
          var caption = '';
          if (media.edge_media_to_caption && media.edge_media_to_caption.edges && media.edge_media_to_caption.edges.length > 0) {
            caption = media.edge_media_to_caption.edges[0].node.text || '';
          } else if (media.caption && media.caption.text) {
            caption = media.caption.text;
          }

          var parts = [];
          if (owner) parts.push('@' + owner);
          if (caption) parts.push(caption);

          result.text = parts.join(' | ').substring(0, 1000);
          result.image = media.display_url
            || (media.image_versions2 && media.image_versions2.candidates && media.image_versions2.candidates[0] && media.image_versions2.candidates[0].url)
            || '';

          result.success = result.text.length > 10;
          return result;
        }
      }
    } catch (err) {
      Logger.log('Instagram JSON fetch failed: ' + err.toString());
    }
  }

  return result;
}


// ── 從 URL 結構提取線索 ─────────────────────────────────
function extractURLHints(url) {
  var hints = {
    username: '',
    platform: '',
    contentType: '',
    displayName: '',
    previewImage: ''
  };

  if (!url) return hints;

  try {
    // Threads（★ 修正：同時匹配 .net 和 .com）
    var threadsMatch = url.match(/threads\.(?:net|com)\/@([^\/\?]+)\/post\//i);
    if (threadsMatch) {
      hints.username = threadsMatch[1];
      hints.platform = 'Threads';
      hints.contentType = '貼文';
      hints.displayName = '@' + threadsMatch[1] + ' 的 Threads 貼文';
      return hints;
    }

    // Instagram
    var igPostMatch = url.match(/instagram\.com\/(?:p|reel)\/([^\/\?]+)/i);
    var igUserMatch = url.match(/instagram\.com\/([^\/\?]+)/i);
    if (igPostMatch) {
      hints.platform = 'Instagram';
      hints.contentType = url.includes('/reel/') ? 'Reel' : '貼文';
      if (igUserMatch && ['p', 'reel', 'stories', 'explore', 'accounts'].indexOf(igUserMatch[1]) === -1) {
        hints.username = igUserMatch[1];
      }
      hints.displayName = 'Instagram ' + hints.contentType;
      return hints;
    }

    // YouTube
    var ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&\?\/]+)/i);
    if (ytMatch) {
      hints.platform = 'YouTube';
      hints.contentType = url.includes('/shorts/') ? 'Short' : '影片';
      hints.displayName = 'YouTube ' + hints.contentType;
      return hints;
    }

    // TikTok
    var ttMatch = url.match(/tiktok\.com\/@([^\/\?]+)\/video\//i);
    if (ttMatch) {
      hints.username = ttMatch[1];
      hints.platform = 'TikTok';
      hints.contentType = '影片';
      hints.displayName = '@' + ttMatch[1] + ' 的 TikTok';
      return hints;
    }

    // Facebook
    if (url.includes('facebook.com') || url.includes('fb.com') || url.includes('fb.watch')) {
      hints.platform = 'Facebook';
      hints.contentType = '貼文';
      hints.displayName = 'Facebook 貼文';
      return hints;
    }

    // X / Twitter
    var xMatch = url.match(/(?:x\.com|twitter\.com)\/([^\/\?]+)\/status\//i);
    if (xMatch) {
      hints.username = xMatch[1];
      hints.platform = 'X';
      hints.contentType = '推文';
      hints.displayName = '@' + xMatch[1] + ' 的推文';
      return hints;
    }

  } catch (err) {
    Logger.log('extractURLHints error: ' + err.toString());
  }

  return hints;
}


// ── Google Drive 資料夾 ─────────────────────────────────
function getOrCreateFolder(folderName) {
  var folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(folderName);
}


// ── 初始化（第一次執行）─────────────────────────────────
function initialize() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    sheet.appendRow([
      '時間戳記', '類型', '標題', 'URL', '分類',
      '標籤', '摘要', 'OCR文字', '來源平台', '圖片URL'
    ]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 10).setFontWeight('bold');
  }

  // 建立安全日誌工作表
  var logSheet = ss.getSheetByName('安全日誌');
  if (!logSheet) {
    logSheet = ss.insertSheet('安全日誌');
    logSheet.appendRow(['時間', '事件類型', '詳情']);
    logSheet.setFrozenRows(1);
    logSheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  }

  getOrCreateFolder(CONFIG.DRIVE_FOLDER_NAME);

  // 提醒設定安全密鑰
  if (CONFIG.API_SECRET === '在這裡設定一組隨機密碼') {
    Logger.log('⚠️ 請修改 CONFIG.API_SECRET！建議用這組隨機密碼：' + generateRandomKey(32));
  }
  if (CONFIG.WEB_PASSWORD === '在這裡設定網頁登入密碼') {
    Logger.log('⚠️ 請修改 CONFIG.WEB_PASSWORD！');
  }

  Logger.log('✅ 初始化完成！');
}


// ── 生成隨機密鑰 ────────────────────────────────────────
function generateRandomKey(length) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var result = '';
  for (var i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}


// ── ★ 新增：測試函式 ───────────────────────────────────
// 在 Apps Script 上方選「testWithURL」→ 按 ▶️ 就能測試
// 結果看 Logger（查看 → 記錄）
function testWithURL() {
  var testUrls = [
    'https://www.threads.com/@nicodequkuairiji/post/DU2Ov5oCa_4?xmt=AQF0JS4af3JX2AKMtm0-7vLap6Uvcz9SeqFuL947AgTI1wzGAoHubka_qC9vO2gwzkGqNQk&slof=1',
    'https://www.instagram.com/p/DUzkiIHkTdl/?igsh=MWRiYjIxeHdoNDIycQ==',
    'https://www.instagram.com/reel/DUDQR4PDzgo/?igsh=MTdkOW01a2l0c242'
  ];

  // 測試 HTML entity 解碼
  var testEntity = '&#x4e0a;&#x7684;&#x6bb7;&#x742c;&#x5a77;&#xff08;&#064;qweee_yin&#xff09;';
  Logger.log('Entity 解碼測試: ' + decodeHtmlEntities(testEntity));

  for (var i = 0; i < testUrls.length; i++) {
    var testUrl = testUrls[i];

    Logger.log('=== 測試開始 ===');
    Logger.log('原始 URL: ' + testUrl);

    var cleaned = cleanURL(testUrl);
    Logger.log('清理後 URL: ' + cleaned);

    var platform = detectPlatform(testUrl);
    Logger.log('平台偵測: ' + platform);

  var hints = extractURLHints(testUrl);
  Logger.log('URL 線索: ' + JSON.stringify(hints));

  // Instagram JSON fallback 測試（抓 caption）
  if (platform === 'Instagram') {
    var igMeta = fetchInstagramMeta(cleaned);
    Logger.log('IG JSON success: ' + igMeta.success);
    Logger.log('IG JSON text: ' + igMeta.text);
    Logger.log('IG JSON image: ' + (igMeta.image ? igMeta.image.substring(0, 100) + '...' : '(none)'));
  }

  // 測試 fetch + parseMetaTags
    try {
      var response = UrlFetchApp.fetch(cleaned, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html',
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
        }
      });
      Logger.log('Fetch status: ' + response.getResponseCode());
      Logger.log('HTML length: ' + response.getContentText().length);

      var parsed = parseMetaTags(response.getContentText());
      Logger.log('Parsed text: ' + parsed.text);
      Logger.log('Parsed image: ' + (parsed.image ? parsed.image.substring(0, 100) + '...' : '(none)'));
    } catch (err) {
      Logger.log('Fetch error: ' + err.toString());
    }

    // 完整處理
    var result = processURL({
      url: testUrl,
      title: '',
      shareText: ''
    });

    Logger.log('=== 最終結果 ===');
    Logger.log('分類: ' + result.category);
    Logger.log('標籤: ' + result.tags);
    Logger.log('摘要: ' + result.summary);
    Logger.log('平台: ' + result.platform);
    Logger.log('標題: ' + result.title);
    Logger.log('圖片: ' + (result.imageUrl ? result.imageUrl.substring(0, 80) + '...' : '(none)'));

    saveToSheet(result);
    Logger.log('✅ 已寫入 Sheet');
  }
}
