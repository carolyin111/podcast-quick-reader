const logoutButton = document.getElementById("logout-button");
const clearHistoryButton = document.getElementById("clear-history-button");
const historyStatus = document.getElementById("history-status");
const historyList = document.getElementById("history-list");

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

clearHistoryButton.addEventListener("click", async () => {
  const confirmed = window.confirm("要清空全部歷史紀錄嗎？這個動作不能復原。");
  if (!confirmed) {
    return;
  }

  clearHistoryButton.disabled = true;
  historyStatus.textContent = "清空中。";

  try {
    const response = await fetch("/api/history", { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }
    historyList.innerHTML = '<p class="meta">目前還沒有任何轉錄紀錄。</p>';
    historyStatus.textContent = "已清空全部紀錄。";
  } catch (error) {
    historyStatus.textContent = error instanceof Error ? error.message : "Unknown error";
  } finally {
    clearHistoryButton.disabled = false;
  }
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
        <div class="history-actions">
          <p class="meta">${escapeHtml(item.audio_minutes)} minutes</p>
          <button type="button" class="secondary-button danger-button" data-delete-id="${escapeHtml(item.id)}">刪除</button>
        </div>
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

historyList.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const entryId = target.dataset.deleteId;
  if (!entryId) {
    return;
  }

  const confirmed = window.confirm("要刪除這筆歷史紀錄嗎？");
  if (!confirmed) {
    return;
  }

  target.setAttribute("disabled", "true");
  historyStatus.textContent = "刪除中。";

  try {
    const response = await fetch(`/api/history/${encodeURIComponent(entryId)}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }
    await loadHistory();
    historyStatus.textContent = "已刪除紀錄。";
  } catch (error) {
    historyStatus.textContent = error instanceof Error ? error.message : "Unknown error";
    target.removeAttribute("disabled");
  }
});

loadHistory();
