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

// Gets a sheet by name, creating it (with the given headers) if it doesn't exist yet.
// If it DOES already exist — e.g. from an earlier version of this script, before
// columns like Status/PersonName existed — this also migrates it by appending any
// headers it's missing, so column lookups by name never silently land on the wrong
// (or a nonexistent) column.
function getOrCreateSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return sh;
  }
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const existingHeaders = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
  const missing = headers.filter(h => existingHeaders.indexOf(h) === -1);
  if (missing.length) {
    sh.getRange(1, existingHeaders.length + 1, 1, missing.length).setValues([missing]);
    sh.getRange(1, existingHeaders.length + 1, 1, missing.length).setFontWeight('bold');
  }
  return sh;
}

// Reads the sheet's actual header row (row 1) as an array of trimmed strings.
function headerRowOf_(sh) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  return sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
}

// Finds the 1-indexed column number for a header name by reading the sheet's
// actual header row — rather than trusting a hardcoded array position, which
// would be wrong if the real sheet's columns ever end up in a different order
// than the APPT_HEADERS/EXEC_HEADERS constants (e.g. an older sheet migrated
// via getOrCreateSheet_ above, or someone manually reordered columns).
function columnIndexOf_(sh, headerName) {
  const idx = headerRowOf_(sh).indexOf(headerName);
  return idx === -1 ? -1 : idx + 1;
}

// Appends a new row, placing each field into the column matching its header
// name (read from the sheet's actual header row) — NEVER assumes a fixed
// array order. This is what makes writes safe even when a sheet's real
// columns have drifted from the EXEC_HEADERS/APPT_HEADERS constants.
function appendRowByHeader_(sh, dataByHeader) {
  const headers = headerRowOf_(sh);
  const row = headers.map(h => (h in dataByHeader) ? dataByHeader[h] : '');
  sh.appendRow(row);
}

// Updates specific fields of an existing row (by its 1-indexed sheet row
// number), placing each field into the column matching its header name.
// Fields whose header isn't found are silently skipped (not written).
function updateRowByHeader_(sh, rowNumber, dataByHeader) {
  const headers = headerRowOf_(sh);
  Object.keys(dataByHeader).forEach(key => {
    const idx = headers.indexOf(key);
    if (idx !== -1) sh.getRange(rowNumber, idx + 1).setValue(dataByHeader[key]);
  });
}

