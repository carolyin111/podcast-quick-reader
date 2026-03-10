const logoutButton = document.getElementById("logout-button");
const historyStatus = document.getElementById("history-status");
const historyList = document.getElementById("history-list");

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHistoryItem(item) {
  const highlights = (item.key_highlights || [])
    .slice(0, 4)
    .map((entry) => `<li>${escapeHtml(entry)}</li>`)
    .join("");
  const chapters = (item.chapters || [])
    .slice(0, 3)
    .map((entry) => `<li><strong>${escapeHtml(entry.headline || "Untitled chapter")}</strong>: ${escapeHtml(entry.summary || "")}</li>`)
    .join("");

  return `
    <article class="card history-card">
      <div class="history-header">
        <div>
          <p class="eyebrow">Saved ${new Date(item.created_at).toLocaleString("zh-TW")}</p>
          <h2>Score ${escapeHtml(item.estimated_value_score)}/10 - ${escapeHtml(item.recommendation)}</h2>
        </div>
        <p class="meta">${escapeHtml(item.audio_minutes)} minutes</p>
      </div>
      <p class="meta"><strong>Source:</strong> <a href="${escapeHtml(item.input_url)}" target="_blank" rel="noreferrer">${escapeHtml(item.input_url)}</a></p>
      <p class="meta"><strong>Goal:</strong> ${escapeHtml(item.interest_goal || "")}</p>
      <div class="prose">${escapeHtml(item.assemblyai_summary || "No summary returned.")}</div>
      <div class="history-columns">
        <section>
          <h3>Highlights</h3>
          <ul class="list">${highlights || "<li>No highlights returned.</li>"}</ul>
        </section>
        <section>
          <h3>Chapters</h3>
          <ul class="list">${chapters || "<li>No chapters returned.</li>"}</ul>
        </section>
      </div>
      <details>
        <summary>展開完整 transcript</summary>
        <pre class="transcript">${escapeHtml(item.transcript || "No transcript returned.")}</pre>
      </details>
    </article>
  `;
}

async function loadHistory() {
  historyStatus.textContent = "載入中。";

  try {
    const response = await fetch("/api/history");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }

    const items = data.items || [];
    if (!items.length) {
      historyList.innerHTML = '<p class="meta">目前還沒有任何轉錄紀錄。</p>';
      historyStatus.textContent = "";
      return;
    }

    historyList.innerHTML = items.map(renderHistoryItem).join("");
    historyStatus.textContent = `共 ${items.length} 筆紀錄。`;
  } catch (error) {
    historyStatus.textContent = error instanceof Error ? error.message : "Unknown error";
  }
}

loadHistory();
