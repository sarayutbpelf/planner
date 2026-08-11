/* =========================================================
   P-Roster — Executive Appointment Calendar (PWA)
   Vanilla JS, localStorage-backed, JPEG export via html2canvas
   ========================================================= */
(() => {
  "use strict";

  const STORAGE_KEY = "execcal_data_v1";
  const GAS_URL_KEY = "execcal_gas_url";
  const GAS_DISCONNECTED_KEY = "execcal_gas_disconnected";
  const LAST_SYNC_KEY = "execcal_last_sync";
  const DEFAULT_GAS_URL = "https://script.google.com/macros/s/AKfycbzFVqSFyFGe0KXfFMNHGoroYFPGX_XNwTJfEd6GfOmAo92qQ7COBGxKrhgI26jw6wHyMg/exec";
  const COLOR_ORDER = ["pink", "teal", "lavender", "peach", "ochre", "cream"];
  const DOW_SHORT = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
  const DOW_FULL = ["วันอาทิตย์", "วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์"];
  const MONTH_FULL = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
  const MONTH_SHORT = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

  /* ---------- state ---------- */
  let state = loadState();
  let view = "week";              // 'week' | 'month'
  let anchor = startOfDay(new Date()); // reference date for current period
  let activeFilters = null;       // Set of exec ids, null = all
  let deferredInstallPrompt = null;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.holidays)) parsed.holidays = [];
        return parsed;
      }
    } catch (e) { console.warn("Failed to load state", e); }
    return { executives: [], appointments: [], holidays: [] };
  }
  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function fmtISO(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function parseISO(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }
  function startOfWeek(d) { // Sunday
    const x = startOfDay(d);
    x.setDate(x.getDate() - x.getDay());
    return x;
  }
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function isSameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function toMinutes(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }

  function colorClass(key) { return "c-" + key; }
  function nextColor() {
    return COLOR_ORDER[state.executives.length % COLOR_ORDER.length];
  }
  function execById(id) { return state.executives.find(e => e.id === id); }
  function personKeyOf(ex) { return (ex && ex.personName && ex.personName.trim()) ? ex.personName.trim().toLowerCase() : (ex ? ex.name.trim().toLowerCase() : ""); }
  function personGroupExecIds(execId) {
    const ex = execById(execId);
    if (!ex) return new Set([execId]);
    const key = personKeyOf(ex);
    return new Set(state.executives.filter(e => personKeyOf(e) === key).map(e => e.id));
  }
  function personDisplayName(execId) {
    const ex = execById(execId);
    if (!ex) return "—";
    return (ex.personName && ex.personName.trim()) ? ex.personName.trim() : ex.name;
  }
  // Find a CONFIRMED appointment under a DIFFERENT position but the SAME real person
  // that overlaps [start,end) on `date`. Returns null if none.
  // Find another appointment (any of the given statuses, default confirmed+pending) that
  // overlaps [start,end) on `date` for the SAME PERSON — covers both "same position double-booked"
  // and "different position of the same person" in one check, since the person's own group
  // always includes their own execId.
  function findOverlap(execId, date, start, end, excludeApptId, statuses) {
    statuses = statuses || ["confirmed", "pending"];
    const group = personGroupExecIds(execId);
    return state.appointments.find(a =>
      a.id !== excludeApptId &&
      statuses.includes(a.status) &&
      group.has(a.execId) &&
      a.date === date &&
      toMinutes(a.start) < toMinutes(end) && toMinutes(a.end) > toMinutes(start)
    ) || null;
  }
  // Backward-compatible alias used by the appointment-form conflict check (confirmed-only, blocking).
  function findCrossPositionConflict(execId, date, start, end, excludeApptId) {
    return findOverlap(execId, date, start, end, excludeApptId, ["confirmed"]);
  }
  // Any OTHER pending request overlapping the same time — used to flag "competing requests" to the admin.
  function findPendingConflict(execId, date, start, end, excludeApptId) {
    return findOverlap(execId, date, start, end, excludeApptId, ["pending"]);
  }
  function apptsForDate(dateISO) {
    return state.appointments
      .filter(a => a.date === dateISO && a.status !== "declined" && isExecVisible(a.execId))
      .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  }
  function isExecVisible(execId) {
    if (activeFilters === null) return true;
    return activeFilters.has(execId);
  }
  function holidayFor(dateISO) {
    const custom = state.holidays.find(h => h.date === dateISO);
    if (custom) return custom;
    const dow = parseISO(dateISO).getDay();
    if (dow === 0 || dow === 6) return { date: dateISO, label: "วันหยุดราชการ" };
    return null;
  }
  function pendingCount() { return state.appointments.filter(a => a.status === "pending").length; }

  /* ============================================================
     Google Sheets sync (via Google Apps Script Web App bridge)
     ============================================================ */
  let syncInFlight = false;

  function getSheetUrl() {
    if (localStorage.getItem(GAS_DISCONNECTED_KEY) === "1") return "";
    return (localStorage.getItem(GAS_URL_KEY) || DEFAULT_GAS_URL).trim();
  }
  function setSheetUrl(url) {
    localStorage.setItem(GAS_URL_KEY, url.trim());
    localStorage.removeItem(GAS_DISCONNECTED_KEY);
  }
  function clearSheetUrl() {
    localStorage.removeItem(GAS_URL_KEY);
    localStorage.removeItem(LAST_SYNC_KEY);
    localStorage.setItem(GAS_DISCONNECTED_KEY, "1");
  }
  function getLastSync() { return localStorage.getItem(LAST_SYNC_KEY); }
  function setLastSync() { localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString()); }

  function normalizeColor(c) {
    const k = String(c || "").trim().toLowerCase();
    return COLOR_ORDER.includes(k) ? k : null;
  }

  // Convert the flat {executives, appointments(execName)} shape returned by
  // the Apps Script bridge into this app's internal {executives, appointments(execId)} shape.
  function applyRemoteData(data) {
    if (!data || !Array.isArray(data.executives) || !Array.isArray(data.appointments)) return false;
    const executives = data.executives.map((e, i) => ({
      id: String(e.id),
      name: String(e.name || "").trim(),
      personName: String(e.person || e.personName || "").trim(),
      colorKey: normalizeColor(e.color) || COLOR_ORDER[i % COLOR_ORDER.length],
    })).filter(e => e.name);

    const nameToId = new Map(executives.map(e => [e.name.toLowerCase(), e.id]));
    const appointments = data.appointments.map(a => ({
      id: String(a.id),
      execId: nameToId.get(String(a.execName || "").trim().toLowerCase()) || null,
      title: String(a.title || "").trim(),
      date: String(a.date || "").trim(),
      start: String(a.start || "").trim(),
      end: String(a.end || "").trim(),
      location: String(a.location || "").trim(),
      notes: String(a.notes || "").trim(),
      status: (() => {
        const s = String(a.status || "").trim().toLowerCase();
        return (s === "pending" || s === "declined") ? s : "confirmed";
      })(),
      requestedBy: String(a.requestedBy || "").trim(),
      requestedContact: String(a.requestedContact || "").trim(),
      requestNote: String(a.requestNote || "").trim(),
    })).filter(a => a.execId && a.date && a.title && a.start && a.end);

    const holidays = Array.isArray(data.holidays)
      ? data.holidays.map(h => ({ date: String(h.date || "").trim(), label: String(h.label || "วันหยุดราชการ").trim() })).filter(h => h.date)
      : [];

    state = { executives, appointments, holidays };
    if (activeFilters) activeFilters = null;
    saveState();
    setLastSync();
    checkForNewPendingRequests();
    return true;
  }

  /* ---------- pending-approval notification ---------- */
  let lastKnownPendingCount = null; // null = not yet established a baseline
  function checkForNewPendingRequests() {
    const n = pendingCount();
    if (lastKnownPendingCount !== null && n > lastKnownPendingCount) {
      const added = n - lastKnownPendingCount;
      // Does any pending item right now have a scheduling conflict that needs a decision?
      const hasConflict = state.appointments.some(a =>
        a.status === "pending" && findOverlap(a.execId, a.date, a.start, a.end, a.id, ["confirmed", "pending"])
      );
      const conflictNote = hasConflict ? " ⚠️ มีเวลาซ้อนทับ ต้องพิจารณา" : "";
      toast(`🔔 มีคำขอนัดหมายใหม่รออนุมัติ ${added} รายการ${conflictNote}`);
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification("P-Roster — มีคำขอนัดหมายใหม่", {
            body: `มีคำขอนัดหมายรออนุมัติเพิ่มขึ้น ${added} รายการ (รวม ${n} รายการ)${hasConflict ? " — บางรายการเวลาซ้อนทับ ต้องพิจารณาก่อนอนุมัติ" : ""}`,
            icon: "icons/icon-192.png",
          });
        } catch (e) { /* Notification constructor can fail on some mobile browsers; toast already shown */ }
      }
    }
    lastKnownPendingCount = n;
  }

  async function pullFromSheet(opts) {
    const { silent = false } = opts || {};
    const url = getSheetUrl();
    if (!url) return false;
    if (syncInFlight) return false;
    syncInFlight = true;
    updateSyncStatus("syncing");
    try {
      const res = await fetch(url, { method: "GET" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "sync failed");
      applyRemoteData(data);
      renderAll();
      updateSyncStatus("ok");
      if (!silent) toast("ซิงก์ข้อมูลจาก Google Sheet แล้ว");
      return true;
    } catch (err) {
      console.warn("pullFromSheet failed", err);
      updateSyncStatus("error");
      if (!silent) toast("ซิงก์ไม่สำเร็จ ตรวจสอบลิงก์หรืออินเทอร์เน็ต");
      return false;
    } finally {
      syncInFlight = false;
    }
  }

  // action: 'upsertExecutive' | 'deleteExecutive' | 'upsertAppointment' | 'deleteAppointment'
  async function pushToSheet(action, payload) {
    const url = getSheetUrl();
    if (!url) return false;
    updateSyncStatus("syncing");
    try {
      // Content-Type: text/plain avoids a CORS preflight that Apps Script web apps can't answer.
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, payload }),
      });
      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        // Apps Script returned something that isn't JSON — almost always means the
        // deployment itself is broken/misconfigured (e.g. an HTML error/login page
        // came back instead), not a normal application error.
        throw new Error("เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (ไม่ใช่ JSON) — ตรวจสอบว่า deploy Apps Script ล่าสุดแล้วและตั้งค่า 'Who has access: Anyone'");
      }
      if (!data.ok) throw new Error(data.error || "push failed");
      applyRemoteData(data);
      renderAll();
      updateSyncStatus("ok");
      return true;
    } catch (err) {
      console.warn("pushToSheet failed", err);
      updateSyncStatus("error");
      toast(`⚠️ บันทึกขึ้น Google Sheet ไม่สำเร็จ: ${err.message || err}`, 6000);
      return false;
    }
  }

  function updateSyncStatus(status) {
    const els = [document.getElementById("sheetSyncStatus"), document.getElementById("sheetSyncStatus2")].filter(Boolean);
    if (!els.length) return;
    const url = getSheetUrl();
    let text, color;
    if (!url) { text = "ยังไม่เชื่อมต่อ Google Sheet"; color = "var(--muted)"; }
    else if (status === "syncing") { text = "กำลังซิงก์…"; color = "var(--muted)"; }
    else if (status === "error") { text = "เชื่อมต่อแล้ว · ซิงก์ล่าสุดล้มเหลว"; color = "var(--warning)"; }
    else {
      const last = getLastSync();
      const timeStr = last ? new Date(last).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) : "—";
      text = `เชื่อมต่อแล้ว · ซิงก์ล่าสุด ${timeStr} น.`;
      color = "var(--success)";
    }
    els.forEach(el => { el.textContent = text; el.style.color = color; });
  }

  /* ---------- DOM refs ---------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const periodLabel = $("#periodLabel");
  const execFilterEl = $("#execFilter");
  const weekDayList = $("#weekDayList");
  const weekGrid = $("#weekGrid");
  const monthGrid = $("#monthGrid");
  const globalEmpty = $("#globalEmpty");
  const toastEl = $("#toast");

  /* ---------- toast ---------- */
  let toastTimer = null;
  function toast(msg, durationMs) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), durationMs || 2200);
  }

  /* ---------- overlay helpers ---------- */
  function openSheet(id) { $("#" + id).classList.add("show"); document.body.style.overflow = "hidden"; }
  function closeSheet(id) { $("#" + id).classList.remove("show"); document.body.style.overflow = ""; }
  $$(".overlay").forEach(ov => {
    ov.addEventListener("click", (e) => { if (e.target === ov) closeSheet(ov.id); });
  });
  $$("[data-close]").forEach(btn => btn.addEventListener("click", () => closeSheet(btn.dataset.close)));

  /* ============================================================
     RENDER: Executive filter chips
     ============================================================ */
  function renderExecFilter() {
    execFilterEl.innerHTML = "";
    if (state.executives.length === 0) {
      globalEmpty.style.display = "block";
    } else {
      globalEmpty.style.display = "none";
    }
    state.executives.forEach(ex => {
      const chip = document.createElement("button");
      chip.className = "category-tab" + (isExecVisible(ex.id) ? " active" : "");
      chip.innerHTML = `<span class="dot" style="background:var(--brand-${ex.colorKey === 'cream' ? 'ochre' : ex.colorKey})"></span>${escapeHtml(ex.name)}`;
      if (ex.colorKey === "cream") chip.querySelector(".dot").style.background = "var(--surface-strong)";
      chip.addEventListener("click", () => {
        if (activeFilters === null) activeFilters = new Set(state.executives.map(e => e.id));
        if (activeFilters.has(ex.id)) activeFilters.delete(ex.id); else activeFilters.add(ex.id);
        if (activeFilters.size === state.executives.length) activeFilters = null;
        renderAll();
      });
      execFilterEl.appendChild(chip);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ============================================================
     RENDER: period label
     ============================================================ */
  function renderPeriodLabel() {
    if (view === "week") {
      const start = startOfWeek(anchor);
      const end = addDays(start, 6);
      if (start.getMonth() === end.getMonth()) {
        periodLabel.textContent = `${start.getDate()}–${end.getDate()} ${MONTH_FULL[start.getMonth()]} ${start.getFullYear() + 543}`;
      } else {
        periodLabel.textContent = `${start.getDate()} ${MONTH_SHORT[start.getMonth()]} – ${end.getDate()} ${MONTH_SHORT[end.getMonth()]} ${end.getFullYear() + 543}`;
      }
    } else {
      periodLabel.textContent = `${MONTH_FULL[anchor.getMonth()]} ${anchor.getFullYear() + 543}`;
    }
  }

  /* ============================================================
     RENDER: appointment card markup
     ============================================================ */
  function apptCardHTML(a, compact) {
    const ex = execById(a.execId);
    const cls = colorClass(ex ? ex.colorKey : "cream");
    const pending = a.status === "pending";
    // Confirmed items only ever conflict with another confirmed item (shouldn't normally
    // happen — server blocks it — but flag it if it somehow does, e.g. edited directly in the Sheet).
    // Pending items are checked against BOTH confirmed and other pending items, since two people
    // can each request the same slot before either is approved.
    const conflict = findOverlap(a.execId, a.date, a.start, a.end, a.id, pending ? ["confirmed", "pending"] : ["confirmed"]);
    return `<div class="appt-card ${cls} ${pending ? "pending" : ""}" data-appt-id="${a.id}">
        ${pending ? `<span class="appt-pending-badge">รออนุมัติ</span>` : ""}
        ${conflict ? `<span class="appt-pending-badge" style="background:var(--error); color:#fff;" title="เวลาซ้อนทับกับนัดหมายอื่น ต้องพิจารณา">⚠️ เวลาซ้อนทับ</span>` : ""}
        <span class="appt-time">${a.start}–${a.end}</span>
        <span class="appt-title">${escapeHtml(a.title)}</span>
        <span class="appt-meta">
          ${state.executives.length > 1 ? `<span class="appt-exec">${escapeHtml(ex ? ex.name : "—")}</span>` : ""}
          ${a.location ? `<span>📍 ${escapeHtml(a.location)}</span>` : ""}
          ${pending && a.requestedBy ? `<span>👤 ${escapeHtml(a.requestedBy)}</span>` : ""}
        </span>
      </div>`;
  }

  function bindApptCardClicks(root) {
    root.querySelectorAll("[data-appt-id]").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        openApptSheet(el.dataset.apptId);
      });
    });
  }

  /* ============================================================
     RENDER: Week view (mobile list + desktop grid)
     ============================================================ */
  function renderWeek() {
    const start = startOfWeek(anchor);
    const today = startOfDay(new Date());
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

    // Mobile list
    weekDayList.innerHTML = days.map(d => {
      const iso = fmtISO(d);
      const items = apptsForDate(iso);
      const isToday = isSameDay(d, today);
      return `<div class="day-card">
        <div class="day-card-header ${isToday ? "today" : ""}">
          <div>
            <span class="dow">${DOW_FULL[d.getDay()]}</span>
          </div>
          <span class="dom">${d.getDate()} ${MONTH_SHORT[d.getMonth()]}</span>
        </div>
        <div class="day-card-body" data-date="${iso}">
          ${items.length ? items.map(a => apptCardHTML(a)).join("") : `<div class="day-empty">ไม่มีนัดหมาย</div>`}
        </div>
      </div>`;
    }).join("");
    bindApptCardClicks(weekDayList);
    weekDayList.querySelectorAll(".day-card-body").forEach(el => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-appt-id]")) return;
        quickAddForDate(el.dataset.date);
      });
    });

    // Desktop grid
    let gridHTML = `<div class="corner"></div>`;
    days.forEach(d => {
      const isToday = isSameDay(d, today);
      gridHTML += `<div class="wk-dow ${isToday ? "today" : ""}">
        <span class="dow">${DOW_SHORT[d.getDay()]}</span>
        <span class="dom">${d.getDate()}</span>
      </div>`;
    });
    gridHTML += `<div class="hour-label"></div>`;
    days.forEach(d => {
      const iso = fmtISO(d);
      const items = apptsForDate(iso);
      gridHTML += `<div class="day-col" data-date="${iso}">${items.map(a => apptCardHTML(a)).join("")}</div>`;
    });
    weekGrid.innerHTML = gridHTML;
    bindApptCardClicks(weekGrid);
    weekGrid.querySelectorAll(".day-col").forEach(el => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-appt-id]")) return;
        quickAddForDate(el.dataset.date);
      });
    });
  }

  /* ============================================================
     RENDER: Month view
     ============================================================ */
  function renderMonth() {
    const first = startOfMonth(anchor);
    const gridStart = startOfWeek(first);
    const today = startOfDay(new Date());
    const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

    let html = DOW_SHORT.map(d => `<div class="month-dow">${d}</div>`).join("");
    cells.forEach(d => {
      const iso = fmtISO(d);
      const items = apptsForDate(iso);
      const otherMonth = d.getMonth() !== anchor.getMonth();
      const isToday = isSameDay(d, today);
      const dots = items.slice(0, 4).map(a => {
        const ex = execById(a.execId);
        const key = ex ? ex.colorKey : "cream";
        const varColor = key === "cream" ? "var(--surface-strong)" : `var(--brand-${key})`;
        return `<span class="month-dot" style="background:${varColor}"></span>`;
      }).join("");
      const more = items.length > 4 ? `<span class="month-more">+${items.length - 4}</span>` : "";
      html += `<div class="month-cell ${otherMonth ? "other-month" : ""} ${isToday ? "today" : ""}" data-date="${iso}">
        <span class="month-date">${d.getDate()}</span>
        <div class="month-dots">${dots}${more}</div>
      </div>`;
    });
    monthGrid.innerHTML = html;
    monthGrid.querySelectorAll(".month-cell").forEach(el => {
      el.addEventListener("click", () => openDaySheet(el.dataset.date));
    });
  }

  /* ============================================================
     Master render
     ============================================================ */
  function renderAll() {
    renderPeriodLabel();
    renderExecFilter();
    renderPendingBadge();
    if (view === "week") {
      weekDayList.style.display = "";
      weekGrid.style.display = "";
      monthGrid.style.display = "none";
      renderWeek();
    } else {
      weekDayList.style.display = "none";
      weekGrid.style.display = "none";
      monthGrid.style.display = "grid";
      renderMonth();
    }
    saveState();
  }

  /* ============================================================
     View switch / navigation
     ============================================================ */
  $$(".view-switch button").forEach(btn => {
    btn.addEventListener("click", () => {
      view = btn.dataset.view;
      $$(".view-switch button").forEach(b => { b.classList.toggle("active", b === btn); b.setAttribute("aria-selected", b === btn); });
      renderAll();
    });
  });
  $("#btnPrev").addEventListener("click", () => {
    anchor = view === "week" ? addDays(anchor, -7) : new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
    renderAll();
  });
  $("#btnNext").addEventListener("click", () => {
    anchor = view === "week" ? addDays(anchor, 7) : new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    renderAll();
  });
  $("#btnToday").addEventListener("click", () => { anchor = startOfDay(new Date()); renderAll(); });

  /* ============================================================
     Appointment sheet (add / edit)
     ============================================================ */
  const apptForm = $("#apptForm");
  const apptExecSelect = $("#apptExec");

  function refreshExecSelect() {
    apptExecSelect.innerHTML = state.executives.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join("");
  }

  function openApptSheet(apptId, presetDate) {
    if (state.executives.length === 0) {
      toast("กรุณาเพิ่มผู้บริหารก่อน");
      openExecSheet();
      return;
    }
    refreshExecSelect();
    apptForm.reset();
    $("#apptConflictWarning").style.display = "none";
    $("#apptRequestInfo").style.display = "none";
    $("#apptApprovalActions").style.display = "none";
    if (apptId) {
      const a = state.appointments.find(x => x.id === apptId);
      if (!a) return;
      $("#apptSheetTitle").textContent = a.status === "pending" ? "คำขอนัดหมาย (รออนุมัติ)" : "แก้ไขนัดหมาย";
      $("#apptId").value = a.id;
      apptExecSelect.value = a.execId;
      $("#apptTitle").value = a.title;
      $("#apptDate").value = a.date;
      $("#apptStart").value = a.start;
      $("#apptEnd").value = a.end;
      $("#apptLocation").value = a.location || "";
      $("#apptNotes").value = a.notes || "";
      $("#btnApptDelete").style.display = "";
      if (a.status === "pending") {
        $("#btnApptDelete").style.display = "none";
        $("#apptApprovalActions").style.display = "flex";
        if (a.requestedBy || a.requestedContact || a.requestNote) {
          $("#apptRequestInfo").style.display = "block";
          $("#apptRequestInfo").innerHTML = `<strong>คำขอโดย:</strong> ${escapeHtml(a.requestedBy || "ไม่ระบุชื่อ")}` +
            (a.requestedContact ? `<br><strong>ติดต่อ:</strong> ${escapeHtml(a.requestedContact)}` : "") +
            (a.requestNote ? `<br><strong>หมายเหตุจากผู้ขอ:</strong> ${escapeHtml(a.requestNote)}` : "");
        }
      }
    } else {
      $("#apptSheetTitle").textContent = "เพิ่มนัดหมาย";
      $("#apptId").value = "";
      $("#apptDate").value = presetDate || fmtISO(view === "week" ? anchor : new Date());
      $("#apptStart").value = "09:00";
      $("#apptEnd").value = "10:00";
      $("#btnApptDelete").style.display = "none";
    }
    openSheet("apptOverlay");
  }

  function quickAddForDate(dateISO) { openApptSheet(null, dateISO); }

  $("#btnApptApprove").addEventListener("click", async () => {
    const id = $("#apptId").value;
    if (!id) return;
    closeSheet("apptOverlay");
    approveAppointmentFlow(id);
  });
  $("#btnApptDecline").addEventListener("click", async () => {
    const id = $("#apptId").value;
    if (!id) return;
    if (!confirm("ปฏิเสธคำขอนัดหมายนี้หรือไม่?")) return;
    const local = state.appointments.find(a => a.id === id);
    if (local) local.status = "declined";
    saveState();
    closeSheet("apptOverlay");
    renderAll();
    toast("ปฏิเสธคำขอนัดหมายแล้ว");
    pushToSheet("declineAppointment", { id });
  });

  /* ============================================================
     Conflict override popup — shared by admin approvals AND
     (via the same overlay markup pattern) referenced from booking.js's
     own copy for the public request flow.
     ============================================================ */
  let conflictConfirmCallback = null;
  function showConflictConfirm(message, onConfirm) {
    $("#conflictConfirmMessage").textContent = message;
    conflictConfirmCallback = onConfirm;
    openSheet("conflictConfirmOverlay");
  }
  $("#btnConflictCancel").addEventListener("click", () => {
    closeSheet("conflictConfirmOverlay");
    conflictConfirmCallback = null;
  });
  $("#btnConflictConfirm").addEventListener("click", () => {
    closeSheet("conflictConfirmOverlay");
    const cb = conflictConfirmCallback;
    conflictConfirmCallback = null;
    if (cb) cb();
  });

  function conflictMessage(conflictDetail) {
    const d = conflictDetail;
    return `เวลานี้ซ้อนทับกับนัดหมายที่ยืนยันแล้ว:\n"${d.title}" (${d.execName})\nเวลา ${d.start}–${d.end}\n\nนัดหมายทั้งสองรายการจะเกิดขึ้นในเวลาเดียวกัน — ต้องการยืนยันนัดหมายนี้ต่อหรือไม่?`;
  }

  // Attempts an approval; on a conflict response, shows the popup and — if the
  // admin confirms — retries the same call with force:true to override it.
  async function approveAppointmentFlow(id) {
    const result = await attemptApproveRequest(id, false);
    if (result.ok) return;
    if (result.conflict && result.conflictDetail) {
      showConflictConfirm(conflictMessage(result.conflictDetail), async () => {
        await attemptApproveRequest(id, true);
      });
    } else {
      toast(`⚠️ ${result.error || "ไม่สามารถอนุมัติได้"}`, 6000);
    }
  }

  async function attemptApproveRequest(id, force) {
    const url = getSheetUrl();
    if (!url) { toast("ยังไม่ได้เชื่อมต่อ Google Sheet"); return { ok: false }; }
    updateSyncStatus("syncing");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "approveAppointment", payload: { id, force: !!force } }),
      });
      let data;
      try { data = await res.json(); }
      catch (e) { throw new Error("เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (ไม่ใช่ JSON) — ตรวจสอบว่า deploy Apps Script ล่าสุดแล้ว"); }
      if (data.ok) {
        applyRemoteData(data);
        renderAll();
        renderPendingList();
        renderPendingBadge();
        updateSyncStatus("ok");
        toast(force ? "ยืนยันนัดหมาย (ซ้อนทับ) แล้ว" : "อนุมัตินัดหมายแล้ว");
        return { ok: true };
      }
      updateSyncStatus("error");
      return { ok: false, error: data.error, conflict: !!data.conflict, conflictDetail: data.conflictDetail };
    } catch (err) {
      console.warn("approve failed", err);
      updateSyncStatus("error");
      return { ok: false, error: err.message || String(err) };
    }
  }


  apptForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = $("#apptId").value || uid();
    const existing = state.appointments.find(a => a.id === id);
    const data = {
      id,
      execId: apptExecSelect.value,
      title: $("#apptTitle").value.trim(),
      date: $("#apptDate").value,
      start: $("#apptStart").value,
      end: $("#apptEnd").value,
      location: $("#apptLocation").value.trim(),
      notes: $("#apptNotes").value.trim(),
      status: "confirmed", // admin-entered appointments are always confirmed
      requestedBy: existing ? existing.requestedBy || "" : "",
      requestedContact: existing ? existing.requestedContact || "" : "",
      requestNote: existing ? existing.requestNote || "" : "",
    };
    if (toMinutes(data.end) <= toMinutes(data.start)) {
      toast("เวลาสิ้นสุดต้องหลังเวลาเริ่ม");
      return;
    }
    // Conflict check covers every OTHER position held by the same real person
    // (via personGroupExecIds/findCrossPositionConflict), not just this exact
    // position — since the same human can't be in two places regardless of
    // which title they're wearing. Require explicit re-confirmation via a
    // popup before saving over a conflict rather than saving silently.
    const conflict = findCrossPositionConflict(data.execId, data.date, data.start, data.end, id);
    if (conflict) {
      const conflictExec = execById(conflict.execId);
      const samePosition = conflictExec && conflictExec.id === data.execId;
      const who = personDisplayName(data.execId);
      const msg = samePosition
        ? `เวลานี้ซ้อนทับกับนัดหมายที่มีอยู่แล้ว:\n"${conflict.title}"\nเวลา ${conflict.start}–${conflict.end}\n\nต้องการบันทึกนัดหมายนี้ต่อหรือไม่?`
        : `${who} ติดภารกิจ "${conflict.title}" ในตำแหน่ง "${conflictExec ? conflictExec.name : "—"}" ช่วง ${conflict.start}–${conflict.end} อยู่แล้ว\n\nนัดหมายทั้งสองรายการจะเกิดขึ้นในเวลาเดียวกัน — ต้องการบันทึกนัดหมายนี้ต่อหรือไม่?`;
      showConflictConfirm(msg, () => saveAppointmentNow(data, id));
      return;
    }
    saveAppointmentNow(data, id);
  });

  function saveAppointmentNow(data, id) {
    const existingIdx = state.appointments.findIndex(a => a.id === id);
    if (existingIdx >= 0) state.appointments[existingIdx] = data;
    else state.appointments.push(data);
    saveState();
    closeSheet("apptOverlay");
    anchor = parseISO(data.date);
    renderAll();
    toast("บันทึกนัดหมายแล้ว");

    const ex = execById(data.execId);
    if (ex) pushToSheet("upsertAppointment", { id: data.id, execName: ex.name, date: data.date, start: data.start, end: data.end, title: data.title, location: data.location, notes: data.notes, requestedBy: data.requestedBy, requestedContact: data.requestedContact, requestNote: data.requestNote });
  }

  // live conflict check (only against CONFIRMED appointments — pending requests don't block)
  ["apptExec", "apptDate", "apptStart", "apptEnd"].forEach(id => {
    $("#" + id).addEventListener("change", checkConflict);
  });
  function checkConflict() {
    const execId = apptExecSelect.value;
    const date = $("#apptDate").value;
    const start = $("#apptStart").value;
    const end = $("#apptEnd").value;
    const curId = $("#apptId").value;
    const warnEl = $("#apptConflictWarning");
    if (!execId || !date || !start || !end) { warnEl.style.display = "none"; return; }
    const conflict = findCrossPositionConflict(execId, date, start, end, curId);
    if (conflict) {
      const conflictExec = execById(conflict.execId);
      const samePosition = conflictExec && conflictExec.id === execId;
      const who = personDisplayName(execId);
      warnEl.textContent = samePosition
        ? `⚠️ เวลาซ้อนทับกับ "${conflict.title}" (${conflict.start}–${conflict.end})`
        : `⚠️ ${who} ติดภารกิจ "${conflict.title}" ในตำแหน่ง "${conflictExec ? conflictExec.name : "—"}" ช่วง ${conflict.start}–${conflict.end} อยู่แล้ว`;
      warnEl.style.display = "block";
    } else {
      warnEl.style.display = "none";
    }
  }

  $("#btnApptDelete").addEventListener("click", () => {
    const id = $("#apptId").value;
    if (!id) return;
    if (!confirm("ลบนัดหมายนี้หรือไม่?")) return;
    state.appointments = state.appointments.filter(a => a.id !== id);
    saveState();
    closeSheet("apptOverlay");
    renderAll();
    toast("ลบนัดหมายแล้ว");
    pushToSheet("deleteAppointment", { id });
  });

  $("#btnFab").addEventListener("click", () => openApptSheet(null));

  /* ============================================================
     Executives sheet
     ============================================================ */
  const execForm = $("#execForm");
  const execColorPicker = $("#execColorPicker");
  let pickedColor = null;

  function renderColorPicker(selected) {
    execColorPicker.innerHTML = "";
    COLOR_ORDER.forEach(key => {
      const sw = document.createElement("div");
      sw.className = "color-swatch" + (key === selected ? " selected" : "");
      sw.style.background = key === "cream" ? "var(--surface-strong)" : `var(--brand-${key})`;
      sw.dataset.key = key;
      sw.addEventListener("click", () => {
        pickedColor = key;
        renderColorPicker(key);
      });
      execColorPicker.appendChild(sw);
    });
  }

  function renderExecList() {
    const listEl = $("#execList");
    if (state.executives.length === 0) {
      listEl.innerHTML = `<p class="body-sm">ยังไม่มีผู้บริหารในระบบ เพิ่มรายชื่อด้านล่าง</p>`;
      return;
    }
    // Group positions sharing the same real person, purely for a helpful subtitle.
    listEl.innerHTML = state.executives.map(ex => {
      const count = state.appointments.filter(a => a.execId === ex.id).length;
      const groupSize = personGroupExecIds(ex.id).size;
      return `<div class="exec-row" data-id="${ex.id}" style="align-items:flex-start;">
        <span class="dot" style="background:${ex.colorKey === "cream" ? "var(--surface-strong)" : `var(--brand-${ex.colorKey})`}; margin-top:4px;"></span>
        <span class="exec-name">
          ${escapeHtml(ex.name)}
          ${ex.personName ? `<br><span class="caption" style="color:var(--muted); font-weight:400;">👤 ${escapeHtml(ex.personName)}${groupSize > 1 ? ` · รวม ${groupSize} ตำแหน่ง` : ""}</span>` : ""}
        </span>
        <span class="badge-pill">${count} นัดหมาย</span>
        <button data-action="edit" aria-label="แก้ไข">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button data-action="delete" aria-label="ลบ">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>`;
    }).join("");
    listEl.querySelectorAll("[data-action='edit']").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.closest(".exec-row").dataset.id;
        const ex = execById(id);
        $("#execId").value = ex.id;
        $("#execName").value = ex.name;
        $("#execPerson").value = ex.personName || "";
        pickedColor = ex.colorKey;
        renderColorPicker(ex.colorKey);
        $("#btnExecSubmit").textContent = "บันทึกการแก้ไข";
      });
    });
    listEl.querySelectorAll("[data-action='delete']").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.closest(".exec-row").dataset.id;
        const ex = execById(id);
        const count = state.appointments.filter(a => a.execId === id).length;
        const msg = count > 0 ? `ลบ "${ex.name}" และนัดหมาย ${count} รายการที่เกี่ยวข้องหรือไม่?` : `ลบ "${ex.name}" หรือไม่?`;
        if (!confirm(msg)) return;
        state.executives = state.executives.filter(e => e.id !== id);
        state.appointments = state.appointments.filter(a => a.execId !== id);
        if (activeFilters) activeFilters.delete(id);
        saveState();
        renderExecList();
        renderAll();
        toast("ลบผู้บริหารแล้ว");
        pushToSheet("deleteExecutive", { id, name: ex.name });
      });
    });
  }

  function openExecSheet() {
    execForm.reset();
    $("#execId").value = "";
    pickedColor = nextColor();
    renderColorPicker(pickedColor);
    $("#btnExecSubmit").textContent = "+ เพิ่มผู้บริหาร";
    renderExecList();
    openSheet("execOverlay");
  }

  execForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = $("#execId").value;
    const name = $("#execName").value.trim();
    const personName = $("#execPerson").value.trim();
    if (!name) return;
    const color = pickedColor || nextColor();
    const finalId = id || uid();
    if (id) {
      const ex = execById(id);
      ex.name = name;
      ex.personName = personName;
      ex.colorKey = color;
      toast("แก้ไขข้อมูลผู้บริหารแล้ว");
    } else {
      state.executives.push({ id: finalId, name, personName, colorKey: color });
      toast("เพิ่มผู้บริหารแล้ว");
    }
    saveState();
    execForm.reset();
    $("#execId").value = "";
    pickedColor = nextColor();
    renderColorPicker(pickedColor);
    $("#btnExecSubmit").textContent = "+ เพิ่มผู้บริหาร";
    renderExecList();
    renderAll();
    pushToSheet("upsertExecutive", { id: finalId, name, color, person: personName });
  });

  $("#btnOpenExec").addEventListener("click", () => { closeSheet("menuOverlay"); openExecSheet(); });
  $("#btnEmptyAddExec").addEventListener("click", openExecSheet);

  /* ============================================================
     Day detail sheet (from month view)
     ============================================================ */
  let dayDetailDate = null;
  function openDaySheet(dateISO) {
    dayDetailDate = dateISO;
    const d = parseISO(dateISO);
    $("#daySheetTitle").textContent = `${DOW_FULL[d.getDay()]} ${d.getDate()} ${MONTH_FULL[d.getMonth()]} ${d.getFullYear() + 543}`;
    const items = apptsForDate(dateISO);
    const listEl = $("#dayList");
    listEl.innerHTML = items.length ? items.map(a => apptCardHTML(a)).join("") : `<div class="day-empty">ไม่มีนัดหมายในวันนี้</div>`;
    bindApptCardClicks(listEl);
    openSheet("dayOverlay");
  }
  $("#btnDayAdd").addEventListener("click", () => {
    closeSheet("dayOverlay");
    openApptSheet(null, dayDetailDate);
  });

  /* ============================================================
     Menu sheet: JSON backup / clear data
     ============================================================ */
  $("#btnMenu").addEventListener("click", () => openSheet("menuOverlay"));

  $("#btnExportJSON").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `execcal-backup-${fmtISO(new Date())}.json`;
    link.click();
    URL.revokeObjectURL(url);
    closeSheet("menuOverlay");
    toast("ส่งออกข้อมูลแล้ว");
  });

  $("#btnImportJSON").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed.executives) || !Array.isArray(parsed.appointments)) throw new Error("invalid");
        if (!confirm("นำเข้าข้อมูลนี้จะแทนที่ข้อมูลปัจจุบันทั้งหมด ดำเนินการต่อหรือไม่?")) return;
        state = parsed;
        activeFilters = null;
        saveState();
        renderAll();
        closeSheet("menuOverlay");
        toast("นำเข้าข้อมูลสำเร็จ");
      } catch (err) {
        toast("ไฟล์ไม่ถูกต้อง กรุณาตรวจสอบไฟล์สำรองข้อมูล");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  $("#btnClearAll").addEventListener("click", () => {
    if (!confirm("ล้างข้อมูลทั้งหมด (ผู้บริหารและนัดหมายทั้งหมด) หรือไม่? การกระทำนี้ไม่สามารถย้อนกลับได้")) return;
    state = { executives: [], appointments: [] };
    activeFilters = null;
    saveState();
    renderAll();
    closeSheet("menuOverlay");
    toast("ล้างข้อมูลทั้งหมดแล้ว");
  });

  /* ============================================================
     Google Sheet connection sheet (UI)
     ============================================================ */
  function openSheetConnectSheet() {
    $("#gasUrlInput").value = getSheetUrl();
    $("#btnSheetDisconnect").style.display = getSheetUrl() ? "" : "none";
    updateSyncStatus();
    openSheet("sheetOverlay");
  }
  $("#btnOpenSheetConnect").addEventListener("click", () => { closeSheet("menuOverlay"); openSheetConnectSheet(); });
  $("#btnSyncNow").addEventListener("click", () => { closeSheet("menuOverlay"); pullFromSheet({ silent: false }); });

  $("#gasConnectForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = $("#gasUrlInput").value.trim();
    if (!url) { toast("กรุณาวางลิงก์ Web App"); return; }
    setSheetUrl(url);
    $("#btnSheetDisconnect").style.display = "";
    const ok = await pullFromSheet({ silent: false });
    if (ok) closeSheet("sheetOverlay");
  });
  $("#btnSheetDisconnect").addEventListener("click", () => {
    if (!confirm("ยกเลิกการเชื่อมต่อ Google Sheet หรือไม่? ข้อมูลในเครื่องนี้จะยังอยู่")) return;
    clearSheetUrl();
    $("#gasUrlInput").value = "";
    $("#btnSheetDisconnect").style.display = "none";
    updateSyncStatus();
    toast("ยกเลิกการเชื่อมต่อแล้ว");
  });

  /* ============================================================
     Daily summary — "who must be where, and when, today"
     Groups appointments by real PERSON (across all their positions).
     ============================================================ */
  function renderDailySummary(dateISO) {
    const listEl = $("#summaryList");
    const d = parseISO(dateISO);
    const holiday = holidayFor(dateISO);

    // Group executives by person key.
    const groups = new Map(); // personKey -> { personLabel, execIds:Set, positions:[{id,name}] }
    state.executives.forEach(ex => {
      const key = personKeyOf(ex);
      if (!groups.has(key)) groups.set(key, { personLabel: personDisplayName(ex.id), execIds: new Set(), positions: [] });
      const g = groups.get(key);
      g.execIds.add(ex.id);
      g.positions.push({ id: ex.id, name: ex.name });
    });

    const cards = [];
    groups.forEach((g) => {
      const multiPosition = g.positions.length > 1;
      const items = state.appointments
        .filter(a => g.execIds.has(a.execId) && a.date === dateISO && a.status === "confirmed")
        .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
      if (items.length === 0 && !multiPosition) return; // nothing to show for a lone position with no appts today

      let bodyHTML;
      if (holiday) {
        bodyHTML = `<div class="day-empty">🎌 ${escapeHtml(holiday.label)}</div>`;
      } else if (items.length === 0) {
        bodyHTML = `<div class="day-empty">ไม่มีนัดหมายวันนี้</div>`;
      } else {
        bodyHTML = items.map((a, i) => {
          const ex = execById(a.execId);
          const overlapsNext = i < items.length - 1 && toMinutes(items[i + 1].start) < toMinutes(a.end);
          const overlapsPrev = i > 0 && toMinutes(a.start) < toMinutes(items[i - 1].end);
          const clash = overlapsNext || overlapsPrev;
          return `<div style="display:flex; gap:10px; padding:10px 0; ${i > 0 ? "border-top:1px solid var(--hairline-soft);" : ""}">
            <div style="min-width:92px; font-weight:700; font-size:14px; color:var(--ink);">${a.start}–${a.end}</div>
            <div style="flex:1;">
              <div class="title-sm">${escapeHtml(a.title)} ${clash ? `<span class="badge-pill" style="background:var(--error); color:#fff;">⚠️ เวลาซ้อนทับ</span>` : ""}</div>
              <div class="body-sm" style="color:var(--muted);">
                ${multiPosition ? `👔 ${escapeHtml(ex ? ex.name : "—")}` : ""}
                ${a.location ? `${multiPosition ? " · " : ""}📍 ${escapeHtml(a.location)}` : ""}
              </div>
            </div>
          </div>`;
        }).join("");
      }

      cards.push(`<div class="testimonial-card">
        <div class="title-md" style="margin-bottom:4px;">${escapeHtml(g.personLabel)}</div>
        ${multiPosition ? `<div class="caption" style="color:var(--muted); margin-bottom:8px;">ดำรงตำแหน่ง: ${g.positions.map(p => escapeHtml(p.name)).join(", ")}</div>` : ""}
        ${bodyHTML}
      </div>`);
    });

    if (cards.length === 0) {
      listEl.innerHTML = `<div class="empty-state" style="padding:var(--lg) 0;"><div class="em-icon">🗓️</div><p class="body-sm">ไม่มีนัดหมายในวันที่เลือก</p></div>`;
    } else {
      listEl.innerHTML = cards.join("");
    }
  }

  $("#btnOpenSummary").addEventListener("click", () => {
    closeSheet("menuOverlay");
    $("#summaryDate").value = fmtISO(new Date());
    renderDailySummary($("#summaryDate").value);
    openSheet("summaryOverlay");
  });
  $("#summaryDate").addEventListener("change", () => renderDailySummary($("#summaryDate").value));

  /* ============================================================
     Pending approvals sheet
     ============================================================ */
  function renderPendingBadge() {
    const n = pendingCount();
    const badgeTop = $("#pendingBadge");
    const badgeMenu = $("#pendingMenuCount");
    const banner = $("#pendingBanner");
    if (n > 0) {
      badgeTop.textContent = n > 9 ? "9+" : String(n);
      badgeTop.style.display = "flex";
      badgeMenu.textContent = String(n);
      badgeMenu.style.display = "inline-flex";
      $("#pendingBannerText").textContent = `🔔 มีคำขอนัดหมายใหม่รออนุมัติ ${n} รายการ`;
      banner.style.display = "flex";
    } else {
      badgeTop.style.display = "none";
      badgeMenu.style.display = "none";
      banner.style.display = "none";
    }
  }
  $("#pendingBanner").addEventListener("click", () => {
    renderPendingList();
    openSheet("pendingOverlay");
  });

  function renderPendingList() {
    const listEl = $("#pendingList");
    const pending = state.appointments
      .filter(a => a.status === "pending")
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    const declined = state.appointments
      .filter(a => a.status === "declined")
      .sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start)); // most recent first

    if (pending.length === 0 && declined.length === 0) {
      listEl.innerHTML = `<div class="empty-state" style="padding:var(--lg) 0;"><div class="em-icon">✅</div><p class="body-sm">ไม่มีคำขอนัดหมายที่รออนุมัติ</p></div>`;
      return;
    }

    const pendingHTML = pending.length === 0 ? "" : pending.map(a => {
      const ex = execById(a.execId);
      const d = parseISO(a.date);
      // Flag if this request overlaps ANY other appointment (confirmed or another
      // pending request) for the same person — across all of their positions —
      // so the executive can see at a glance that a decision is needed.
      const conflict = findOverlap(a.execId, a.date, a.start, a.end, a.id, ["confirmed", "pending"]);
      let conflictHTML = "";
      if (conflict) {
        const conflictEx = execById(conflict.execId);
        if (conflict.status === "confirmed") {
          conflictHTML = `<div class="body-sm" style="color:var(--error); font-weight:600; margin-top:6px;">
            ⚠️ เวลานี้ถูกยืนยันให้ "${escapeHtml(conflict.title)}"${conflictEx && conflictEx.id !== a.execId ? ` (ตำแหน่ง ${escapeHtml(conflictEx.name)})` : ""} ไปแล้ว (${conflict.start}–${conflict.end})
          </div>`;
        } else {
          conflictHTML = `<div class="body-sm" style="color:var(--warning); font-weight:600; margin-top:6px;">
            ⚠️ เวลาซ้อนกับอีกคำขอหนึ่ง${conflictEx && conflictEx.id !== a.execId ? ` (ตำแหน่ง ${escapeHtml(conflictEx.name)})` : ""}: "${escapeHtml(conflict.title)}" โดย ${escapeHtml(conflict.requestedBy || "ไม่ระบุชื่อ")} (${conflict.start}–${conflict.end}) — กรุณาเลือกอนุมัติเพียงรายการเดียว
          </div>`;
        }
      }
      return `<div class="testimonial-card" data-id="${a.id}">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
          <div>
            <div class="title-sm">${escapeHtml(a.title)}</div>
            <div class="body-sm">${DOW_FULL[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear() + 543} · ${a.start}–${a.end}</div>
            <div class="body-sm">👔 ${escapeHtml(ex ? ex.name : "—")}</div>
            ${a.requestedBy ? `<div class="body-sm">👤 ${escapeHtml(a.requestedBy)}${a.requestedContact ? " · " + escapeHtml(a.requestedContact) : ""}</div>` : ""}
            ${a.requestNote ? `<div class="body-sm" style="color:var(--muted);">"${escapeHtml(a.requestNote)}"</div>` : ""}
            ${conflictHTML}
          </div>
          <span class="badge-pill" style="background:var(--brand-ochre); color:var(--ink); flex-shrink:0;">รออนุมัติ</span>
        </div>
        <div style="display:flex; gap:8px; margin-top:var(--sm);">
          <button class="btn btn-danger btn-sm" data-act="decline" style="flex:1;">ปฏิเสธ</button>
          <button class="btn btn-primary btn-sm" data-act="approve" style="flex:1;">✓ อนุมัติ</button>
        </div>
      </div>`;
    }).join("");

    const declinedHTML = declined.length === 0 ? "" : `
      <div class="caption-upper" style="color:var(--muted); margin:${pending.length ? "var(--lg)" : "0"} 0 4px;">ถูกปฏิเสธแล้ว</div>
      ${declined.map(a => {
        const ex = execById(a.execId);
        const d = parseISO(a.date);
        return `<div class="testimonial-card" data-id="${a.id}" style="opacity:.5;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div>
              <div class="title-sm">${escapeHtml(a.title)}</div>
              <div class="body-sm">${DOW_FULL[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear() + 543} · ${a.start}–${a.end}</div>
              <div class="body-sm">👔 ${escapeHtml(ex ? ex.name : "—")}</div>
              ${a.requestedBy ? `<div class="body-sm">👤 ${escapeHtml(a.requestedBy)}</div>` : ""}
            </div>
            <span class="badge-pill" style="background:var(--hairline); color:var(--muted); flex-shrink:0;">ถูกปฏิเสธ</span>
          </div>
          <div style="display:flex; gap:8px; margin-top:var(--sm);">
            <button class="btn btn-secondary btn-sm" data-act="undecline" style="flex:1;">↩ เปลี่ยนเป็นรออนุมัติ</button>
            <button class="btn btn-danger btn-sm" data-act="purge" style="flex:1;">ลบถาวร</button>
          </div>
        </div>`;
      }).join("")}
    `;

    listEl.innerHTML = pendingHTML + declinedHTML;

    listEl.querySelectorAll("[data-act='approve']").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.closest("[data-id]").dataset.id;
        approveAppointmentFlow(id);
      });
    });
    listEl.querySelectorAll("[data-act='decline']").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.closest("[data-id]").dataset.id;
        if (!confirm("ปฏิเสธคำขอนัดหมายนี้หรือไม่?")) return;
        const local = state.appointments.find(a => a.id === id);
        if (local) local.status = "declined";
        saveState();
        renderAll();
        renderPendingList(); renderPendingBadge();
        toast("ปฏิเสธคำขอนัดหมายแล้ว");
        pushToSheet("declineAppointment", { id });
      });
    });
    listEl.querySelectorAll("[data-act='undecline']").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.closest("[data-id]").dataset.id;
        const local = state.appointments.find(a => a.id === id);
        if (local) local.status = "pending";
        saveState();
        renderAll();
        renderPendingList(); renderPendingBadge();
        toast("เปลี่ยนเป็นรออนุมัติแล้ว");
        pushToSheet("upsertAppointment", (() => {
          const ex = execById(local.execId);
          return { id: local.id, execName: ex ? ex.name : "", date: local.date, start: local.start, end: local.end, title: local.title, location: local.location, notes: local.notes, requestedBy: local.requestedBy, requestedContact: local.requestedContact, requestNote: local.requestNote };
        })());
      });
    });
    listEl.querySelectorAll("[data-act='purge']").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.closest("[data-id]").dataset.id;
        if (!confirm("ลบรายการนี้ออกถาวรหรือไม่? การกระทำนี้ไม่สามารถย้อนกลับได้")) return;
        state.appointments = state.appointments.filter(a => a.id !== id);
        saveState();
        renderAll();
        renderPendingList(); renderPendingBadge();
        toast("ลบรายการแล้ว");
        pushToSheet("deleteAppointment", { id });
      });
    });
  }

  $("#btnOpenPending").addEventListener("click", () => {
    closeSheet("menuOverlay");
    renderPendingList();
    openSheet("pendingOverlay");
  });

  /* ============================================================
     Holiday manager sheet
     ============================================================ */
  function renderHolidayList() {
    const listEl = $("#holidayList");
    const customs = state.holidays.slice().sort((a, b) => a.date.localeCompare(b.date));
    if (customs.length === 0) {
      listEl.innerHTML = `<p class="body-sm" style="color:var(--muted);">ยังไม่มีวันหยุดพิเศษที่เพิ่มเอง</p>`;
      return;
    }
    listEl.innerHTML = customs.map(h => {
      const d = parseISO(h.date);
      return `<div class="exec-row" data-date="${h.date}">
        <span class="exec-name">${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear() + 543} — ${escapeHtml(h.label)}</span>
        <button data-action="delete-holiday" aria-label="ลบ">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;
    }).join("");
    listEl.querySelectorAll("[data-action='delete-holiday']").forEach(btn => {
      btn.addEventListener("click", () => {
        const date = btn.closest("[data-date]").dataset.date;
        state.holidays = state.holidays.filter(h => h.date !== date);
        saveState();
        renderHolidayList();
        toast("ลบวันหยุดแล้ว");
        pushToSheet("deleteHoliday", { date });
      });
    });
  }
  $("#btnOpenHolidays").addEventListener("click", () => {
    closeSheet("menuOverlay");
    renderHolidayList();
    openSheet("holidayOverlay");
  });
  $("#holidayForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const date = $("#holidayDate").value;
    const label = $("#holidayLabel").value.trim() || "วันหยุดราชการ";
    if (!date) return;
    const idx = state.holidays.findIndex(h => h.date === date);
    if (idx >= 0) state.holidays[idx] = { date, label }; else state.holidays.push({ date, label });
    saveState();
    $("#holidayForm").reset();
    $("#holidayLabel").value = "วันหยุดราชการ";
    renderHolidayList();
    renderAll();
    toast("เพิ่มวันหยุดแล้ว");
    pushToSheet("upsertHoliday", { date, label });
  });

  /* ============================================================
     Browser notifications (new pending requests)
     ============================================================ */
  $("#btnNotifPermission").addEventListener("click", async () => {
    if (typeof Notification === "undefined") { toast("เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน"); return; }
    if (Notification.permission === "granted") { toast("เปิดการแจ้งเตือนอยู่แล้ว"); return; }
    if (Notification.permission === "denied") { toast("การแจ้งเตือนถูกปิดไว้ในตั้งค่าเบราว์เซอร์ กรุณาเปิดเองในตั้งค่าเว็บไซต์"); return; }
    const perm = await Notification.requestPermission();
    toast(perm === "granted" ? "เปิดการแจ้งเตือนแล้ว" : "ยังไม่ได้เปิดการแจ้งเตือน");
  });

  /* ============================================================
     Public booking link (share to non-admins)
     ============================================================ */
  $("#btnCopyBookingLink").addEventListener("click", async () => {
    const url = getSheetUrl();
    if (!url) { toast("กรุณาเชื่อมต่อ Google Sheet ก่อน จึงจะสร้างลิงก์ขอนัดหมายได้"); closeSheet("menuOverlay"); openSheetConnectSheet(); return; }
    const base = new URL("booking.html", window.location.href);
    base.searchParams.set("gas", url);
    const link = base.toString();
    try {
      await navigator.clipboard.writeText(link);
      toast("คัดลอกลิงก์แล้ว — ส่งให้ผู้ที่ต้องการขอนัดหมายได้เลย");
    } catch (e) {
      prompt("คัดลอกลิงก์นี้ไปแชร์:", link);
    }
    closeSheet("menuOverlay");
  });

  /* ============================================================
     Official "ตารางปฏิบัติงาน" poster export (matches supplied reference design)
     ============================================================ */
  const POSTER_DOW = [
    { key: 1, label: "วันจันทร์" },
    { key: 2, label: "วันอังคาร" },
    { key: 3, label: "วันพุธ" },
    { key: 4, label: "วันพฤหัสบดี" },
    { key: 5, label: "วันศุกร์" },
    { key: 6, label: "วันเสาร์" },
    { key: 0, label: "วันอาทิตย์" },
  ];

  function mondayOf(d) {
    const x = startOfDay(d);
    const dow = x.getDay(); // 0=Sun..6=Sat
    const diff = dow === 0 ? -6 : 1 - dow;
    x.setDate(x.getDate() + diff);
    return x;
  }

  function weekOptionLabel(monday) {
    const sunday = addDays(monday, 6);
    const label = monday.getMonth() === sunday.getMonth()
      ? `${monday.getDate()}–${sunday.getDate()} ${MONTH_FULL[monday.getMonth()]} ${monday.getFullYear() + 543}`
      : `${monday.getDate()} ${MONTH_SHORT[monday.getMonth()]} – ${sunday.getDate()} ${MONTH_SHORT[sunday.getMonth()]} ${sunday.getFullYear() + 543}`;
    return label;
  }

  function populatePosterWeeks(selectedMonday) {
    const sel = $("#posterWeekStart");
    const currentMonday = mondayOf(new Date());
    const selectedIso = fmtISO(selectedMonday);
    let optionsHTML = "";
    let hasSelected = false;
    // 4 weeks back through 8 weeks ahead of today, always including whichever
    // week the calendar is currently anchored to even if outside that range.
    for (let i = -4; i <= 8; i++) {
      const monday = addDays(currentMonday, i * 7);
      const iso = fmtISO(monday);
      const isThisWeek = i === 0;
      const selectedAttr = iso === selectedIso ? " selected" : "";
      if (selectedAttr) hasSelected = true;
      optionsHTML += `<option value="${iso}"${selectedAttr}>${weekOptionLabel(monday)}${isThisWeek ? " (สัปดาห์นี้)" : ""}</option>`;
    }
    if (!hasSelected) {
      optionsHTML = `<option value="${selectedIso}" selected>${weekOptionLabel(selectedMonday)}</option>` + optionsHTML;
    }
    sel.innerHTML = optionsHTML;
  }

  function openPosterSheet() {
    if (state.executives.length === 0) { toast("กรุณาเพิ่มผู้บริหารก่อน"); closeSheet("menuOverlay"); openExecSheet(); return; }
    const options = state.executives.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join("");
    $("#posterExec").innerHTML = `<option value="ALL">📋 ทุกตำแหน่ง</option>` + options;
    populatePosterWeeks(mondayOf(anchor));
    closeSheet("menuOverlay");
    openSheet("posterOverlay");
  }
  $("#btnOpenPoster").addEventListener("click", openPosterSheet);
  $("#btnExport").addEventListener("click", openPosterSheet);

  $("#posterForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const execId = $("#posterExec").value;
    const weekStartInput = $("#posterWeekStart").value;
    if (!execId || !weekStartInput) return;
    generatePoster(execId, mondayOf(parseISO(weekStartInput)));
  });

  async function generatePoster(execId, monday) {
    const isAll = execId === "ALL";
    const ex = isAll ? null : execById(execId);
    if (!isAll && !ex) return;
    if (typeof html2canvas === "undefined") { toast("ไม่สามารถโหลดตัวสร้างรูปภาพได้"); return; }
    toast("กำลังสร้างตารางปฏิบัติงาน...");

    const today = startOfDay(new Date());
    const rangeLabel = weekOptionLabel(monday);
    const posterTitle = isAll ? "ตารางปฏิบัติงานผู้บริหารทุกท่าน" : `ตารางปฏิบัติงาน ${ex.name}`;

    // Reuse the exact same visual language as the live calendar (same CSS
    // classes/tokens) so the exported image matches the website 1:1.
    // Landscape orientation: days run ACROSS the top as columns, with เช้า/บ่าย
    // as the two data rows underneath — this is a 90° transpose of the on-screen
    // table (which stays portrait/vertical; only this downloadable image changes).
    const wrap = document.createElement("div");
    wrap.style.position = "fixed";
    wrap.style.left = "-9999px";
    wrap.style.top = "0";
    wrap.style.width = "1500px";
    wrap.style.background = "var(--canvas)";
    wrap.style.padding = "40px";
    wrap.style.boxSizing = "border-box";

    function apptChipHTML(a) {
      const ex = execById(a.execId);
      const cls = "c-" + (ex ? ex.colorKey : "cream");
      const execLabel = isAll && ex ? `<small>${escapeHtml(ex.name)}</small>` : "";
      return `<div class="st-chip ${cls}" style="width:100%; box-sizing:border-box;">${escapeHtml(a.start)}–${escapeHtml(a.end)}<br>${escapeHtml(a.title)}${execLabel}</div>`;
    }

    function cellHTML(list, holiday) {
      if (holiday) return `<div class="st-holiday-text" style="justify-content:center; text-align:center;">${escapeHtml(holiday.label)}</div>`;
      if (list.length === 0) return "";
      return list.map(apptChipHTML).join("");
    }

    const dayCols = POSTER_DOW.map((d) => {
      const dayOffset = d.key === 0 ? 6 : d.key - 1; // Monday(1)->0 ... Sunday(0)->6
      const date = addDays(monday, dayOffset);
      const iso = fmtISO(date);
      const holiday = holidayFor(iso);
      const dayAppts = state.appointments
        .filter(a => (isAll || a.execId === execId) && a.date === iso && a.status === "confirmed")
        .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
      return {
        label: d.label.replace("วัน", ""),
        dateLabel: `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear() + 543}`,
        isToday: isSameDay(date, today),
        holiday,
        morning: dayAppts.filter(a => toMinutes(a.start) < 12 * 60),
        afternoon: dayAppts.filter(a => toMinutes(a.start) >= 12 * 60),
      };
    });

    const gridCols = `110px repeat(7, 1fr)`;
    let rowsHTML = `<div style="display:grid; grid-template-columns:${gridCols}; gap:1px; background:var(--hairline); border-radius:var(--r-lg) var(--r-lg) 0 0; overflow:hidden;">`;
    rowsHTML += `<div class="st-head" style="text-align:center;"></div>`;
    dayCols.forEach(d => {
      rowsHTML += `<div class="st-head" style="text-align:center; background:${d.isToday ? "var(--ink)" : "var(--primary)"};">${d.label}<br><span style="font-weight:500; opacity:.75; font-size:11px;">${d.dateLabel}</span></div>`;
    });
    rowsHTML += `</div>`;

    function dataRow(rowLabel, key, alt) {
      let html = `<div style="display:grid; grid-template-columns:${gridCols}; gap:1px; background:var(--hairline);">`;
      html += `<div class="st-day${alt ? " alt" : ""}" style="justify-content:center; text-align:center;">${rowLabel}</div>`;
      dayCols.forEach(d => {
        html += `<div class="st-cell${alt ? " alt" : ""}" style="flex-direction:column; align-items:stretch; min-height:64px;">${cellHTML(d[key], d.holiday)}</div>`;
      });
      html += `</div>`;
      return html;
    }
    rowsHTML += dataRow("ช่วงเช้า", "morning", false);
    rowsHTML += dataRow("ช่วงบ่าย", "afternoon", true);
    rowsHTML = `<div style="border-radius:var(--r-lg); overflow:hidden;">${rowsHTML}</div>`;

    wrap.innerHTML = `
      <div style="text-align:center; margin-bottom:28px;">
        <div style="display:inline-flex; align-items:center; gap:14px; margin-bottom:10px;">
          <img src="assets/logo.png" alt="" style="width:52px; height:52px; border-radius:var(--r-lg); object-fit:cover; flex-shrink:0;">
          <h1 class="display-sm" style="margin:0; font-size:32px;">${escapeHtml(posterTitle)}</h1>
        </div>
        <p class="body-sm" style="color:var(--muted); margin:0;">สัปดาห์วันที่ ${rangeLabel}</p>
      </div>
      ${rowsHTML}
      <div style="margin-top:16px; background:var(--surface-soft); border-radius:var(--r-xl); padding:20px 28px; text-align:center;">
        <span class="body-sm" style="color:var(--body);">หมายเหตุ : ตารางอาจมีการเปลี่ยนแปลงตามความเหมาะสม</span>
      </div>
    `;
    document.body.appendChild(wrap);
    try {
      // Wait for the logo <img> to actually finish loading before capturing —
      // html2canvas would otherwise sometimes grab it mid-load and render blank.
      const logoImg = wrap.querySelector("img");
      if (logoImg && !logoImg.complete) {
        await new Promise((resolve) => {
          logoImg.addEventListener("load", resolve, { once: true });
          logoImg.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 1500); // fallback so a slow/broken image never blocks the export
        });
      }
      const canvas = await html2canvas(wrap, { scale: 3, backgroundColor: "#fffaf0", useCORS: true });
      const link = document.createElement("a");
      link.download = `${posterTitle}-${fmtISO(monday)}.jpg`;
      link.href = canvas.toDataURL("image/jpeg", 0.95);
      link.click();
      toast("ดาวน์โหลดตารางปฏิบัติงานแล้ว");
      closeSheet("posterOverlay");
    } catch (err) {
      console.error(err);
      toast("เกิดข้อผิดพลาดในการสร้างรูปภาพ");
    } finally {
      document.body.removeChild(wrap);
    }
  }

  /* ============================================================
     PWA: service worker + install prompt
     ============================================================ */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js")
        .then((reg) => reg.update().catch(() => {})) // force an immediate check for a newer sw.js on every load
        .catch(err => console.warn("SW registration failed", err));

      // sw.js calls skipWaiting()+clients.claim() on every new version, so once a
      // newer service worker takes over, reload this tab once to pick up the new
      // app.js/HTML instead of continuing to run the old code that's already loaded.
      let reloadedOnce = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloadedOnce) return;
        reloadedOnce = true;
        window.location.reload();
      });
    });
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    $("#btnInstallApp").style.display = "";
  });
  $("#btnInstallApp").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("#btnInstallApp").style.display = "none";
  });

  /* ============================================================
     Seed sample data on first run (helps first-time users)
     ============================================================ */
  function seedIfEmpty() {
    if (state.executives.length > 0) return;
    const today = new Date();
    const e1 = { id: uid(), name: "ประธานเจ้าหน้าที่บริหาร (CEO)", personName: "", colorKey: "pink" };
    const e2 = { id: uid(), name: "ผู้อำนวยการฝ่ายปฏิบัติการ (COO)", personName: "", colorKey: "teal" };
    state.executives.push(e1, e2);
    state.appointments.push(
      { id: uid(), execId: e1.id, title: "ประชุมคณะกรรมการบริหาร", date: fmtISO(today), start: "09:00", end: "10:30", location: "ห้องประชุมใหญ่ ชั้น 12", notes: "", status: "confirmed", requestedBy: "", requestedContact: "", requestNote: "" },
      { id: uid(), execId: e2.id, title: "ตรวจเยี่ยมโรงงาน", date: fmtISO(addDays(today, 1)), start: "13:00", end: "16:00", location: "โรงงานระยอง", notes: "", status: "confirmed", requestedBy: "", requestedContact: "", requestNote: "" }
    );
    saveState();
  }

  /* ---------- Google Sheet auto-sync triggers ---------- */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && getSheetUrl()) pullFromSheet({ silent: true });
  });
  setInterval(() => {
    if (getSheetUrl() && document.visibilityState === "visible") pullFromSheet({ silent: true });
  }, 60000);

  /* ---------- init ---------- */
  if (!getSheetUrl()) seedIfEmpty();
  lastKnownPendingCount = pendingCount(); // baseline so the first sync doesn't "notify" about pre-existing requests
  renderAll();
  updateSyncStatus();
  if (getSheetUrl()) pullFromSheet({ silent: true });
})();
