/* =========================================================
   ExecCal — Landing page
   Shows a read-only preview of this week's CONFIRMED appointments
   (if a Google Sheet link is available) plus the two role cards.
   No editing happens here — that lives in admin.html / booking.html.
   ========================================================= */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const GAS_URL_KEY = "execcal_gas_url";
  const GAS_DISCONNECTED_KEY = "execcal_gas_disconnected";
  const DEFAULT_GAS_URL = "https://script.google.com/macros/s/AKfycbzFVqSFyFGe0KXfFMNHGoroYFPGX_XNwTJfEd6GfOmAo92qQ7COBGxKrhgI26jw6wHyMg/exec";

  const DOW_FULL = ["วันอาทิตย์", "วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์"];
  const MONTH_FULL = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
  const MONTH_SHORT = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  const COLOR_ORDER = ["pink", "teal", "lavender", "peach", "ochre", "cream"];

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function fmtISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function startOfWeek(d) { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; } // Sunday
  function isSameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function toMinutes(hhmm) { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + (m || 0); }
  function normalizeColor(c) {
    const k = String(c || "").trim().toLowerCase();
    return COLOR_ORDER.includes(k) ? k : null;
  }

  function getGasUrl() {
    try {
      const fromQuery = new URLSearchParams(window.location.search).get("gas");
      if (fromQuery) return fromQuery.trim();
    } catch (e) { /* ignore */ }
    try {
      if (localStorage.getItem(GAS_DISCONNECTED_KEY) === "1") return "";
      return (localStorage.getItem(GAS_URL_KEY) || DEFAULT_GAS_URL).trim();
    } catch (e) {
      return DEFAULT_GAS_URL;
    }
  }

  function showLoading() {
    $("#landingLoading").style.display = "block";
    $("#landingWeekList").style.display = "none";
    $("#landingEmpty").style.display = "none";
  }
  function showEmpty(message) {
    $("#landingLoading").style.display = "none";
    $("#landingWeekList").style.display = "none";
    const emptyEl = $("#landingEmpty");
    emptyEl.style.display = "block";
    if (message) emptyEl.querySelector("p").textContent = message;
  }
  function showList() {
    $("#landingLoading").style.display = "none";
    $("#landingWeekList").style.display = "";
    $("#landingEmpty").style.display = "none";
  }

  const PX_PER_HOUR = 56;
  const MIN_EVENT_HEIGHT = 30;

  // Pack overlapping events into side-by-side columns (like a real calendar day view)
  // so staggered/overlapping appointments never hide each other.
  function layoutColumns(items) {
    const sorted = items.slice().sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    const colEndTimes = [];
    const placed = sorted.map(item => {
      const s = toMinutes(item.start), e = toMinutes(item.end);
      let col = colEndTimes.findIndex(endT => s >= endT);
      if (col === -1) { col = colEndTimes.length; colEndTimes.push(e); }
      else { colEndTimes[col] = e; }
      return Object.assign({}, item, { col });
    });
    return { placed, totalCols: colEndTimes.length || 1 };
  }

  function dayTimelineHTML(items, execById) {
    if (items.length === 0) return `<div class="day-empty">ไม่มีนัดหมาย</div>`;

    // Default business-hours window, widened automatically if any appointment falls outside it.
    let rangeStart = 8 * 60, rangeEnd = 18 * 60;
    items.forEach(a => {
      rangeStart = Math.min(rangeStart, Math.floor(toMinutes(a.start) / 60) * 60);
      rangeEnd = Math.max(rangeEnd, Math.ceil(toMinutes(a.end) / 60) * 60);
    });
    const hourCount = (rangeEnd - rangeStart) / 60;
    const totalHeight = hourCount * PX_PER_HOUR;

    let hoursHTML = "", gridHTML = "";
    for (let i = 0; i <= hourCount; i++) {
      const top = i * PX_PER_HOUR;
      const hh = String(Math.floor((rangeStart + i * 60) / 60) % 24).padStart(2, "0");
      hoursHTML += `<div class="day-timeline-hour-label" style="top:${top}px;">${hh}:00</div>`;
      gridHTML += `<div class="day-timeline-gridline" style="top:${top}px;"></div>`;
    }

    const { placed, totalCols } = layoutColumns(items);
    const eventsHTML = placed.map(a => {
      const ex = execById(a.execId);
      const cls = "c-" + (ex ? ex.colorKey : "cream");
      const s = toMinutes(a.start), e = toMinutes(a.end);
      const top = ((s - rangeStart) / 60) * PX_PER_HOUR;
      const height = Math.max(((e - s) / 60) * PX_PER_HOUR, MIN_EVENT_HEIGHT);
      const widthPct = 100 / totalCols;
      const leftPct = a.col * widthPct;
      return `<div class="day-timeline-event ${cls}" style="top:${top}px; height:${height}px; left:calc(${leftPct}% + 2px); width:calc(${widthPct}% - 4px);">
        <span class="dt-time">${escapeHtml(a.start)}–${escapeHtml(a.end)}</span>
        <span class="dt-title">${escapeHtml(a.title)}</span>
        ${ex ? `<span class="dt-exec">${escapeHtml(ex.name)}</span>` : ""}
      </div>`;
    }).join("");

    return `<div class="day-timeline" style="height:${totalHeight}px;">
      <div class="day-timeline-hours" style="height:${totalHeight}px;">${hoursHTML}</div>
      <div class="day-timeline-track" style="height:${totalHeight}px;">${gridHTML}${eventsHTML}</div>
    </div>`;
  }

  function renderWeekLabel(start, end) {
    const label = start.getMonth() === end.getMonth()
      ? `${start.getDate()}–${end.getDate()} ${MONTH_FULL[start.getMonth()]} ${start.getFullYear() + 543}`
      : `${start.getDate()} ${MONTH_SHORT[start.getMonth()]} – ${end.getDate()} ${MONTH_SHORT[end.getMonth()]} ${end.getFullYear() + 543}`;
    $("#landingWeekLabel").textContent = label;
  }

  function renderWeek(executives, appointments) {
    const execById = (id) => executives.find(e => e.id === id);
    const today = startOfDay(new Date());
    const start = startOfWeek(today);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    renderWeekLabel(start, days[6]);

    const totalAppts = appointments.filter(a => {
      const d = new Date(a.date + "T00:00:00");
      return d >= start && d <= days[6];
    });

    if (totalAppts.length === 0) {
      showEmpty("สัปดาห์นี้ยังไม่มีนัดหมายที่ยืนยันแล้ว");
      return;
    }

    $("#landingWeekList").innerHTML = days.map(d => {
      const iso = fmtISO(d);
      const items = appointments
        .filter(a => a.date === iso)
        .sort((a, b) => a.start.localeCompare(b.start));
      const isToday = isSameDay(d, today);
      return `<div class="day-card">
        <div class="day-card-header ${isToday ? "today" : ""}">
          <span class="dow">${DOW_FULL[d.getDay()]}</span>
          <span class="dom">${d.getDate()} ${MONTH_SHORT[d.getMonth()]}</span>
        </div>
        <div class="day-card-body" style="${items.length ? "padding:0;" : ""}">
          ${dayTimelineHTML(items, execById)}
        </div>
      </div>`;
    }).join("");
    showList();
  }

  async function init() {
    const gasUrl = getGasUrl();
    if (!gasUrl) {
      showEmpty("ยังไม่ได้เชื่อมต่อข้อมูลตารางนัดหมายบนอุปกรณ์นี้ — เข้าสู่เมนูจัดการนัดหมายเพื่อเชื่อมต่อ Google Sheet");
      return;
    }
    showLoading();
    try {
      const res = await fetch(gasUrl, { method: "GET" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "load failed");

      const executives = (data.executives || []).map((e, i) => ({
        id: String(e.id),
        name: String(e.name || "").trim(),
        colorKey: normalizeColor(e.color) || COLOR_ORDER[i % COLOR_ORDER.length],
      })).filter(e => e.name);
      const nameToId = new Map(executives.map(e => [e.name.toLowerCase(), e.id]));

      const appointments = (data.appointments || [])
        .filter(a => String(a.status || "").toLowerCase() !== "pending")
        .map(a => ({
          execId: nameToId.get(String(a.execName || "").trim().toLowerCase()) || null,
          title: String(a.title || "").trim(),
          date: String(a.date || "").trim(),
          start: String(a.start || "").trim(),
          end: String(a.end || "").trim(),
          location: String(a.location || "").trim(),
        }))
        .filter(a => a.execId && a.date && a.title && a.start && a.end);

      renderWeek(executives, appointments);
    } catch (err) {
      console.error(err);
      showEmpty("ไม่สามารถโหลดตารางนัดหมายได้ในขณะนี้ ลองรีเฟรชหน้าอีกครั้ง");
    }
  }

  init();

  /* Service worker: register + auto-reload once a newer version takes over. */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js")
        .then((reg) => reg.update().catch(() => {}))
        .catch(() => {});
      let reloadedOnce = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloadedOnce) return;
        reloadedOnce = true;
        window.location.reload();
      });
    });
  }
})();
