/**
 * ExecCal <-> Google Sheets bridge
 * -------------------------------------------------------------
 * วิธีติดตั้ง:
 * 1. สร้าง Google Sheet ใหม่ (ชื่ออะไรก็ได้ เช่น "ExecCal Data")
 * 2. เมนู Extensions > Apps Script
 * 3. ลบโค้ดเดิมทั้งหมดในไฟล์ Code.gs แล้ววางโค้ดนี้ทับ
 * 4. กด Deploy > New deployment
 *    - Select type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. กด Deploy แล้วคัดลอกลิงก์ "Web app URL" (ลงท้ายด้วย /exec)
 * 6. นำลิงก์ไปวางในแอป ExecCal เมนู > เชื่อมต่อ Google Sheet
 *
 * สคริปต์นี้จะสร้างชีต "Executives" และ "Appointments" ให้อัตโนมัติ
 * ในการเรียกครั้งแรก พร้อมหัวตาราง (header row)
 * -------------------------------------------------------------
 */

const EXEC_SHEET_NAME = 'Executives';
const APPT_SHEET_NAME = 'Appointments';
const HOLIDAY_SHEET_NAME = 'Holidays';
const COLOR_ORDER = ['pink', 'teal', 'lavender', 'peach', 'ochre', 'cream'];
const EXEC_HEADERS = ['ID', 'Name', 'Color', 'PersonName'];
const APPT_HEADERS = ['ID', 'ExecutiveName', 'Date', 'Start', 'End', 'Title', 'Location', 'Notes', 'Status', 'RequestedBy', 'RequestedContact', 'RequestNote'];
const HOLIDAY_HEADERS = ['Date', 'Label'];

function getOrCreateSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sh;
}

function readSheetObjects_(sh) {
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return { headers: values[0] || [], rows: [] };
  const headers = values[0];
  const rows = values.slice(1)
    .map((r, idx) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i]; });
      obj.__row = idx + 2; // real row number in the sheet (1-indexed, +1 for header)
      return obj;
    })
    .filter(r => r.__row && Object.keys(r).some(k => k !== '__row' && String(r[k]).trim() !== ''));
  return { headers, rows };
}

function ensureIds_(sh, rows) {
  rows.forEach(r => {
    if (!r.ID) {
      r.ID = Utilities.getUuid();
      sh.getRange(r.__row, 1).setValue(r.ID);
    }
  });
}

function formatDateCell_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v || '').trim();
}
function formatTimeCell_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  }
  return String(v || '').trim();
}

function loadData_() {
  const execSheet = getOrCreateSheet_(EXEC_SHEET_NAME, EXEC_HEADERS);
  const apptSheet = getOrCreateSheet_(APPT_SHEET_NAME, APPT_HEADERS);
  const holidaySheet = getOrCreateSheet_(HOLIDAY_SHEET_NAME, HOLIDAY_HEADERS);

  const execData = readSheetObjects_(execSheet);
  ensureIds_(execSheet, execData.rows);

  const apptData = readSheetObjects_(apptSheet);
  ensureIds_(apptSheet, apptData.rows);

  let executives = execData.rows
    .map(r => ({
      id: String(r.ID),
      name: String(r.Name || '').trim(),
      color: String(r.Color || '').trim().toLowerCase(),
      person: String(r.PersonName || '').trim(), // real human name; blank = same as `name` (no grouping)
    }))
    .filter(e => e.name);

  // Auto-create executives that were typed directly into the Appointments
  // sheet (ExecutiveName) but don't exist yet in the Executives sheet.
  const nameSet = new Set(executives.map(e => e.name.toLowerCase()));
  const newExecRows = [];
  apptData.rows.forEach(r => {
    const nm = String(r.ExecutiveName || '').trim();
    if (nm && !nameSet.has(nm.toLowerCase())) {
      const color = COLOR_ORDER[executives.length % COLOR_ORDER.length];
      const id = Utilities.getUuid();
      executives.push({ id, name: nm, color, person: '' });
      nameSet.add(nm.toLowerCase());
      newExecRows.push([id, nm, color, '']);
    }
  });
  if (newExecRows.length) {
    execSheet.getRange(execSheet.getLastRow() + 1, 1, newExecRows.length, 4).setValues(newExecRows);
  }
  // Fill in any blank color cells so the app always has a color to render.
  executives.forEach((e, i) => {
    if (!e.color) e.color = COLOR_ORDER[i % COLOR_ORDER.length];
  });

  const appointments = apptData.rows
    .map(r => ({
      id: String(r.ID),
      execName: String(r.ExecutiveName || '').trim(),
      date: formatDateCell_(r.Date),
      start: formatTimeCell_(r.Start),
      end: formatTimeCell_(r.End),
      title: String(r.Title || '').trim(),
      location: String(r.Location || '').trim(),
      notes: String(r.Notes || '').trim(),
      status: (String(r.Status || '').trim().toLowerCase() || 'confirmed'),
      requestedBy: String(r.RequestedBy || '').trim(),
      requestedContact: String(r.RequestedContact || '').trim(),
      requestNote: String(r.RequestNote || '').trim(),
    }))
    .filter(a => a.execName && a.date && a.title && a.start && a.end);

  const holidayData = readSheetObjects_(holidaySheet);
  const holidays = holidayData.rows
    .map(r => ({ date: formatDateCell_(r.Date), label: String(r.Label || 'วันหยุดราชการ').trim() }))
    .filter(h => h.date);

  return { executives, appointments, holidays };
}

