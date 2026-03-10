const form = document.getElementById("analyze-form");
const submitButton = document.getElementById("submit-button");
const logoutButton = document.getElementById("logout-button");
const statusNode = document.getElementById("status");
const resultSection = document.getElementById("result");
const scoreLine = document.getElementById("score-line");
const metaLine = document.getElementById("meta-line");
const summaryText = document.getElementById("summary-text");
const highlightsList = document.getElementById("highlights-list");
const chaptersList = document.getElementById("chapters-list");
const transcriptText = document.getElementById("transcript-text");

function renderList(node, items, renderItem) {
  node.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("li");
    empty.textContent = "No data returned.";
    node.appendChild(empty);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.innerHTML = renderItem(item);
    node.appendChild(li);
  }
}

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  submitButton.disabled = true;
  statusNode.textContent = "分析中，AssemblyAI 轉錄可能需要幾分鐘。";
  resultSection.classList.add("hidden");

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }

    scoreLine.textContent = `Score ${data.estimated_value_score}/10 - ${data.recommendation}`;
    metaLine.textContent = `${data.audio_minutes} minutes • Transcript ID ${data.transcript_id}`;
    summaryText.textContent = data.assemblyai_summary || "No summary returned.";

    renderList(highlightsList, data.key_highlights || [], (item) => item);
    renderList(
      chaptersList,
      data.chapters || [],
      (item) => `<strong>${item.headline || "Untitled chapter"}</strong>: ${item.summary || ""}`
    );

    transcriptText.textContent = data.transcript || "No transcript returned.";
    resultSection.classList.remove("hidden");
    statusNode.textContent = "分析完成。";
  } catch (error) {
    statusNode.textContent = error instanceof Error ? error.message : "Unknown error";
  } finally {
    submitButton.disabled = false;
  }
});
