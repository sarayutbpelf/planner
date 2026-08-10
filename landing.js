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
      return (localStorage.getItem(GAS_URL_KEY) || "").trim();
    } catch (e) {
      return "";
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

  function renderWeekLabel(start, end) {
    const label = start.getMonth() === end.getMonth()
      ? `${start.getDate()}–${end.getDate()} ${MONTH_FULL[start.getMonth()]} ${start.getFullYear() + 543}`
      : `${start.getDate()} ${MONTH_SHORT[start.getMonth()]} – ${end.getDate()} ${MONTH_SHORT[end.getMonth()]} ${end.getFullYear() + 543}`;
    $("#landingWeekLabel").textContent = label;
  }

  function apptCardHTML(a, execById) {
    const ex = execById(a.execId);
    const cls = "c-" + (ex ? ex.colorKey : "cream");
    return `<div class="appt-card ${cls}">
      <span class="appt-time">${escapeHtml(a.start)}–${escapeHtml(a.end)}</span>
      <span class="appt-title">${escapeHtml(a.title)}</span>
      <span class="appt-meta">
        ${ex ? `<span class="appt-exec">${escapeHtml(ex.name)}</span>` : ""}
        ${a.location ? `<span>📍 ${escapeHtml(a.location)}</span>` : ""}
      </span>
    </div>`;
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
        <div class="day-card-body">
          ${items.length ? items.map(a => apptCardHTML(a, execById)).join("") : `<div class="day-empty">ไม่มีนัดหมาย</div>`}
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

  // Carry the connected Google Sheet link into the booking card automatically,
  // so it works out of the box on the admin's own device.
  (function wireBookingLink() {
    try {
      const gas = getGasUrl();
      if (gas) {
        $("#bookingLink").href = "booking.html?gas=" + encodeURIComponent(gas);
      }
    } catch (e) { /* booking link still works via a shared link with ?gas= already in it */ }
  })();

  init();
})();