// Upserts a row by ID: updates it in place if found, otherwise appends a new
// one (generating an ID if none was given). Returns the ID used.
function upsertRowByHeader_(sh, id, dataByHeader) {
  const { rows } = readSheetObjects_(sh);
  const existing = id ? rows.find(r => String(r.ID) === String(id)) : null;
  if (existing) {
    updateRowByHeader_(sh, existing.__row, dataByHeader);
    return String(existing.ID);
  }
  const finalId = dataByHeader.ID || Utilities.getUuid();
  appendRowByHeader_(sh, Object.assign({}, dataByHeader, { ID: finalId }));
  return finalId;
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
  apptData.rows.forEach(r => {
    const nm = String(r.ExecutiveName || '').trim();
    if (nm && !nameSet.has(nm.toLowerCase())) {
      const color = COLOR_ORDER[executives.length % COLOR_ORDER.length];
      const id = Utilities.getUuid();
      executives.push({ id, name: nm, color, person: '' });
      nameSet.add(nm.toLowerCase());
      appendRowByHeader_(execSheet, { ID: id, Name: nm, Color: color, PersonName: '' });
    }
  });
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
      // A row without an explicit Status is treated as CONFIRMED — this is the
      // executive/staff's own workflow: they log their appointments directly
      // (in the admin app, or straight into the sheet), and those need no
      // approval step. Only requests submitted through booking.html (the public
      // link for outside people) are ever written with Status='pending' — see
      // the 'requestAppointment' action below, which always sets it explicitly.
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

function deleteRow_(sh, id) {
  const { rows } = readSheetObjects_(sh);
  const existing = rows.find(r => String(r.ID) === String(id));
  if (existing) { sh.deleteRow(existing.__row); return true; }
  return false;
}

function upsertHolidayRow_(sh, date, label) {
  const { rows } = readSheetObjects_(sh);
  const existing = rows.find(r => formatDateCell_(r.Date) === date);
  if (existing) {
    updateRowByHeader_(sh, existing.__row, { Date: date, Label: label });
  } else {
    appendRowByHeader_(sh, { Date: date, Label: label });
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
    // Commit any header-column migration from getOrCreateSheet_ above before
    // anything below reads the header row back (appendRowByHeader_/
    // updateRowByHeader_/columnIndexOf_ all depend on seeing it fresh).
    SpreadsheetApp.flush();

    if (action === 'upsertExecutive') {
      upsertRowByHeader_(execSheet, payload.id, { ID: payload.id, Name: payload.name, Color: payload.color, PersonName: payload.person || '' });

    } else if (action === 'deleteExecutive') {
      deleteRow_(execSheet, payload.id);
      const { rows } = readSheetObjects_(apptSheet);
      rows
        .filter(r => String(r.ExecutiveName || '').trim().toLowerCase() === String(payload.name || '').trim().toLowerCase())
        .sort((a, b) => b.__row - a.__row)
        .forEach(r => apptSheet.deleteRow(r.__row));

    } else if (action === 'upsertAppointment') {
      // Used by the admin app — always confirmed, admin already resolved conflicts client-side.
      upsertRowByHeader_(apptSheet, payload.id, {
        ID: payload.id, ExecutiveName: payload.execName, Date: payload.date, Start: payload.start, End: payload.end,
        Title: payload.title, Location: payload.location || '', Notes: payload.notes || '',
        Status: 'confirmed', RequestedBy: payload.requestedBy || '', RequestedContact: payload.requestedContact || '', RequestNote: payload.requestNote || '',
      });

    } else if (action === 'deleteAppointment') {
      deleteRow_(apptSheet, payload.id);

    } else if (action === 'requestAppointment') {
      // Used by the public booking page — creates a PENDING request.
      // If this PERSON (across any of their positions) already has a CONFIRMED
      // slot overlapping this time, warn with details and require payload.force
      // to proceed anyway (the requester explicitly chose to submit despite it).
      const { appointments, executives } = loadData_();
      const conflict = hasConfirmedConflict_(appointments, executives, payload.execName, payload.date, payload.start, payload.end, null);
      if (conflict && !payload.force) {
        return jsonOutput_({
          ok: false,
          conflict: true,
          error: `ช่วงเวลานี้ไม่ว่างแล้ว (ติดภารกิจ "${conflict.title}" ในตำแหน่ง ${conflict.execName} เวลา ${conflict.start}–${conflict.end})`,
          conflictDetail: { title: conflict.title, execName: conflict.execName, start: conflict.start, end: conflict.end, status: conflict.status },
        });
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
      appendRowByHeader_(apptSheet, {
        ID: newId, ExecutiveName: payload.execName, Date: payload.date, Start: payload.start, End: payload.end,
        Title: payload.title || 'ขอเข้าพบ', Location: payload.location || '', Notes: payload.notes || '',
        Status: 'pending', RequestedBy: payload.requestedBy || '', RequestedContact: payload.requestedContact || '', RequestNote: payload.requestNote || '',
      });

      const data = loadData_();
      const response = Object.assign({ ok: true }, data);
      if (pendingClash) {
        response.warning = `บันทึกคำขอของท่านแล้ว แต่มีอีกคำขอหนึ่งขอเวลาเดียวกันไว้ก่อนแล้วเช่นกัน (${pendingClash.start}–${pendingClash.end}) ผู้บริหารจะเป็นผู้พิจารณาว่าจะยืนยันคำขอใด`;
      }
      return jsonOutput_(response);

    } else if (action === 'approveAppointment') {
      const { rows } = readSheetObjects_(apptSheet);
      const row = rows.find(r => String(r.ID) === String(payload.id));
      if (!row) {
        // Previously this silently did nothing and still reported success —
        // which is exactly the "click approve, it silently reverts" bug.
        // Fail loudly instead so the client knows the approval did NOT happen.
        return jsonOutput_({ ok: false, error: `ไม่พบนัดหมายนี้ในชีตแล้ว (ID: ${payload.id}) อาจถูกลบหรือแก้ไขไปจากที่อื่น กรุณาซิงก์ข้อมูลใหม่แล้วลองอีกครั้ง` });
      }
      // Re-check conflicts (across all positions of the same person) at approval time.
      const { appointments, executives } = loadData_();
      const conflict = hasConfirmedConflict_(appointments, executives, row.ExecutiveName, formatDateCell_(row.Date), formatTimeCell_(row.Start), formatTimeCell_(row.End), String(row.ID));
      if (conflict && !payload.force) {
        return jsonOutput_({
          ok: false,
          conflict: true,
          error: `ช่วงเวลานี้ถูกยืนยันให้ "${conflict.title}" (ตำแหน่ง ${conflict.execName}) ไปแล้ว`,
          conflictDetail: { title: conflict.title, execName: conflict.execName, start: conflict.start, end: conflict.end, status: conflict.status },
        });
      }
      if (columnIndexOf_(apptSheet, 'Status') === -1) {
        return jsonOutput_({ ok: false, error: "ไม่พบคอลัมน์ 'Status' ในชีต Appointments — โปรดตรวจสอบว่าแถวหัวตาราง (แถวที่ 1) มีคอลัมน์ชื่อ Status อยู่" });
      }
      updateRowByHeader_(apptSheet, row.__row, { Status: 'confirmed' });

    } else if (action === 'declineAppointment') {
      const deleted = deleteRow_(apptSheet, payload.id);
      if (!deleted) {
        return jsonOutput_({ ok: false, error: `ไม่พบนัดหมายนี้ในชีตแล้ว (ID: ${payload.id}) อาจถูกลบไปแล้วก่อนหน้านี้ กรุณาซิงก์ข้อมูลใหม่` });
      }

    } else if (action === 'upsertHoliday') {
      upsertHolidayRow_(holidaySheet, payload.date, payload.label || 'วันหยุดราชการ');

    } else if (action === 'deleteHoliday') {
      deleteHolidayRow_(holidaySheet, payload.date);

    } else {
      throw new Error('Unknown action: ' + action);
    }

    // Force any pending spreadsheet writes to actually commit before reading
    // the data back below — without this, Apps Script can occasionally batch
    // writes and hand back a stale read within the same execution, which
    // would report success while the client's next render still shows the
    // old value.
    SpreadsheetApp.flush();
    const data = loadData_();
    return jsonOutput_(Object.assign({ ok: true }, data));
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err) });
  }
}