// The "person key" for an executive/position: their real human name if set,
// otherwise the position name itself (so positions default to standing alone).
function personKeyFor_(executives, execName) {
  const target = executives.find(e => e.name.toLowerCase() === String(execName).trim().toLowerCase());
  const person = (target && target.person) ? target.person.trim().toLowerCase() : String(execName).trim().toLowerCase();
  return person;
}

// All position/executive names that belong to the same real person as `execName`
// (i.e. share the same PersonName — or just `execName` itself if ungrouped).
function personGroupNames_(executives, execName) {
  const key = personKeyFor_(executives, execName);
  return new Set(
    executives
      .filter(e => (e.person ? e.person.trim().toLowerCase() : e.name.trim().toLowerCase()) === key)
      .map(e => e.name.toLowerCase())
  );
}

// Does this PERSON (across all of their positions) already have a CONFIRMED
// appointment overlapping [start,end) on `date`, under any position other than excludeId?
function hasConfirmedConflict_(appointments, executives, execName, date, start, end, excludeId) {
  const toMin = (t) => { const p = String(t).split(':').map(Number); return p[0] * 60 + (p[1] || 0); };
  const s = toMin(start), en = toMin(end);
  const group = personGroupNames_(executives, execName);
  return appointments.find(a =>
    a.id !== excludeId &&
    a.status === 'confirmed' &&
    group.has(a.execName.toLowerCase()) &&
    a.date === date &&
    toMin(a.start) < en && toMin(a.end) > s
  ) || null;
}

