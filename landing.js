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

  const toastEl = $("#toast");
  let toastTimer = null;
  function toast(msg, durationMs) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), durationMs || 2400);
  }

  function openSheet(id) { $("#" + id).classList.add("show"); document.body.style.overflow = "hidden"; }
  function closeSheet(id) { $("#" + id).classList.remove("show"); document.body.style.overflow = ""; }
  document.querySelectorAll(".overlay").forEach(ov => {
    ov.addEventListener("click", (e) => { if (e.target === ov) closeSheet(ov.id); });
  });
  document.querySelectorAll("[data-close]").forEach(btn => btn.addEventListener("click", () => closeSheet(btn.dataset.close)));
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

    lastData = { monday, executives, appointments, holidays };

    const totalAppts = appointments.filter(a => {
      const d = new Date(a.date + "T00:00:00");
      return d >= monday && d <= sunday;
    });

    if (totalAppts.length === 0 && holidays.every(h => { const d = new Date(h.date + "T00:00:00"); return !(d >= monday && d <= sunday); })) {
      showEmpty("สัปดาห์นี้ยังไม่มีนัดหมายที่ยืนยันแล้ว");
      $("#btnLandingDownload").style.display = "none";
      return;
    }

    $("#landingWeekList").innerHTML = scheduleTableHTML(monday, executives, appointments, holidays);
    showList();
    $("#btnLandingDownload").style.display = "flex";
  }

  function weekOptionLabel(monday) {
    const sunday = addDays(monday, 6);
    return monday.getMonth() === sunday.getMonth()
      ? `${monday.getDate()}–${sunday.getDate()} ${MONTH_FULL[monday.getMonth()]} ${monday.getFullYear() + 543}`
      : `${monday.getDate()} ${MONTH_SHORT[monday.getMonth()]} – ${sunday.getDate()} ${MONTH_SHORT[sunday.getMonth()]} ${sunday.getFullYear() + 543}`;
  }

  function populatePosterWeeks(selectedMonday) {
    const sel = $("#posterWeekStart");
    const currentMonday = mondayOf(new Date());
    const selectedIso = fmtISO(selectedMonday);
    let optionsHTML = "";
    let hasSelected = false;
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

  // Position + week picker (same UI/flow as admin.html's poster download).
  let lastData = null;
  function openPosterSheet() {
    if (!lastData) return;
    const options = lastData.executives.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join("");
    $("#posterExec").innerHTML = `<option value="ALL">📋 ทุกตำแหน่ง</option>` + options;
    populatePosterWeeks(lastData.monday);
    openSheet("posterOverlay");
  }
  $("#btnLandingDownload").addEventListener("click", openPosterSheet);
  $("#posterForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const execId = $("#posterExec").value;
    const weekStartInput = $("#posterWeekStart").value;
    if (!execId || !weekStartInput) return;
    downloadPoster(execId, new Date(weekStartInput + "T00:00:00"));
  });

  // Same exact table structure as the on-screen version (วัน / ช่วงเช้า /
  // ช่วงบ่าย, day rows) — the download is landscape simply because the
  // canvas is rendered wide, not by changing the layout shape.
  async function downloadPoster(execId, monday) {
    if (!lastData) return;
    if (typeof html2canvas === "undefined") { toast("ไม่สามารถโหลดตัวสร้างรูปภาพได้"); return; }
    toast("กำลังสร้างตารางปฏิบัติงาน...");

    const { executives, appointments, holidays } = lastData;
    const isAll = execId === "ALL";
    const ex = isAll ? null : executives.find(e => e.id === execId);
    if (!isAll && !ex) return;
    const execById = (id) => executives.find(e => e.id === id);

    const today = startOfDay(new Date());
    const rangeLabel = weekOptionLabel(monday);
    const posterTitle = isAll
      ? "ตารางปฏิบัติงานผู้บริหารทุกท่าน"
      : (ex.personName && ex.personName.trim())
        ? `ตารางปฏิบัติงาน ${ex.personName.trim()} ในตำแหน่ง ${ex.name}`
        : `ตารางปฏิบัติงาน ${ex.name}`;

    const wrap = document.createElement("div");
    wrap.style.position = "fixed";
    wrap.style.left = "-9999px";
    wrap.style.top = "0";
    wrap.style.width = "1600px";
    wrap.style.background = "var(--canvas)";
    wrap.style.padding = "44px";
    wrap.style.boxSizing = "border-box";

    function apptChipHTML(a) {
      const chipEx = execById(a.execId);
      const cls = "c-" + (chipEx ? chipEx.colorKey : "cream");
      const execLabel = isAll && chipEx ? `<small>${escapeHtml(chipEx.name)}</small>` : "";
      return `<div class="st-chip ${cls}">${escapeHtml(a.start)}–${escapeHtml(a.end)}<br>${escapeHtml(a.title)}${execLabel}</div>`;
    }
    function cellHTML(list, holiday) {
      if (holiday) return `<div class="st-holiday-text" style="font-size:14px;">${escapeHtml(holiday.label)}</div>`;
      if (list.length === 0) return "";
      return list.map(apptChipHTML).join("");
    }

    let rowsHTML = `<div class="st-head">วัน / ช่วงวัน</div><div class="st-head">ช่วงเช้า</div><div class="st-head">ช่วงบ่าย</div>`;
    TABLE_DOW.forEach((d, i) => {
      const dayOffset = d.key === 0 ? 6 : d.key - 1;
      const date = addDays(monday, dayOffset);
      const iso = fmtISO(date);
      const holiday = holidayFor(iso, holidays);
      const dayAppts = appointments
        .filter(a => (isAll || a.execId === execId) && a.date === iso)
        .sort((a, b) => a.start.localeCompare(b.start));
      const morning = dayAppts.filter(a => toMinutes(a.start) < 12 * 60);
      const afternoon = dayAppts.filter(a => toMinutes(a.start) >= 12 * 60);
      const isToday = isSameDay(date, today);
      const alt = i % 2 === 1 ? " alt" : "";

      rowsHTML += `<div class="st-day${alt}${holiday ? " holiday" : ""}${isToday ? " today" : ""}" style="font-size:16px; padding:16px 18px;">${d.label}</div>`;
      rowsHTML += `<div class="st-cell${alt}" style="padding:14px;">${cellHTML(morning, holiday)}</div>`;
      rowsHTML += `<div class="st-cell${alt}" style="padding:14px;">${cellHTML(afternoon, holiday)}</div>`;
    });

    wrap.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:24px; gap:20px;">
        <div style="display:flex; align-items:center; gap:16px; min-width:0;">
          <img src="assets/logo.png" alt="" style="width:56px; height:56px; border-radius:var(--r-lg); object-fit:cover; flex-shrink:0;">
          <div style="min-width:0;">
            <h1 class="display-sm" style="margin:0; font-size:30px; line-height:1.25;">${escapeHtml(posterTitle)}</h1>
            <p class="body-sm" style="color:var(--muted); margin:4px 0 0;">${rangeLabel}</p>
          </div>
        </div>
      </div>
      <div class="schedule-table" style="grid-template-columns:150px 1fr 1fr;">${rowsHTML}</div>
      <div style="margin-top:18px; background:var(--surface-soft); border-radius:var(--r-xl); padding:20px 28px; text-align:center;">
        <span class="body-sm" style="color:var(--body);">หมายเหตุ : ตารางอาจมีการเปลี่ยนแปลงตามความเหมาะสม</span>
      </div>
    `;
    document.body.appendChild(wrap);
    try {
      const logoImg = wrap.querySelector("img");
      if (logoImg && !logoImg.complete) {
        await new Promise((resolve) => {
          logoImg.addEventListener("load", resolve, { once: true });
          logoImg.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 1500);
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
        personName: String(e.person || "").trim(),
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
