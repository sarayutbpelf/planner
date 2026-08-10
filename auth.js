/* =========================================================
   ExecCal — Admin auth gate
   Google Sign-In (Google Identity Services), checked against an
   allow-list of emails stored in the "AdminEmails" sheet.
   This is a UI-level access gate, not a cryptographic backend
   boundary — see README.md for the honest security caveat.
   ========================================================= */
(() => {
  "use strict";

  const GAS_URL_KEY = "execcal_gas_url";
  const CLIENT_ID_KEY = "execcal_google_client_id";
  const SESSION_EMAIL_KEY = "execcal_admin_email"; // sessionStorage — cleared when the tab/browser closes

  const $ = (sel) => document.querySelector(sel);

  function getGasUrl() { return (localStorage.getItem(GAS_URL_KEY) || "").trim(); }
  function getClientId() { return (localStorage.getItem(CLIENT_ID_KEY) || "").trim(); }
  function getSessionEmail() { return (sessionStorage.getItem(SESSION_EMAIL_KEY) || "").trim().toLowerCase(); }
  function setSessionEmail(email) { sessionStorage.setItem(SESSION_EMAIL_KEY, email.trim().toLowerCase()); }
  function clearSession() { sessionStorage.removeItem(SESSION_EMAIL_KEY); }

  function showStep(id) {
    ["authStepSetup", "authStepSignin", "authStepClientId", "authStepDenied"].forEach(s => {
      document.getElementById(s).style.display = s === id ? "block" : "none";
    });
  }

  function unlockApp(email) {
    $("#authGate").style.display = "none";
    document.getElementById("app").style.display = "";
    const info = $("#menuSignedInAs");
    if (info) { info.textContent = `เข้าสู่ระบบด้วย ${email}`; info.style.display = "block"; }
  }

  function decodeJwtPayload(token) {
    try {
      const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const json = decodeURIComponent(atob(base64).split("").map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  async function fetchAdminEmails() {
    const url = getGasUrl();
    if (!url) return [];
    try {
      const res = await fetch(url, { method: "GET" });
      const data = await res.json();
      if (!data.ok) return [];
      return Array.isArray(data.adminEmails) ? data.adminEmails.map(e => String(e).trim().toLowerCase()) : [];
    } catch (e) {
      console.warn("Could not fetch admin allow-list", e);
      return null; // null = network failure, distinct from an empty (but reachable) list
    }
  }

  async function addFirstAdmin(email) {
    const url = getGasUrl();
    if (!url) return;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "upsertAdminEmail", payload: { email } }),
      });
    } catch (e) { console.warn("Could not register first admin", e); }
  }

  async function handleCredential(response) {
    const payload = decodeJwtPayload(response.credential);
    const email = (payload && payload.email) ? payload.email.trim().toLowerCase() : "";
    if (!email) { alert("ไม่สามารถอ่านอีเมลจากบัญชี Google ได้ กรุณาลองใหม่"); return; }

    const allow = await fetchAdminEmails();
    if (allow === null) {
      // Could not reach the sheet — fail safe by denying, but let them retry.
      alert("ไม่สามารถตรวจสอบสิทธิ์ได้ในขณะนี้ (เชื่อมต่อ Google Sheet ไม่สำเร็จ) กรุณาลองใหม่");
      return;
    }
    if (allow.length === 0) {
      // Bootstrap: no admins configured yet — the first person to sign in becomes admin.
      await addFirstAdmin(email);
      setSessionEmail(email);
      unlockApp(email);
      return;
    }
    if (allow.includes(email)) {
      setSessionEmail(email);
      unlockApp(email);
    } else {
      $("#deniedEmail").textContent = email;
      showStep("authStepDenied");
    }
  }

  function renderSignInButton() {
    const clientId = getClientId();
    if (!clientId) {
      showStep("authStepSignin");
      $("#authClientIdMissing").style.display = "block";
      return;
    }
    $("#authClientIdMissing").style.display = "none";
    if (typeof google === "undefined" || !google.accounts) {
      // GIS script hasn't loaded yet — retry shortly.
      setTimeout(renderSignInButton, 300);
      return;
    }
    google.accounts.id.initialize({ client_id: clientId, callback: handleCredential });
    $("#gsiButtonWrap").innerHTML = "";
    google.accounts.id.renderButton($("#gsiButtonWrap"), { theme: "outline", size: "large", shape: "pill", text: "signin_with", width: 280 });
    showStep("authStepSignin");
  }

  $("#btnSetClientId").addEventListener("click", () => showStep("authStepClientId"));

  $("#authGasForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const url = $("#authGasInput").value.trim();
    if (!url) return;
    localStorage.setItem(GAS_URL_KEY, url);
    proceedToSignIn();
  });

  $("#authClientIdForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = $("#authClientIdInput").value.trim();
    if (!id) return;
    localStorage.setItem(CLIENT_ID_KEY, id);
    renderSignInButton();
  });

  $("#btnSwitchAccount").addEventListener("click", () => {
    clearSession();
    if (typeof google !== "undefined" && google.accounts) {
      google.accounts.id.disableAutoSelect();
    }
    showStep("authStepSignin");
  });

  function proceedToSignIn() {
    renderSignInButton();
  }

  async function init() {
    if (!getGasUrl()) {
      showStep("authStepSetup");
      return;
    }
    // Already signed in this browser session? Re-verify against the (fresh) allow-list.
    const remembered = getSessionEmail();
    if (remembered) {
      const allow = await fetchAdminEmails();
      if (allow === null) {
        // Network hiccup — trust the remembered session rather than lock the admin out.
        unlockApp(remembered);
        return;
      }
      if (allow.length === 0 || allow.includes(remembered)) {
        unlockApp(remembered);
        return;
      }
      clearSession(); // they were removed from the allow-list since last time
    }
    proceedToSignIn();
  }

  // Sign-out hook used by app.js's menu button (defined there); expose helpers globally.
  window.ExecCalAuth = {
    signOut() {
      clearSession();
      if (typeof google !== "undefined" && google.accounts) google.accounts.id.disableAutoSelect();
      window.location.reload();
    },
  };

  init();
})();
