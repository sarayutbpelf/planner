/* =========================================================
   P-Roster — Landing page
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

  function mondayOf(d) {
    const x = startOfDay(d);
    const dow = x.getDay(); // 0=Sun..6=Sat
    const diff = dow === 0 ? -6 : 1 - dow;
    x.setDate(x.getDate() + diff);
    return x;
  }

  const TABLE_DOW = [
    { key: 1, label: "วันจันทร์" },
    { key: 2, label: "วันอังคาร" },
    { key: 3, label: "วันพุธ" },
    { key: 4, label: "วันพฤหัสบดี" },
    { key: 5, label: "วันศุกร์" },
    { key: 6, label: "วันเสาร์" },
    { key: 0, label: "วันอาทิตย์" },
  ];

  function holidayFor(dateISO, holidays) {
    const custom = holidays.find(h => h.date === dateISO);
    if (custom) return custom;
    const dow = new Date(dateISO + "T00:00:00").getDay();
    if (dow === 0 || dow === 6) return { date: dateISO, label: "วันหยุดราชการ" };
    return null;
  }

  function apptChipHTML(a, execById) {
    const ex = execById(a.execId);
    const cls = "c-" + (ex ? ex.colorKey : "cream");
    return `<div class="st-chip ${cls}">${escapeHtml(a.start)}–${escapeHtml(a.end)}<small>${escapeHtml(a.title)}</small></div>`;
  }

  function scheduleTableHTML(monday, executives, appointments, holidays) {
    const execById = (id) => executives.find(e => e.id === id);
    const today = startOfDay(new Date());

    let rowsHTML = `<div class="st-head">วัน / ช่วงวัน</div><div class="st-head">ช่วงเช้า</div><div class="st-head">ช่วงบ่าย</div>`;
    TABLE_DOW.forEach((d, i) => {
      const dayOffset = d.key === 0 ? 6 : d.key - 1; // Monday(1)->0 ... Sunday(0)->6
      const date = addDays(monday, dayOffset);
      const iso = fmtISO(date);
      const holiday = holidayFor(iso, holidays);
      const isToday = isSameDay(date, today);
      const alt = i % 2 === 1 ? " alt" : "";

      const items = appointments.filter(a => a.date === iso).sort((a, b) => a.start.localeCompare(b.start));
      const morning = items.filter(a => toMinutes(a.start) < 12 * 60);
      const afternoon = items.filter(a => toMinutes(a.start) >= 12 * 60);

      function cellHTML(list) {
        if (holiday) return `<div class="st-holiday-text">${escapeHtml(holiday.label)}</div>`;
        if (list.length === 0) return "";
        return list.map(a => apptChipHTML(a, execById)).join("");
      }

      rowsHTML += `<div class="st-day${alt}${holiday ? " holiday" : ""}${isToday ? " today" : ""}">${d.label}</div>`;
      rowsHTML += `<div class="st-cell${alt}">${cellHTML(morning)}</div>`;
      rowsHTML += `<div class="st-cell${alt}">${cellHTML(afternoon)}</div>`;
    });
    return `<div class="schedule-table">${rowsHTML}</div>`;
  }

  function renderWeekLabel(start, end) {
    const label = start.getMonth() === end.getMonth()
      ? `${start.getDate()}–${end.getDate()} ${MONTH_FULL[start.getMonth()]} ${start.getFullYear() + 543}`
      : `${start.getDate()} ${MONTH_SHORT[start.getMonth()]} – ${end.getDate()} ${MONTH_SHORT[end.getMonth()]} ${end.getFullYear() + 543}`;
    $("#landingWeekLabel").textContent = label;
  }

  function renderWeek(executives, appointments, holidays) {
    const today = startOfDay(new Date());
    const monday = mondayOf(today);
    const sunday = addDays(monday, 6);
    renderWeekLabel(monday, sunday);

    const totalAppts = appointments.filter(a => {
      const d = new Date(a.date + "T00:00:00");
      return d >= monday && d <= sunday;
    });

    if (totalAppts.length === 0 && holidays.every(h => { const d = new Date(h.date + "T00:00:00"); return !(d >= monday && d <= sunday); })) {
      showEmpty("สัปดาห์นี้ยังไม่มีนัดหมายที่ยืนยันแล้ว");
      return;
    }

    $("#landingWeekList").innerHTML = scheduleTableHTML(monday, executives, appointments, holidays);
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

      const holidays = (data.holidays || []).map(h => ({
        date: String(h.date || "").trim(),
        label: String(h.label || "วันหยุดราชการ").trim(),
      })).filter(h => h.date);

      renderWeek(executives, appointments, holidays);
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
