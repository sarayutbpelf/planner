/* =========================================================
   ExecCal — Public appointment request page (no admin access)
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
  }

  $("#bkExec").addEventListener("change", (e) => { selectedExecName = e.target.value; renderAvailability(); });
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
        return;
      }
      appointments = data.appointments || appointments;
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
