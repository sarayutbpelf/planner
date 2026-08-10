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
  const gasUrl = (params.get("gas") || "").trim();

  let executives = [];
  let appointments = [];
  let selectedExecName = "";

  const toastEl = $("#toast");
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2400);
  }

  function toMinutes(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
    return appointments
      .filter(a => a.date === date && String(a.execName || "").trim().toLowerCase() === selectedExecName.trim().toLowerCase())
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
      listEl.innerHTML = list.map(a => {
        const pending = String(a.status || "").toLowerCase() === "pending";
        return `<div class="avail-item ${pending ? "pending" : ""}">
          <span>${a.start}–${a.end}</span>
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
      banner.classList.add("error");
      banner.textContent = `⛔ ช่วงเวลานี้ไม่ว่างแล้ว (มีนัดหมาย ${confirmedConflict.start}–${confirmedConflict.end}) กรุณาเลือกเวลาอื่น`;
      submitBtn.disabled = true;
      return;
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

  $("#bookingForm").addEventListener("submit", async (e) => {
    e.preventDefault();
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
    };

    try {
      const res = await fetch(gasUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "requestAppointment", payload }),
      });
      const data = await res.json();
      if (!data.ok) {
        toast(data.error || "ไม่สามารถส่งคำขอได้ กรุณาลองใหม่");
        submitBtn.disabled = false;
        submitBtn.textContent = "ส่งคำขอนัดหมาย";
        appointments = data.appointments || appointments;
        renderAvailability();
        return;
      }
      appointments = data.appointments || appointments;
      showState("successState");
    } catch (err) {
      console.error(err);
      toast("เกิดข้อผิดพลาด กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
      submitBtn.disabled = false;
      submitBtn.textContent = "ส่งคำขอนัดหมาย";
    }
  });

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
})();