function upsertRow_(sh, id, rowValues) {
  const { rows } = readSheetObjects_(sh);
  const existing = id ? rows.find(r => String(r.ID) === String(id)) : null;
  if (existing) {
    sh.getRange(existing.__row, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    if (!rowValues[0]) rowValues[0] = Utilities.getUuid();
    sh.appendRow(rowValues);
  }
  return rowValues[0];
}

function deleteRow_(sh, id) {
  const { rows } = readSheetObjects_(sh);
  const existing = rows.find(r => String(r.ID) === String(id));
  if (existing) sh.deleteRow(existing.__row);
}

function upsertHolidayRow_(sh, date, label) {
  const { rows } = readSheetObjects_(sh);
  const existing = rows.find(r => formatDateCell_(r.Date) === date);
  if (existing) {
    sh.getRange(existing.__row, 1, 1, 2).setValues([[date, label]]);
  } else {
    sh.appendRow([date, label]);
  }
}

function deleteHolidayRow_(sh, date) {
  const { rows } = readSheetObjects_(sh);
  const existing = rows.find(r => formatDateCell_(r.Date) === date);
  if (existing) sh.deleteRow(existing.__row);
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    const data = loadData_();
    return jsonOutput_(Object.assign({ ok: true }, data));
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const payload = body.payload || {};

    const execSheet = getOrCreateSheet_(EXEC_SHEET_NAME, EXEC_HEADERS);
    const apptSheet = getOrCreateSheet_(APPT_SHEET_NAME, APPT_HEADERS);
    const holidaySheet = getOrCreateSheet_(HOLIDAY_SHEET_NAME, HOLIDAY_HEADERS);

    if (action === 'upsertExecutive') {
      upsertRow_(execSheet, payload.id, [payload.id, payload.name, payload.color, payload.person || '']);

    } else if (action === 'deleteExecutive') {
      deleteRow_(execSheet, payload.id);
      const { rows } = readSheetObjects_(apptSheet);
      rows
        .filter(r => String(r.ExecutiveName || '').trim().toLowerCase() === String(payload.name || '').trim().toLowerCase())
        .sort((a, b) => b.__row - a.__row)
        .forEach(r => apptSheet.deleteRow(r.__row));

    } else if (action === 'upsertAppointment') {
      // Used by the admin app — always confirmed, admin already resolved conflicts client-side.
      upsertRow_(apptSheet, payload.id, [
        payload.id, payload.execName, payload.date, payload.start, payload.end,
        payload.title, payload.location || '', payload.notes || '',
        'confirmed', payload.requestedBy || '', payload.requestedContact || '', payload.requestNote || '',
      ]);

    } else if (action === 'deleteAppointment') {
      deleteRow_(apptSheet, payload.id);

    } else if (action === 'requestAppointment') {
      // Used by the public booking page — creates a PENDING request.
      // Reject outright if this PERSON (across any of their positions) already
      // has a CONFIRMED slot overlapping this time.
      const { appointments, executives } = loadData_();
      const conflict = hasConfirmedConflict_(appointments, executives, payload.execName, payload.date, payload.start, payload.end, null);
      if (conflict) {
        return jsonOutput_({ ok: false, error: `ช่วงเวลานี้ไม่ว่างแล้ว (ติดภารกิจ "${conflict.title}" ในตำแหน่ง ${conflict.execName} เวลา ${conflict.start}–${conflict.end}) กรุณาเลือกเวลาอื่น` });
      }
      // Not blocked, but flag if another PENDING request already wants this same slot —
      // both will show up for the executive to choose between.
      const group = personGroupNames_(executives, payload.execName);
      const toMin = (t) => { const p = String(t).split(':').map(Number); return p[0] * 60 + (p[1] || 0); };
      const s = toMin(payload.start), en = toMin(payload.end);
      const pendingClash = appointments.find(a =>
        a.status === 'pending' &&
        group.has(a.execName.toLowerCase()) &&
        a.date === payload.date &&
        toMin(a.start) < en && toMin(a.end) > s
      );

      const newId = Utilities.getUuid();
      apptSheet.appendRow([
        newId, payload.execName, payload.date, payload.start, payload.end,
        payload.title || 'ขอเข้าพบ', payload.location || '', payload.notes || '',
        'pending', payload.requestedBy || '', payload.requestedContact || '', payload.requestNote || '',
      ]);

      const data = loadData_();
      const response = Object.assign({ ok: true }, data);
      if (pendingClash) {
        response.warning = `บันทึกคำขอของท่านแล้ว แต่มีอีกคำขอหนึ่งขอเวลาเดียวกันไว้ก่อนแล้วเช่นกัน (${pendingClash.start}–${pendingClash.end}) ผู้บริหารจะเป็นผู้พิจารณาว่าจะยืนยันคำขอใด`;
      }
      return jsonOutput_(response);

    } else if (action === 'approveAppointment') {
      const { rows } = readSheetObjects_(apptSheet);
      const row = rows.find(r => String(r.ID) === String(payload.id));
      if (row) {
        // Re-check conflicts (across all positions of the same person) at approval time.
        const { appointments, executives } = loadData_();
        const conflict = hasConfirmedConflict_(appointments, executives, row.ExecutiveName, formatDateCell_(row.Date), formatTimeCell_(row.Start), formatTimeCell_(row.End), String(row.ID));
        if (conflict) {
          return jsonOutput_({ ok: false, error: `ไม่สามารถอนุมัติได้ ช่วงเวลานี้ถูกยืนยันให้ "${conflict.title}" (ตำแหน่ง ${conflict.execName}) ไปแล้ว` });
        }
        apptSheet.getRange(row.__row, APPT_HEADERS.indexOf('Status') + 1).setValue('confirmed');
      }

    } else if (action === 'declineAppointment') {
      deleteRow_(apptSheet, payload.id);

    } else if (action === 'upsertHoliday') {
      upsertHolidayRow_(holidaySheet, payload.date, payload.label || 'วันหยุดราชการ');

    } else if (action === 'deleteHoliday') {
      deleteHolidayRow_(holidaySheet, payload.date);

    } else {
      throw new Error('Unknown action: ' + action);
    }

    const data = loadData_();
    return jsonOutput_(Object.assign({ ok: true }, data));
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err) });
  }
}
