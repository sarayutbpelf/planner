/* =========================================================
   P-Roster — Public appointment request page (no admin access)
   Reads executives + confirmed/pending appointments from the
   Google Apps Script bridge (read-only for this page, plus one
   write action: requestAppointment) so anyone with the link can
   ask for a slot without seeing or editing anything else.
   ========================================================= */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(window.location.search);
  const DEFAULT_GAS_URL = "https://script.google.com/macros/s/AKfycbzFVqSFyFGe0KXfFMNHGoroYFPGX_XNwTJfEd6GfOmAo92qQ7COBGxKrhgI26jw6wHyMg/exec";
  const gasUrl = (params.get("gas") || DEFAULT_GAS_URL || "").trim();

  let executives = [];
  let appointments = [];
  let holidays = [];
  let selectedExecName = "";

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

  function toMinutes(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function personKeyOf(execName) {
    const ex = executives.find(e => e.name.toLowerCase() === String(execName).trim().toLowerCase());
    return (ex && ex.person && ex.person.trim()) ? ex.person.trim().toLowerCase() : String(execName).trim().toLowerCase();
  }
  // All position names (execName values) that belong to the same real person as `execName`.
  function personGroupNames(execName) {
    const key = personKeyOf(execName);
    return new Set(executives.filter(e => personKeyOf(e.name) === key).map(e => e.name.toLowerCase()));
  }

  function showState(id) {
    ["noLinkState", "loadingState", "formState", "successState"].forEach(s => {
      $("#" + s).style.display = s === id ? "block" : "none";
    });
  }

  /* ============================================================
     Calendar preview (left column) — read-only schedule table
     (วัน / ช่วงเช้า / ช่วงบ่าย) of the selected executive's CURRENT
     WEEK, confirmed + pending appointments — never shows titles,
     just "ไม่ว่าง" (busy), since this page is visible to anyone with
     the link.
     ============================================================ */
  const DOW_FULL = ["วันอาทิตย์", "วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์"];
  const MONTH_FULL = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
  const MONTH_SHORT = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function fmtISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function isSameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function mondayOf(d) { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; } // Sunday-based, matching admin's own calendar

  const TABLE_DOW = [
    { key: 0, label: "วันอาทิตย์" },
    { key: 1, label: "วันจันทร์" },
    { key: 2, label: "วันอังคาร" },
    { key: 3, label: "วันพุธ" },
    { key: 4, label: "วันพฤหัสบดี" },
    { key: 5, label: "วันศุกร์" },
    { key: 6, label: "วันเสาร์" },
  ];

  function holidayFor(dateISO) {
    const custom = holidays.find(h => h.date === dateISO);
    if (custom) return custom;
    const dow = new Date(dateISO + "T00:00:00").getDay();
    if (dow === 0 || dow === 6) return { date: dateISO, label: "วันหยุดราชการ" };
    return null;
  }

  function apptChipHTML(a) {
    const pending = String(a.status || "").toLowerCase() === "pending";
    const cls = pending ? "c-cream pending" : "c-pink";
    return `<div class="st-chip ${cls}" data-appt-id="${escapeHtml(a.id || "")}" style="cursor:pointer;">${escapeHtml(a.start)}–${escapeHtml(a.end)}<small>${escapeHtml(a.title || "")}${pending ? " (รออนุมัติ)" : ""}</small></div>`;
  }

  // Read-only detail popup — same information the admin app shows, no edit controls.
  function showApptDetail(a) {
    const d = new Date(a.date + "T00:00:00");
    const pending = String(a.status || "").toLowerCase() === "pending";
    $("#apptDetailBody").innerHTML = `
      <div class="title-md" style="margin-bottom:4px;">${escapeHtml(a.title || "")}</div>
      <p class="body-sm" style="color:var(--muted); margin-bottom:var(--md);">${DOW_FULL[d.getDay()]} ${d.getDate()} ${MONTH_FULL[d.getMonth()]} ${d.getFullYear() + 543} · ${escapeHtml(a.start)}–${escapeHtml(a.end)}</p>
      <div class="field"><label>ผู้บริหาร</label><p class="body-sm">👔 ${escapeHtml(a.execName || "—")}</p></div>
      ${a.location ? `<div class="field"><label>สถานที่</label><p class="body-sm">📍 ${escapeHtml(a.location)}</p></div>` : ""}
      ${pending ? `<div class="badge-pill" style="background:var(--brand-ochre); color:var(--ink); margin-top:8px;">รออนุมัติ</div>` : ""}
    `;
    openSheet("apptDetailOverlay");
  }

  function bindApptChipClicks(container, group) {
    container.querySelectorAll("[data-appt-id]").forEach(el => {
      el.addEventListener("click", () => {
        const appt = appointments.find(a => String(a.id || "") === el.dataset.apptId && group.has(String(a.execName || "").trim().toLowerCase()));
        if (appt) showApptDetail(appt);
      });
    });
  }

  function scheduleTableHTML(days, group) {
    let rowsHTML = `<div class="st-head">วัน / ช่วงวัน</div><div class="st-head">ช่วงเช้า</div><div class="st-head">ช่วงบ่าย</div>`;
    const today = startOfDay(new Date());
    const showDateNumber = days.length > 7; // month view: disambiguate repeated weekday names
    days.forEach((date, i) => {
      const iso = fmtISO(date);
      const holiday = holidayFor(iso);
      const isToday = isSameDay(date, today);
      const alt = i % 2 === 1 ? " alt" : "";
      const label = showDateNumber
        ? `${DOW_FULL[date.getDay()]}ที่ ${date.getDate()} ${MONTH_FULL[date.getMonth()]}`
        : DOW_FULL[date.getDay()];

      const items = appointments
        .filter(a => a.date === iso && group.has(String(a.execName || "").trim().toLowerCase()) && String(a.status || "").toLowerCase() !== "declined")
        .sort((a, b) => a.start.localeCompare(b.start));
      const morning = items.filter(a => toMinutes(a.start) < 12 * 60);
      const afternoon = items.filter(a => toMinutes(a.start) >= 12 * 60);

      function cellHTML(list) {
        if (holiday) return `<div class="st-holiday-text">${escapeHtml(holiday.label)}</div>`;
        if (list.length === 0) return "";
        return list.map(apptChipHTML).join("");
      }

      rowsHTML += `<div class="st-day${alt}${holiday ? " holiday" : ""}${isToday ? " today" : ""}">${label}</div>`;
      rowsHTML += `<div class="st-cell${alt}">${cellHTML(morning)}</div>`;
      rowsHTML += `<div class="st-cell${alt}">${cellHTML(afternoon)}</div>`;
    });
    return `<div class="schedule-table">${rowsHTML}</div>`;
  }

  // View toggle (รายสัปดาห์ / รายเดือน) — defaults to week, mirrors index.html's landing page.
  let calView = "week";
  let calMonthAnchor = startOfDay(new Date());
  document.querySelectorAll(".view-switch button").forEach(btn => {
    btn.addEventListener("click", () => {
      calView = btn.dataset.view;
      document.querySelectorAll(".view-switch button").forEach(b => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", b === btn ? "true" : "false");
      });
      $("#calMonthNav").style.display = calView === "month" ? "flex" : "none";
      renderCalendarPreview();
    });
  });
  $("#btnCalMonthPrev").addEventListener("click", () => {
    calMonthAnchor = new Date(calMonthAnchor.getFullYear(), calMonthAnchor.getMonth() - 1, 1);
    renderCalendarPreview();
  });
  $("#btnCalMonthNext").addEventListener("click", () => {
    calMonthAnchor = new Date(calMonthAnchor.getFullYear(), calMonthAnchor.getMonth() + 1, 1);
    renderCalendarPreview();
  });
  $("#btnCalMonthToday").addEventListener("click", () => {
    calMonthAnchor = startOfDay(new Date());
    renderCalendarPreview();
  });

  function renderCalendarPreview() {
    if (!selectedExecName) { $("#calendarCol").style.display = "none"; return; }
    $("#calendarCol").style.display = "";
    $("#calTitle").textContent = `ตารางของ ${selectedExecName}`;
    const group = personGroupNames(selectedExecName);

    let rangeStart, rangeEnd, days, label;
    if (calView === "week") {
      rangeStart = mondayOf(new Date());
      rangeEnd = addDays(rangeStart, 6);
      days = Array.from({ length: 7 }, (_, i) => addDays(rangeStart, i));
      label = rangeStart.getMonth() === rangeEnd.getMonth()
        ? `${rangeStart.getDate()}–${rangeEnd.getDate()} ${MONTH_FULL[rangeStart.getMonth()]} ${rangeStart.getFullYear() + 543}`
        : `${rangeStart.getDate()} ${MONTH_SHORT[rangeStart.getMonth()]} – ${rangeEnd.getDate()} ${MONTH_SHORT[rangeEnd.getMonth()]} ${rangeEnd.getFullYear() + 543}`;
    } else {
      const anchor = calMonthAnchor;
      rangeStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      rangeEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
      days = [];
      for (let d = new Date(rangeStart); d <= rangeEnd; d.setDate(d.getDate() + 1)) days.push(new Date(d));
      label = `${MONTH_FULL[anchor.getMonth()]} ${anchor.getFullYear() + 543}`;
    }
    $("#calWeekLabel").textContent = label;

    const rangeItems = appointments.filter(a => {
      const d = new Date(a.date + "T00:00:00");
      return d >= rangeStart && d <= rangeEnd && group.has(String(a.execName || "").trim().toLowerCase()) && String(a.status || "").toLowerCase() !== "declined";
    });
    const rangeHoliday = holidays.some(h => { const d = new Date(h.date + "T00:00:00"); return d >= rangeStart && d <= rangeEnd; });

    if (rangeItems.length === 0 && !rangeHoliday) {
      $("#calWeekList").style.display = "none";
      $("#calEmpty").style.display = "block";
      $("#calEmpty p").textContent = calView === "week" ? "สัปดาห์นี้ยังไม่มีนัดหมายที่ยืนยันแล้ว" : `${label}ยังไม่มีนัดหมายที่ยืนยันแล้ว`;
      return;
    }
    $("#calWeekList").style.display = "";
    $("#calEmpty").style.display = "none";
    $("#calWeekList").innerHTML = scheduleTableHTML(days, group);
    bindApptChipClicks($("#calWeekList"), group);
  }

  async function init() {
    if (!gasUrl) { showState("noLinkState"); return; }
    showState("loadingState");
    try {
      const res = await fetch(gasUrl, { method: "GET" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "load failed");
      executives = data.executives || [];
      appointments = data.appointments || [];
      holidays = data.holidays || [];
      populateExecSelect();
      renderTodaySummary();
      showState("formState");
    } catch (err) {
      console.error(err);
      showState("formState");
      toast("ไม่สามารถโหลดข้อมูลผู้บริหารได้ กรุณาลองใหม่");
    }
  }

  // Today's location summary — same as index.html's landing page, shows
  // where every executive with a confirmed appointment today will be.
  function renderTodaySummary() {
    const card = $("#todaySummaryCard");
    const today = startOfDay(new Date());
    const iso = fmtISO(today);
    $("#todaySummaryDate").textContent = `${DOW_FULL[today.getDay()]} ${today.getDate()} ${MONTH_FULL[today.getMonth()]} ${today.getFullYear() + 543}`;

    const holiday = holidayFor(iso);
    if (holiday) {
      card.style.display = "block";
      $("#todaySummaryList").innerHTML = `<div class="today-item"><div class="today-body"><div class="today-exec">🎌 ${escapeHtml(holiday.label)}</div></div></div>`;
      return;
    }

    const todayItems = appointments
      .filter(a => a.date === iso && String(a.status || "").toLowerCase() === "confirmed")
      .sort((a, b) => a.start.localeCompare(b.start));

    if (todayItems.length === 0) {
      card.style.display = "block";
      $("#todaySummaryList").innerHTML = `<p class="body-sm" style="color:var(--muted);">วันนี้ยังไม่มีนัดหมายที่ยืนยันแล้ว</p>`;
      return;
    }

    card.style.display = "block";
    $("#todaySummaryList").innerHTML = todayItems.map(a => `<div class="today-item">
      <span class="today-time">${escapeHtml(a.start)}–${escapeHtml(a.end)}</span>
      <div class="today-body">
        <div class="today-exec">${escapeHtml(a.execName || "—")}</div>
        <div class="today-loc">📍 ${a.location ? escapeHtml(a.location) : "ไม่ระบุสถานที่"}</div>
      </div>
    </div>`).join("");
  }

  function populateExecSelect() {
    const sel = $("#bkExec");
    sel.innerHTML = executives.map(e => `<option value="${escapeHtml(e.name)}">${escapeHtml(e.name)}</option>`).join("");
    selectedExecName = executives[0] ? executives[0].name : "";
    renderCalendarPreview();
  }

  $("#bkExec").addEventListener("change", (e) => { selectedExecName = e.target.value; renderAvailability(); renderCalendarPreview(); });
  $("#bkDate").addEventListener("change", renderAvailability);
  $("#bkStart").addEventListener("change", checkConflict);
  $("#bkEnd").addEventListener("change", checkConflict);

  function apptsForSelectedDate() {
    const date = $("#bkDate").value;
    if (!date || !selectedExecName) return [];
    const group = personGroupNames(selectedExecName);
    return appointments
      .filter(a => a.date === date && group.has(String(a.execName || "").trim().toLowerCase()))
      .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  }

  function renderAvailability() {
    const list = apptsForSelectedDate();
    const wrap = $("#availWrap");
    const listEl = $("#availList");
    if (list.length === 0) {
      wrap.style.display = "none";
      listEl.innerHTML = "";
    } else {
      wrap.style.display = "block";
      const multiPosition = new Set(list.map(a => a.execName.toLowerCase())).size > 1;
      listEl.innerHTML = list.map(a => {
        const pending = String(a.status || "").toLowerCase() === "pending";
        const samePosition = a.execName.trim().toLowerCase() === selectedExecName.trim().toLowerCase();
        return `<div class="avail-item ${pending ? "pending" : ""}">
          <span>${a.start}–${a.end}${multiPosition && !samePosition ? ` (${escapeHtml(a.execName)})` : ""}</span>
          <span>${pending ? "รอการอนุมัติ" : "มีนัดแล้ว"}</span>
        </div>`;
      }).join("");
    }
    checkConflict();
  }

  function checkConflict() {
    const start = $("#bkStart").value;
    const end = $("#bkEnd").value;
    const banner = $("#conflictBanner");
    const submitBtn = $("#bkSubmit");
    banner.className = "state-banner";
    banner.textContent = "";
    submitBtn.disabled = false;

    if (!start || !end) return;
    if (toMinutes(end) <= toMinutes(start)) {
      banner.classList.add("error");
      banner.textContent = "เวลาสิ้นสุดต้องหลังเวลาเริ่ม";
      submitBtn.disabled = true;
      return;
    }
    const list = apptsForSelectedDate();
    const confirmedConflict = list.find(a =>
      String(a.status || "").toLowerCase() !== "pending" &&
      toMinutes(a.start) < toMinutes(end) && toMinutes(a.end) > toMinutes(start)
    );
    if (confirmedConflict) {
      const samePosition = confirmedConflict.execName.trim().toLowerCase() === selectedExecName.trim().toLowerCase();
      banner.classList.add("error");
      banner.textContent = samePosition
        ? `⛔ ช่วงเวลานี้ไม่ว่างแล้ว (มีนัดหมาย ${confirmedConflict.start}–${confirmedConflict.end}) — ยังส่งคำขอได้ แต่จะต้องยืนยันอีกครั้งก่อนส่ง`
        : `⛔ ช่วงเวลานี้ไม่ว่างแล้ว (ติดภารกิจในตำแหน่ง "${escapeHtml(confirmedConflict.execName)}" เวลา ${confirmedConflict.start}–${confirmedConflict.end}) — ยังส่งคำขอได้ แต่จะต้องยืนยันอีกครั้งก่อนส่ง`;
      return; // warn only — no longer disables submit; the popup handles confirmation at submit time
    }
    const pendingConflict = list.find(a =>
      String(a.status || "").toLowerCase() === "pending" &&
      toMinutes(a.start) < toMinutes(end) && toMinutes(a.end) > toMinutes(start)
    );
    if (pendingConflict) {
      banner.classList.add("warn");
      banner.textContent = "⚠️ มีผู้ขอนัดในช่วงเวลานี้เช่นกัน ระบบจะส่งคำขอของท่านให้ผู้บริหารพิจารณาตามลำดับ";
    }
  }

  function findConfirmedConflict() {
    const start = $("#bkStart").value, end = $("#bkEnd").value;
    if (!start || !end) return null;
    return apptsForSelectedDate().find(a =>
      String(a.status || "").toLowerCase() !== "pending" &&
      toMinutes(a.start) < toMinutes(end) && toMinutes(a.end) > toMinutes(start)
    ) || null;
  }

  $("#bookingForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (toMinutes($("#bkEnd").value) <= toMinutes($("#bkStart").value)) {
      toast("เวลาสิ้นสุดต้องหลังเวลาเริ่ม");
      return;
    }
    const conflict = findConfirmedConflict();
    if (conflict) {
      const samePosition = conflict.execName.trim().toLowerCase() === selectedExecName.trim().toLowerCase();
      const who = samePosition ? "" : ` (ตำแหน่ง ${conflict.execName})`;
      const msg = `ช่วงเวลานี้ซ้อนทับกับนัดหมายที่ยืนยันแล้ว${who}:\n"${conflict.title}"\nเวลา ${conflict.start}–${conflict.end}\n\nยังต้องการส่งคำขอนี้ต่อหรือไม่? ผู้บริหารจะเป็นผู้พิจารณา`;
      showConflictConfirm(msg, () => submitBooking(true));
      return;
    }
    submitBooking(false);
  });

  async function submitBooking(force) {
    const submitBtn = $("#bkSubmit");
    submitBtn.disabled = true;
    submitBtn.textContent = "กำลังส่งคำขอ...";

    const payload = {
      execName: $("#bkExec").value,
      title: $("#bkTitle").value.trim(),
      date: $("#bkDate").value,
      start: $("#bkStart").value,
      end: $("#bkEnd").value,
      location: "",
      notes: "",
      requestedBy: $("#bkName").value.trim(),
      requestedContact: $("#bkContact").value.trim(),
      requestNote: $("#bkNote").value.trim(),
      force: !!force,
    };

    try {
      const res = await fetch(gasUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "requestAppointment", payload }),
      });
      const data = await res.json();
      if (!data.ok) {
        if (data.conflict && data.conflictDetail) {
          // Race condition: became confirmed by someone else between our check and submit.
          const d = data.conflictDetail;
          showConflictConfirm(
            `ช่วงเวลานี้เพิ่งถูกยืนยันให้ "${d.title}" (${d.execName}) เวลา ${d.start}–${d.end}\n\nยังต้องการส่งคำขอนี้ต่อหรือไม่?`,
            () => submitBooking(true)
          );
          submitBtn.disabled = false;
          submitBtn.textContent = "ส่งคำขอนัดหมาย";
          return;
        }
        toast(data.error || "ไม่สามารถส่งคำขอได้ กรุณาลองใหม่", 6000);
        submitBtn.disabled = false;
        submitBtn.textContent = "ส่งคำขอนัดหมาย";
        appointments = data.appointments || appointments;
        renderAvailability();
        renderCalendarPreview();
        return;
      }
      appointments = data.appointments || appointments;
      renderCalendarPreview();
      const warnEl = $("#successWarning");
      if (data.warning) {
        warnEl.textContent = "⚠️ " + data.warning;
        warnEl.style.display = "block";
      } else {
        warnEl.style.display = "none";
      }
      showState("successState");
    } catch (err) {
      console.error(err);
      toast("เกิดข้อผิดพลาด กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
      submitBtn.disabled = false;
      submitBtn.textContent = "ส่งคำขอนัดหมาย";
    }
  }

  $("#btnBookAgain").addEventListener("click", () => {
    $("#bookingForm").reset();
    $("#bkSubmit").disabled = false;
    $("#bkSubmit").textContent = "ส่งคำขอนัดหมาย";
    $("#conflictBanner").className = "state-banner";
    $("#availWrap").style.display = "none";
    showState("formState");
    init();
  });

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
