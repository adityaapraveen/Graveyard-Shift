const $ = (selector) => document.querySelector(selector);
const state = { selectedId: null, proposal: null, timer: null, dryRun: true, active: false, mode: "mock" };
const notice = (message) => { $("#notice").textContent = message || ""; };
const node = (tag, text, className) => { const element = document.createElement(tag); if (text != null) element.textContent = text; if (className) element.className = className; return element; };

async function api(path, body) {
  const response = await fetch(path, body === undefined ? { credentials: "same-origin" } : {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  if (response.status === 401) { location.reload(); throw new Error("Session expired"); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function loadSuspects() {
  const data = await api("/api/suspects");
  state.dryRun = data.dryRun; state.mode = data.mode;
  $("#zone-label").textContent = `● ${data.mode.toUpperCase()} ZONE · ${data.zoneName}`;
  $("#mode-badge").textContent = data.dryRun ? "DRY RUN ON" : `${data.mode.toUpperCase()} CHANGES ON`;
  $("#overview").textContent = `${data.suspects.length} records ready for review`;
  const tbody = $("#suspects"); tbody.replaceChildren();
  if (!data.suspects.length) { const tr = node("tr"); const td = node("td", "No eligible suspects remain."); td.colSpan = 5; tr.append(td); tbody.append(tr); return; }
  for (const suspect of data.suspects) {
    const tr = node("tr");
    const recordCell = node("td"); recordCell.append(node("strong", suspect.record.name), node("small", `${suspect.record.type} · ${suspect.record.id}`));
    const targetCell = node("td", suspect.record.content, "target");
    const scoreCell = node("td"); scoreCell.append(node("span", String(suspect.score), "score"));
    const meter = node("div", null, "meter"); const bar = node("span"); bar.style.width = `${Math.min(100, suspect.score)}%`; meter.append(bar); scoreCell.append(meter);
    const evidenceCell = node("td", null, "evidence"); for (const signal of suspect.signals) evidenceCell.append(node("div", signal.evidence));
    const actionCell = node("td"); const action = node("button", "Review plan →", "row-action"); action.type = "button"; action.addEventListener("click", () => propose(suspect.record)); actionCell.append(action);
    tr.append(recordCell, targetCell, scoreCell, evidenceCell, actionCell); tbody.append(tr);
  }
}

async function loadGraveyard() {
  const data = await api("/api/graveyard");
  const gallery = $("#gallery"); gallery.replaceChildren();
  if (!data.obituaries.length) { gallery.append(node("div", "No obituaries yet. The graveyard is quiet.", "empty")); return; }
  for (const obituary of data.obituaries) {
    const card = node("article", null, "card");
    card.append(node("p", `${obituary.type} RECORD · ${new Date(obituary.died).toLocaleDateString()}`, "eyebrow"), node("h3", obituary.name), node("p", obituary.epitaph));
    const link = node("a", "Read obituary ↗"); link.href = `/obituary/${encodeURIComponent(obituary.recordId)}`; card.append(link); gallery.append(card);
  }
}

function timelineLine(text) { const step = node("div", null, "step"); step.append(node("span", text)); $("#timeline").append(step); }
async function showStatus() {
  if (!state.selectedId) return;
  try {
    const data = await api(`/api/quarantine/status/${encodeURIComponent(state.selectedId)}`);
    const timeline = $("#timeline"); timeline.replaceChildren();
    const q = data.quarantine; const biography = data.biography;
    timeline.append(node("strong", biography?.record?.name || state.selectedId));
    timelineLine("Snapshot saved");
    timelineLine(q.state === "quarantined" ? "Sinkhole active · listening for requests" : `State: ${q.state}`);
    if (q.state === "quarantined") {
      const seconds = Math.max(0, Math.ceil((Date.parse(biography?.quarantine?.deadlineAt) - Date.now()) / 1000));
      timelineLine(`${seconds}s remaining · ${biography?.hits?.filter((hit) => hit.counted && hit.workflowId === q.workflowId).length ?? 0} counted screams / ${biography?.quarantine?.threshold ?? 1} threshold`);
      $("#resurrect").classList.remove("hidden");
    } else {
      $("#resurrect").classList.add("hidden");
      if (q.state === "deleted") {
        if (biography?.obituary) { state.active = false; timelineLine("Deleted · obituary preserved"); await loadGraveyard(); }
        else timelineLine("Deleted · writing obituary…");
      }
      if (q.state === "resurrected") state.active = false;
      if (q.state === "resurrected") timelineLine("Restored from original snapshot");
      await loadSuspects();
    }
  } catch (error) { notice(error.message); }
}

async function propose(record) {
  notice(""); state.selectedId = record.id;
  try {
    const seconds = state.mode === "real" ? 3600 : 5;
    const proposal = await api("/api/quarantine/propose", { recordId: record.id, quarantineSeconds: seconds, screamThreshold: 1 });
    state.proposal = { ...proposal, recordId: record.id, quarantineSeconds: seconds, screamThreshold: 1 };
    $("#dialog-title").textContent = record.name;
    $("#dialog-plan").textContent = proposal.plan;
    const dl = $("#dialog-details"); dl.replaceChildren();
    for (const [label, value] of [["Record", `${record.type} ${record.name}`], ["Current target", record.content], ["Window", state.mode === "real" ? "1 hour" : "5 seconds"], ["Threshold", "1 unique human request"], ["Mode", state.dryRun ? "Dry run; no changes" : "Mock zone changes enabled"]]) dl.append(node("dt", label), node("dd", value));
    $("#confirm-dialog").showModal();
  } catch (error) { notice(error.message); }
}

$("#confirm-dialog").addEventListener("close", async () => {
  if ($("#confirm-dialog").returnValue !== "confirm" || !state.proposal) return;
  const plan = state.proposal; state.proposal = null;
  try {
    const result = await api("/api/quarantine/confirm", { recordId: plan.recordId, token: plan.token, quarantineSeconds: plan.quarantineSeconds, screamThreshold: plan.screamThreshold });
    if (result.dryRun) { notice("Dry run complete: the record and route were not changed. Enable mock changes locally to run the countdown."); return; }
    notice("Quarantine started. The timeline will update automatically.");
    state.active = true;
    await showStatus();
  } catch (error) { notice(error.message); }
});
$("#resurrect").addEventListener("click", async () => {
  if (!state.selectedId) return;
  try { await api("/api/quarantine/resurrect", { recordId: state.selectedId }); notice("Restoration requested. Waiting for the workflow to finish."); await showStatus(); }
  catch (error) { notice(error.message); }
});
$("#refresh").addEventListener("click", async () => { try { await Promise.all([loadSuspects(), loadGraveyard()]); notice(""); } catch (error) { notice(error.message); } });

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const input = $("#chat-message"); const message = input.value.trim(); if (!message) return;
  input.value = ""; const conversation = $("#conversation"); conversation.append(node("div", message, "bubble user")); const answer = node("div", "Thinking…", "bubble agent"); conversation.append(answer); conversation.scrollTop = conversation.scrollHeight;
  try {
    const response = await fetch("/api/chat", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, recordId: state.selectedId }) });
    if (!response.ok) { const body = await response.json(); throw new Error(body.error || "Chat failed"); }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; answer.textContent = "";
    while (true) {
      const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n"); buffer = parts.pop();
      for (const part of parts) { const data = part.split("\n").find((line) => line.startsWith("data: ")); if (data && part.includes("event: message")) answer.textContent += JSON.parse(data.slice(6)).text; }
      conversation.scrollTop = conversation.scrollHeight;
    }
  } catch (error) { answer.textContent = error.message; }
});

Promise.all([loadSuspects(), loadGraveyard(), api("/api/quarantines")]).then(async ([, , quarantines]) => {
  if (quarantines.active.length) { state.selectedId = quarantines.active[0].recordId; state.active = true; await showStatus(); }
}).catch((error) => notice(error.message));
state.timer = setInterval(() => { if (state.selectedId && state.active && !state.dryRun) showStatus(); }, 1000);
