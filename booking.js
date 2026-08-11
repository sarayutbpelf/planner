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
     Calendar preview (left column) — read-only timeline of the
     selected executive's CURRENT WEEK, confirmed appointments only.
     ============================================================ */
  const DOW_FULL = ["วันอาทิตย์", "วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์"];
  const MONTH_FULL = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
  const MONTH_SHORT = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  const PX_PER_HOUR = 56;
  const MIN_EVENT_HEIGHT = 30;

  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function fmtISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function startOfWeek(d) { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; } // Sunday
  function isSameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

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

  function dayTimelineHTML(items) {
    if (items.length === 0) return `<div class="day-empty">ไม่มีนัดหมาย</div>`;
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
      const pending = String(a.status || "").toLowerCase() === "pending";
      const cls = pending ? "c-cream" : "c-pink";
      const s = toMinutes(a.start), e = toMinutes(a.end);
      const top = ((s - rangeStart) / 60) * PX_PER_HOUR;
      const height = Math.max(((e - s) / 60) * PX_PER_HOUR, MIN_EVENT_HEIGHT);
      const widthPct = 100 / totalCols;
      const leftPct = a.col * widthPct;
      return `<div class="day-timeline-event ${cls}" style="top:${top}px; height:${height}px; left:calc(${leftPct}% + 2px); width:calc(${widthPct}% - 4px); ${pending ? "border:2px dashed var(--brand-ochre);" : ""}">
        <span class="dt-time">${escapeHtml(a.start)}–${escapeHtml(a.end)}</span>
        <span class="dt-title">${pending ? "ไม่ว่าง (รออนุมัติ)" : "ไม่ว่าง"}</span>
      </div>`;
    }).join("");

    return `<div class="day-timeline" style="height:${totalHeight}px;">
      <div class="day-timeline-hours" style="height:${totalHeight}px;">${hoursHTML}</div>
      <div class="day-timeline-track" style="height:${totalHeight}px;">${gridHTML}${eventsHTML}</div>
    </div>`;
  }

  function renderCalendarPreview() {
    if (!selectedExecName) { $("#calendarCol").style.display = "none"; return; }
    $("#calendarCol").style.display = "";
    $("#calTitle").textContent = `ตารางของ ${selectedExecName}`;

    const today = startOfDay(new Date());
    const start = startOfWeek(today);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const end = days[6];
    const label = start.getMonth() === end.getMonth()
      ? `${start.getDate()}–${end.getDate()} ${MONTH_FULL[start.getMonth()]} ${start.getFullYear() + 543}`
      : `${start.getDate()} ${MONTH_SHORT[start.getMonth()]} – ${end.getDate()} ${MONTH_SHORT[end.getMonth()]} ${end.getFullYear() + 543}`;
    $("#calWeekLabel").textContent = label;

    const group = personGroupNames(selectedExecName);
    const weekItems = appointments.filter(a => {
      const d = new Date(a.date + "T00:00:00");
      return d >= start && d <= end && group.has(String(a.execName || "").trim().toLowerCase()) && String(a.status || "").toLowerCase() !== "declined";
    });

    if (weekItems.length === 0) {
      $("#calWeekList").style.display = "none";
      $("#calEmpty").style.display = "block";
      return;
    }
    $("#calWeekList").style.display = "";
    $("#calEmpty").style.display = "none";

    $("#calWeekList").innerHTML = days.map(d => {
      const iso = fmtISO(d);
      const items = appointments
        .filter(a => a.date === iso && group.has(String(a.execName || "").trim().toLowerCase()) && String(a.status || "").toLowerCase() !== "declined")
        .sort((a, b) => a.start.localeCompare(b.start));
      const isToday = isSameDay(d, today);
      return `<div class="day-card">
        <div class="day-card-header ${isToday ? "today" : ""}">
          <span class="dow">${DOW_FULL[d.getDay()]}</span>
          <span class="dom">${d.getDate()} ${MONTH_SHORT[d.getMonth()]}</span>
        </div>
        <div class="day-card-body" style="${items.length ? "padding:0;" : ""}">
          ${dayTimelineHTML(items)}
        </div>
      </div>`;
    }).join("");
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
      populateExecSelect();
      showState("formState");
    } catch (err) {
      console.error(err);
      showState("formState");
      toast("ไม่สามารถโหลดข้อมูลผู้บริหารได้ กรุณาลองใหม่");
    }
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
