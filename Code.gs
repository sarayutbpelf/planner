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
const COLOR_ORDER = ['pink', 'teal', 'lavender', 'peach', 'ochre', 'cream'];

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
  const execSheet = getOrCreateSheet_(EXEC_SHEET_NAME, ['ID', 'Name', 'Color']);
  const apptSheet = getOrCreateSheet_(APPT_SHEET_NAME, ['ID', 'ExecutiveName', 'Date', 'Start', 'End', 'Title', 'Location', 'Notes']);

  const execData = readSheetObjects_(execSheet);
  ensureIds_(execSheet, execData.rows);

  const apptData = readSheetObjects_(apptSheet);
  ensureIds_(apptSheet, apptData.rows);

  let executives = execData.rows
    .map(r => ({ id: String(r.ID), name: String(r.Name || '').trim(), color: String(r.Color || '').trim().toLowerCase() }))
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
      executives.push({ id, name: nm, color });
      nameSet.add(nm.toLowerCase());
      newExecRows.push([id, nm, color]);
    }
  });
  if (newExecRows.length) {
    execSheet.getRange(execSheet.getLastRow() + 1, 1, newExecRows.length, 3).setValues(newExecRows);
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
    }))
    .filter(a => a.execName && a.date && a.title && a.start && a.end);

  return { executives, appointments };
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
}

function deleteRow_(sh, id) {
  const { rows } = readSheetObjects_(sh);
  const existing = rows.find(r => String(r.ID) === String(id));
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

    const execSheet = getOrCreateSheet_(EXEC_SHEET_NAME, ['ID', 'Name', 'Color']);
    const apptSheet = getOrCreateSheet_(APPT_SHEET_NAME, ['ID', 'ExecutiveName', 'Date', 'Start', 'End', 'Title', 'Location', 'Notes']);

    if (action === 'upsertExecutive') {
      upsertRow_(execSheet, payload.id, [payload.id, payload.name, payload.color]);
    } else if (action === 'deleteExecutive') {
      deleteRow_(execSheet, payload.id);
      const { rows } = readSheetObjects_(apptSheet);
      rows
        .filter(r => String(r.ExecutiveName || '').trim().toLowerCase() === String(payload.name || '').trim().toLowerCase())
        .sort((a, b) => b.__row - a.__row)
        .forEach(r => apptSheet.deleteRow(r.__row));
    } else if (action === 'upsertAppointment') {
      upsertRow_(apptSheet, payload.id, [payload.id, payload.execName, payload.date, payload.start, payload.end, payload.title, payload.location, payload.notes]);
    } else if (action === 'deleteAppointment') {
      deleteRow_(apptSheet, payload.id);
    } else {
      throw new Error('Unknown action: ' + action);
    }

    const data = loadData_();
    return jsonOutput_(Object.assign({ ok: true }, data));
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err) });
  }
}
