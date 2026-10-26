/* =========================================================================
   MA.FC CENTRAL SPEC — addon p7 : บัญชีผู้ใช้ (รหัสส่วนตัว / ทีม)
   -------------------------------------------------------------------------
   ไม่แตะเครื่องยนต์เดิมแม้แต่บรรทัดเดียว (กฏเหล็กข้อ 1)
   เพิ่มระบบรหัสส่วนตัวรายคน (แทนกุญแจเดิมที่ใช้ร่วมกันทั้งทีม) คุยกับ
   Apps Script ผ่านคำสั่งใหม่: me / teamList / teamAdd / teamRole /
   teamIssue / teamRevoke — ดู README ของฝั่งเซิร์ฟเวอร์
   สี/ฟอนต์อ้างอิง design-system/mafc-central-spec/MASTER.md §3 §4
   ========================================================================= */
(function () {
  "use strict";
  if (window.__mafcAuthP7) return;
  window.__mafcAuthP7 = 1;

  var ROLE_TH = { MD: "ผู้บริหาร", PM: "ผู้จัดการโครงการ", CM: "ผู้ควบคุมงาน", CUS: "ลูกค้า" };
  function roleTH(r) { return ROLE_TH[r] || r || ""; }

  // AUTH = ข้อมูลตัวตนที่ยืนยันแล้วจากเซิร์ฟเวอร์ (null = ยังไม่ยืนยัน/ออกจากระบบ)
  var AUTH = null;
  // สถานะ chip: 'out' ยังไม่ล็อกอิน · 'checking' มี token แต่ยังยืนยันไม่จบ (หรือเซิร์ฟเวอร์เก่า/busy) · 'in' ยืนยันแล้ว
  var authState = "out";

  /* ---------- เก็บ fetch เดิมไว้ก่อนห่อ — คำเรียกของ "เรา" (post()) ใช้ตัวเดิม
     ตรงนี้เสมอ ส่วน window.fetch ที่ถูกห่อไว้ข้างล่างมีไว้ดักทางของ "เครื่องยนต์"
     (apiWrite ฯลฯ) เท่านั้น กันไม่ให้ event เดียวกันถูกจับสองรอบซ้อนกัน ---------- */
  var origFetch = (typeof window.fetch === "function") ? window.fetch : null;

  /* ---------- ห่อ window.jsonp กันรหัสหลุดไปเป็นส่วนหนึ่งของ URL ----------
     ทางเดิน apiWrite() ของเครื่องยนต์: ถ้า fetch POST พังด้วยเหตุผลอื่นนอกจาก
     "บันทึกไม่สำเร็จ" มันจะ fallback ไปยิง jsonp(url+"?"+params) ซึ่งจะมี
     token ติดไปใน URL แบบดิบ — ต้องกันตรงนี้ก่อนเป็นอันดับแรก */
  (function guardJsonp() {
    var orig = window.jsonp;
    if (typeof orig !== "function" || orig.__mafcGuarded) return;
    function guarded(url, ms) {
      try {
        if (typeof url === "string" && url.indexOf("token=") >= 0) {
          return Promise.reject(new Error("บันทึกไม่สำเร็จ — ลองใหม่อีกครั้ง"));
        }
        /* ขั้น 3: ล็อกอินแล้ว → อ่านผ่าน POST (รหัสอยู่ใน body ไม่ใช่ URL) */
        if (isExec(url) && CFG.token) return readViaPost(url);
      } catch (_) {}
      return orig(url, ms).then(function (d) {
        if (isExec(url) && d && d.ok === false && d.code === "AUTH") markNeedLogin();   /* ด่านอ่านเปิดอยู่ */
        return d;
      });
    }
    guarded.__mafcGuarded = 1;
    window.jsonp = guarded;
  })();

  /* ---------- ขั้น 4: ปิดทางอ่านชีตสาขาตรง (gviz) — ทุกอย่างต้องผ่าน Apps Script ---------- */
  (function killGviz() {
    try {
      if (typeof window.loadLive === "function") window.loadLive = function () { return Promise.resolve([]); };
      if (typeof window.gvizLoad === "function") window.gvizLoad = function () { return Promise.reject(new Error("ปิดการอ่านชีตตรง")); };
    } catch (_) {}
  })();

  function isExec(url) {
    try { return !!CFG.url && typeof url === "string" && url.split("?")[0] === CFG.url; } catch (_) { return false; }
  }
  function queryOf(url) {
    var q = {}, qs = String(url).split("?")[1] || "";
    qs.split("&").forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf("="), k = i < 0 ? kv : kv.slice(0, i), v = i < 0 ? "" : kv.slice(i + 1);
      try { k = decodeURIComponent(k.replace(/\+/g, " ")); v = decodeURIComponent(v.replace(/\+/g, " ")); } catch (_) {}
      if (k && k !== "callback" && k !== "token") q[k] = v;
    });
    return q;
  }
  function readViaPost(url) {
    return post("read", queryOf(url)).then(function (j) {
      if (j && j.ok === false) {
        if (j.code === "AUTH") forceLogout("ออกจากระบบแล้ว — รหัสเปลี่ยนหรือบัญชีถูกปิด");
        else if (j.code === "ROLE") showNeedLogin(j.error || "บทบาทนี้ดูคลังวัสดุไม่ได้");
        throw new Error(j.error || "อ่านข้อมูลไม่สำเร็จ");
      }
      return j;
    });
  }

  /* ---------- แถบ "ต้องเข้าสู่ระบบ" บนหน้าแรก (ด่านอ่านเปิด หรือบทบาทดูคลังไม่ได้) ---------- */
  function markNeedLogin() {
    if (CFG.token) return;
    showNeedLogin("ต้องเข้าสู่ระบบก่อนดูคลังวัสดุ");
  }
  function showNeedLogin(msg) {
    window.__mafcNeedLogin = msg;
    var run = function () {
      var hub = document.getElementById("hub");
      if (!hub) return;
      var box = document.getElementById("mafcNeedLogin");
      if (!box) {
        box = document.createElement("div");
        box.id = "mafcNeedLogin";
        box.className = "mafc-needlogin";
        box.setAttribute("role", "status");
        hub.insertBefore(box, hub.firstChild);
      }
      box.textContent = "";
      var t = document.createElement("span"); t.textContent = msg; box.appendChild(t);
      if (!CFG.token) {
        var b = document.createElement("button"); b.type = "button"; b.className = "btn"; b.textContent = "เข้าสู่ระบบ";
        b.addEventListener("click", function () { openAuthModal(); });
        box.appendChild(b);
      }
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
  }
  function hideNeedLogin() {
    window.__mafcNeedLogin = "";
    var box = document.getElementById("mafcNeedLogin");
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }
  /* โหลดข้อมูลใหม่แบบเดียวกับปุ่ม "บันทึก & โหลด" ของเครื่องยนต์ */
  function refreshData() {
    var tries = 0;
    (function go() {
    try {
      if (typeof loadData !== "function") return;
      /* เครื่องยนต์กำลังโหลดรอบแรกอยู่ (LOADING) → loadData(true) จะถูกข้าม · รอให้จบก่อน */
      if (typeof LOADING !== "undefined" && LOADING && tries++ < 120) { setTimeout(go, 500); return; }
      loadData(true).then(function () {
        try { if (typeof renderHub === "function") renderHub(); } catch (_) {}
        try {
          var app = document.getElementById("app");
          if (app && !app.classList.contains("hidden")) { renderTabs(); renderFilters(); renderList(); renderDH(); }
        } catch (_) {}
      }).catch(function () {});
    } catch (_) {}
    })();
  }

  /* ---------- ล้างแคชทั้งหมด (localStorage + IndexedDB ของ addon p2/fastload)
     addon p2 เปลี่ยนแคช workbook หลักไปอยู่ IndexedDB ชื่อฐาน "mafc_spec"
     (ดู DB_NAME ในสคริปต์นั้น) — ต้องล้างทั้งสองที่ไม่งั้นข้อมูลของบัญชีเดิม/
     คนละสิทธิ์จะยังค้างอยู่ให้เห็นหลัง logout หรือหลังถูกเพิกถอนสิทธิ์ ---------- */
  function clearAllCaches() {
    try { localStorage.removeItem("mafc_cache"); } catch (_) {}
    return new Promise(function (resolve) {
      var done = false;
      function finish() { if (done) return; done = true; resolve(); }
      if (typeof indexedDB === "undefined" || !indexedDB || typeof indexedDB.deleteDatabase !== "function") return finish();
      var req;
      try { req = indexedDB.deleteDatabase("mafc_spec"); } catch (_) { return finish(); }
      try {
        req.onsuccess = finish;
        req.onerror = finish;
        req.onblocked = finish; // ไม่รอค้าง — ถ้ามี connection เดิมค้างอยู่ ปล่อยให้ลบเสร็จเบื้องหลังต่อไป
      } catch (_) { return finish(); }
      setTimeout(finish, 800); // กันเหนียว ไม่ให้ผู้ใช้รอนานเกินไป
    });
  }

  /* ---------- ออกจากระบบแบบบังคับ (ใช้ทั้งตอน boot เจอ AUTH และตอนกลางเซสชัน) ---------- */
  function forceLogout(toastMsg) {
    CFG.token = ""; CFG.user = ""; saveCfg();
    AUTH = null; authState = "out";
    renderChips();
    clearAllCaches();
    if (toastMsg) { try { toast(toastMsg); } catch (_) {} }
  }

  /* ---------- ดักฝั่ง window.fetch ของ "เครื่องยนต์" (เช่น apiWrite) เพื่อจับ
     การหลุดสิทธิ์กลางเซสชัน — ไม่ใช่แค่ตอน boot เท่านั้น
     อ่านจากสำเนา (clone) เสมอ ไม่แตะ body ต้นฉบับที่โค้ดเดิมจะอ่านต่อ ---------- */
  (function guardFetch() {
    if (!origFetch || origFetch.__mafcGuarded) return;
    function wrapped(input, init) {
      var p = origFetch.apply(this, arguments);
      try {
        var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
        var url = typeof input === "string" ? input : ((input && input.url) || "");
        if (method === "POST" && CFG.url && url === CFG.url) {
          p.then(function (res) {
            try {
              var clone = res.clone();
              clone.json().then(function (j) {
                if (j && j.ok === false && j.code === "AUTH") {
                  forceLogout("ออกจากระบบแล้ว — รหัสเปลี่ยนหรือบัญชีถูกปิด");
                }
              }).catch(function () {});
            } catch (_) {}
          }).catch(function () {});
        }
      } catch (_) {}
      return p;
    }
    wrapped.__mafcGuarded = 1;
    window.fetch = wrapped;
  })();

  /* ---------- style ---------- */
  var css = [
    '.mafc-auth-chip{',
    '  --a-bg:#16264A; --a-fg:#EDF1F7; --a-line:#33456F; --a-mut:#9AA7BC; --a-accent:#F59B2C;',
    '  min-height:44px; max-width:150px; display:inline-flex; align-items:center; gap:6px;',
    '  padding:0 13px; border-radius:999px; border:1px solid var(--a-line);',
    '  background:var(--a-bg); color:var(--a-fg); flex:none;',
    '  font-family:var(--sf,"Anuphan",system-ui,sans-serif); font-size:12.5px; font-weight:600;',
    '  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer;',
    '  transition:border-color .18s ease,background .18s ease;',
    '}',
    '.mafc-auth-chip:hover{border-color:var(--a-accent);}',
    '.mafc-auth-chip:focus-visible{outline:2px solid var(--a-accent);outline-offset:2px;}',
    'html.mafc-light .mafc-auth-chip{',
    '  --a-bg:#E7EDF6; --a-fg:#16181D; --a-line:#CFCBBF; --a-mut:#6E737B; --a-accent:#E8820C;',
    '}',
    '@media(max-width:360px){.mafc-auth-chip{max-width:104px;}}',
    '.mafc-auth-modal{--a-bg:#16264A;--a-line:#33456F;}',
    'html.mafc-light .mafc-auth-modal{--a-bg:#E7EDF6;--a-line:#CFCBBF;}',
    /* ปุ่ม/select ของเราต้องกดง่าย ≥44px แม้ระบบเดิมจะกำหนด .btn ไว้ที่ 40px */
    '.mafc-auth-modal button.btn,.mafc-auth-modal button{min-height:44px;}',
    '.mafc-auth-modal select{min-height:44px;}',
    '.mafc-auth-modal h3:focus{outline:0;}',
    '.mafc-auth__err{color:#FF8A6E;font-size:13px;line-height:1.5;margin:8px 0 0;}',
    'html.mafc-light .mafc-auth__err{color:#B4341C;}',
    '.mafc-auth__note{color:#9AA7BC;font-size:12.5px;line-height:1.5;margin-top:10px;}',
    'html.mafc-light .mafc-auth__note{color:#6E737B;}',
    '.mafc-auth__legacy{color:#E8C063;font-size:13px;line-height:1.5;margin:8px 0;}',
    'html.mafc-light .mafc-auth__legacy{color:#8A6A1F;}',
    '.mafc-auth__warn{color:#E8C063;font-size:12px;line-height:1.4;margin-top:4px;}',
    'html.mafc-light .mafc-auth__warn{color:#8A6A1F;}',
    '.mafc-auth__adv{margin-top:14px;font-size:13px;}',
    '.mafc-auth__adv summary{cursor:pointer;font-weight:600;min-height:44px;display:flex;align-items:center;}',
    '.mafc-auth__adv summary:focus-visible{outline:2px solid var(--blue,#4A8BFF);outline-offset:2px;}',
    '.mafc-auth-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;}',
    '.mafc-auth-row input[readonly]{flex:1;min-width:120px;}',
    '.mafc-team-wrap{overflow:auto;max-height:52vh;margin-top:10px;-webkit-overflow-scrolling:touch;}',
    '.mafc-team-wrap table{width:100%;border-collapse:collapse;}',
    /* กฎเดิม .modal th{position:sticky;top:34px} ถูกออกแบบมาคู่กับ .modal h3 ที่ sticky
       เองอยู่แล้ว — เมื่อเรามี scroll container ย่อยของเราเอง (.mafc-team-wrap) ค่า
       top ที่ตั้งมาสำหรับ .modal จะทำให้หัวตารางลอยมาทับปุ่มของแถวแรกที่จอแคบ ปิดมันทิ้ง
       ในขอบเขตของเราเท่านั้น (ไม่แตะ .modal th ของโมดัลอื่นในเครื่องยนต์) */
    '.mafc-team-wrap th{position:static;}',
    '.mafc-team-add{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:flex-end;}',
    '.mafc-team-add .f{display:flex;flex-direction:column;gap:4px;}',
    '.mafc-team-add label{font-size:12.5px;font-weight:600;}',
    /* จอแคบ: ตารางแบบคอลัมน์ (6 คอลัมน์) กว้างเกินจอเสมอ ต่อให้ th ไม่ sticky แล้วก็ตาม
       ปุ่มของแถวแรกจะยังไหลไปอยู่นอกวิวพอร์ตจนต้องเลื่อนแนวนอนถึงจะกดได้ — เปลี่ยนเป็น
       การ์ดเรียงตามแนวตั้งแทน (label ต่อค่า) ปุ่มจึงอยู่ในแนวเดียวกับเนื้อหาเสมอ ไม่ต้อง
       เลื่อนแนวนอนเลยที่ ≤560px */
    '@media(max-width:560px){',
    '  .mafc-team-wrap table,.mafc-team-wrap tbody,.mafc-team-wrap tr,.mafc-team-wrap td{display:block;width:100%;}',
    '  .mafc-team-wrap thead{display:none;}',
    '  .mafc-team-wrap tr{border:1px solid var(--a-line);border-radius:11px;padding:10px 12px;margin-bottom:10px;}',
    '  .mafc-team-wrap td{display:flex;align-items:center;gap:10px;padding:5px 0;border:0!important;}',
    '  .mafc-team-wrap td::before{content:attr(data-label);font-weight:600;font-size:12px;flex:0 0 92px;color:var(--a-fg,inherit);opacity:.7;}',
    '  .mafc-team-wrap td select,.mafc-team-wrap td input{flex:1;min-width:0;}',
    '}',
    /* แถบ "ต้องเข้าสู่ระบบ" บนหน้าแรก + สวิตช์ด่านอ่านของ MD */
    '.mafc-needlogin{--n-bg:#3A2A10;--n-fg:#FCE9C6;--n-line:#8A6A1F;display:flex;align-items:center;gap:12px;flex-wrap:wrap;',
    '  margin:10px 16px;padding:10px 14px;border:1px solid var(--n-line);border-radius:12px;background:var(--n-bg);color:var(--n-fg);',
    '  font-family:var(--sf,"Anuphan",system-ui,sans-serif);font-size:14px;line-height:1.5;}',
    'html.mafc-light .mafc-needlogin{--n-bg:#FFF4DE;--n-fg:#3D2A05;--n-line:#E8C063;}',
    '.mafc-needlogin .btn{min-height:44px;}',
    '.mafc-gate{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0 4px;padding:10px 12px;border:1px solid var(--a-line);border-radius:11px;font-size:13.5px;line-height:1.5;}',
    '@media(prefers-reduced-motion:reduce){.mafc-auth-chip{transition:none!important;}}'
  ].join("\n");

  function injectStyle() {
    if (document.getElementById("mafcAuthCSS")) return;
    var s = document.createElement("style");
    s.id = "mafcAuthCSS";
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ---------- network (POST เท่านั้น — ไม่มี fallback ใด ๆ ที่จะพารหัสหลุดไป URL)
     ใช้ origFetch ตรง ๆ (ไม่ใช่ window.fetch ที่ถูกห่อ) กันไม่ให้คำเรียกของเราเองถูก
     guardFetch() ดักซ้ำ (มันมีไว้ดักฝั่งเครื่องยนต์เท่านั้น) ---------- */
  function post(fn, params) {
    var body = {};
    for (var k in params) if (params.hasOwnProperty(k)) body[k] = params[k];
    body.fn = fn;
    if (!("token" in body)) body.token = CFG.token || "";
    if (!CFG.url || !origFetch) return Promise.reject(new Error("เชื่อมต่อไม่ได้ ลองใหม่"));
    return origFetch(CFG.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); })
      .catch(function () { throw new Error("เชื่อมต่อไม่ได้ ลองใหม่"); });
  }

  function saveCfg() {
    try { localStorage.setItem("mafc_cfg", JSON.stringify(CFG)); } catch (_) {}
  }

  /* ---------- แปลงวันที่แบบปลอดภัยข้ามเบราว์เซอร์ ----------
     เซิร์ฟเวอร์ส่งวันที่เป็นสตริง 'yyyy-MM-dd HH:mm:ss' — Safari ตีความ
     new Date('yyyy-MM-dd HH:mm:ss') (มีช่องว่าง) เป็น Invalid Date ต้องแทน
     ช่องว่างด้วย 'T' ก่อน parse และถ้ายัง parse ไม่ได้ให้โชว์สตริงดิบแทน
     การขึ้น "Invalid Date" ให้ผู้ใช้เห็น ---------- */
  function safeParseDate(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") { var dn = new Date(v); return isNaN(dn.getTime()) ? null : dn; }
    var s = String(v).trim();
    if (!s) return null;
    var iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(" ", "T") : s;
    var d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDateLike(v) {
    if (v == null || v === "") return "—";
    var d = safeParseDate(v);
    if (d) { try { return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" }); } catch (_) {} }
    return String(v); // parse ไม่ได้ — โชว์ดิบตามที่เซิร์ฟเวอร์ส่งมา ดีกว่าขึ้น Invalid Date
  }

  /* ---------- chip ---------- */
  function chipLabel() {
    if (authState === "in" && AUTH) return (AUTH.name || AUTH.uid) + " · " + roleTH(AUTH.role);
    if (authState === "checking") return "กำลังตรวจสอบ…";
    return "เข้าสู่ระบบ";
  }
  function renderChips() {
    var label = chipLabel();
    var nodes = document.querySelectorAll(".mafc-auth-chip");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = label;
      nodes[i].setAttribute("data-auth", authState);
      nodes[i].setAttribute("aria-label", authState === "in" ? "บัญชี: " + label + " — เปิดการตั้งค่าบัญชี" : "เข้าสู่ระบบ");
    }
  }
  function makeChip() {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "mafc-auth-chip";
    b.setAttribute("data-auth", authState);
    b.textContent = chipLabel();
    b.addEventListener("click", function (e) { e.stopPropagation(); openAuthModal(); });
    return b;
  }
  function insertChips() {
    var targets = [];
    var hubWrap = document.querySelector('.hubtop > div[style*="display:flex"]:last-of-type');
    if (hubWrap) targets.push(hubWrap);
    var appWrap = document.querySelector('.apptop .row > div[style*="margin-left"]');
    if (appWrap) targets.push(appWrap);
    targets.forEach(function (w) {
      if (!w || w.querySelector(".mafc-auth-chip")) return;
      var chip = makeChip();
      var burger = w.querySelector(".mafc-burger");
      if (burger) w.insertBefore(chip, burger); else w.appendChild(chip);
    });
    renderChips();
  }
  // ต้องรอให้กลไก hamburger-drawer ของเครื่องยนต์ (ย้ายปุ่มเข้า drawer แล้วเติมปุ่ม
  // burger) ทำงานที่ DOMContentLoaded ก่อน ไม่งั้น chip ของเราจะโดนกวาดเข้า drawer
  // ไปด้วย (เพราะมันเลือกทุก button/a ใน wrap เดิม) — สคริปต์นี้เป็น defer จึงรันก่อน
  // DOMContentLoaded เสมอ ฉะนั้นลงทะเบียน listener ไว้เฉย ๆ ก็เพียงพอให้อยู่หลังคิว
  if (document.readyState === "complete") insertChips();
  else document.addEventListener("DOMContentLoaded", insertChips);

  /* ---------- คืนโฟกัสให้เมนสุ่มไม่หลุดไปที่ <body> ทุกครั้งที่ modal() วาดใหม่ ---------- */
  function focusEl(el) {
    if (!el) return;
    try {
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      el.focus({ preventScroll: true });
    } catch (_) {}
  }
  function focusModalHeading() { focusEl(document.querySelector("#modalHost .mafc-auth-modal h3")); }

  /* ---------- modal: เข้าสู่ระบบ ---------- */
  function renderLoginModal(errMsg) {
    modal(
      '<div class="mafc-auth-modal"><h3 class="mafc-auth">เข้าสู่ระบบ</h3>' +
      '<div class="f full">' +
      '  <label for="mafcCode">รหัสส่วนตัว</label>' +
      '  <input id="mafcCode" type="password" autocomplete="off" autocapitalize="characters" class="mono" placeholder="ABCD-EFGH-JKMN"/>' +
      '</div>' +
      (errMsg ? '<p id="mafcLoginErr" class="mafc-auth__err" role="alert">' + esc(errMsg) + '</p>' : '<p id="mafcLoginErr" class="mafc-auth__err" role="alert" hidden></p>') +
      '<div class="mrow"><button type="button" class="btn ghost mclose">ปิด</button><button type="button" class="btn" id="mafcLoginBtn">เข้าสู่ระบบ</button></div>' +
      '<p class="mafc-auth__note">รหัสส่วนตัวขอได้จากผู้ดูแลระบบ (MD) — ใช้แทนกุญแจเดิมที่เคยใช้ร่วมกันทั้งทีม</p>' +
      '<details class="mafc-auth__adv"><summary>ขั้นสูง</summary>' +
      '  <div class="f full" style="margin-top:8px"><label for="mafcAdvUrl">Apps Script Web App URL (.../exec)</label>' +
      '  <input id="mafcAdvUrl" class="mono" value="' + esc(CFG.url) + '"/></div>' +
      '  <div class="mrow"><button type="button" class="btn ghost" id="mafcAdvSave">บันทึก URL</button></div>' +
      '</details></div>'
    );
    focusModalHeading();
    var codeEl = document.getElementById("mafcCode");
    var errEl = document.getElementById("mafcLoginErr");
    var btn = document.getElementById("mafcLoginBtn");
    function showErr(msg) { errEl.textContent = msg; errEl.hidden = !msg; }
    function doLogin() {
      // ส่งค่าดิบ (trim อย่างเดียว ไม่ toUpperCase) — เซิร์ฟเวอร์เป็นฝ่าย normalise
      // รหัสส่วนตัว (ไม่สนตัวพิมพ์) เอง ส่วนกุญแจเดิม (legacy) เทียบตัวพิมพ์ตรงตัว
      var raw = (codeEl.value || "").trim();
      if (!raw) { showErr("กรุณากรอกรหัสส่วนตัว"); return; }
      btn.disabled = true;
      post("me", { token: raw }).then(function (res) {
        btn.disabled = false;
        if (res && res.ok) {
          CFG.token = raw; CFG.user = res.data.uid; saveCfg();
          AUTH = res.data; authState = "in";
          closeModal(); renderChips(); hideNeedLogin();
          toast("เข้าสู่ระบบแล้ว");
          refreshData();
        } else if (res && res.code === "AUTH") {
          showErr("รหัสไม่ถูกต้อง หรือบัญชีถูกปิด");
        } else {
          showErr((res && res.error) ? String(res.error) : "เชื่อมต่อไม่ได้ ลองใหม่");
        }
      }).catch(function () {
        btn.disabled = false;
        showErr("เชื่อมต่อไม่ได้ ลองใหม่");
      });
    }
    btn.onclick = doLogin;
    codeEl.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); doLogin(); } });
    var advSave = document.getElementById("mafcAdvSave");
    advSave.onclick = function () {
      var advUrl = document.getElementById("mafcAdvUrl");
      CFG.url = (advUrl.value || "").trim();
      saveCfg();
      toast("บันทึก URL แล้ว");
    };
  }

  /* ---------- modal: บัญชีของฉัน (login แล้ว) ---------- */
  function renderAccountModal() {
    var legacyHTML = "";
    if (AUTH.legacy) {
      var dTxt = fmtDateLike(AUTH.legacyUntil);
      legacyHTML = '<p class="mafc-auth__legacy">กุญแจเดิม ใช้ได้ถึง ' + esc(dTxt) + ' — แนะนำให้ขอรหัสส่วนตัวจากผู้ดูแลระบบแทน</p>';
    }
    modal(
      '<div class="mafc-auth-modal"><h3 class="mafc-auth">บัญชีของฉัน</h3>' +
      '<p>' + esc(AUTH.name || AUTH.uid) + ' · ' + esc(roleTH(AUTH.role)) + '</p>' +
      legacyHTML +
      '<div class="mrow">' +
      (AUTH.role === "MD" ? '<button type="button" class="btn ghost" id="mafcTeamBtn">จัดการทีม</button>' : '') +
      '<button type="button" class="btn ghost" id="mafcLogoutBtn">ออกจากระบบ</button>' +
      '<button type="button" class="btn ghost mclose">ปิด</button>' +
      '</div></div>'
    );
    focusModalHeading();
    var logoutBtn = document.getElementById("mafcLogoutBtn");
    logoutBtn.onclick = function () {
      CFG.token = ""; CFG.user = ""; saveCfg();
      clearAllCaches().then(function () { location.reload(); });
    };
    var teamBtn = document.getElementById("mafcTeamBtn");
    if (teamBtn) teamBtn.onclick = openTeamModal;
  }

  /* ---------- modal: จัดการทีม (MD เท่านั้น) ---------- */
  function openTeamModal() {
    var pending = {};       // uid -> 'issue' | 'revoke'  (ขอ confirm ก่อนยิงจริง)
    var justIssued = {};    // uid -> code ที่เพิ่งออก (แสดงครั้งเดียว ไม่เก็บถาวร หายเมื่อปิด/เปิดโมดัลใหม่)
    var list = [];
    var errMsg = "";         // เก็บ error ไว้ใน state เอง ไม่ให้ paint() ทับหาย
    var addForm = { uid: "", name: "", role: "CUS" }; // ค่าที่พิมพ์ในฟอร์มเพิ่มคน — คงไว้แม้ paint ใหม่ตอน error
    var focusHint = null;    // css selector ที่จะพยายามคืนโฟกัสให้หลัง paint() รอบถัดไป
    var gate = null, gatePending = false, gateWarn = "";   // ด่านอ่าน (null = ยังไม่รู้ / เซิร์ฟเวอร์เก่า)

    function gateHTML() {
      if (gate === null) return "";
      if (gatePending) {
        return '<div class="mafc-gate" id="mafcGate"><span>เปิดด่านแล้ว คนที่ยังไม่มีรหัสส่วนตัวจะดูคลังวัสดุไม่ได้ — ทีมมีรหัสครบแล้วใช่ไหม?</span>' +
          '<button type="button" class="btn" data-gate="yes">ยืนยันเปิดด่าน</button>' +
          '<button type="button" class="btn ghost" data-gate="no">ยกเลิก</button></div>';
      }
      return '<div class="mafc-gate" id="mafcGate"><span>ด่านอ่านคลังวัสดุ: <b>' + (gate ? 'เปิดอยู่' : 'ปิดอยู่') + '</b> — ' +
        (gate ? 'ต้องเข้าสู่ระบบก่อนดูคลัง' : 'ใครมีลิงก์ก็ดูคลังได้') + '</span>' +
        '<button type="button" class="btn ghost" data-gate="toggle">' + (gate ? 'ปิดด่าน' : 'เปิดด่าน') + '</button>' +
        (gateWarn ? '<p class="mafc-auth__warn" role="status" style="flex-basis:100%;margin:0">' + esc(gateWarn) + '</p>' : '') + '</div>';
    }

    function actionsHTML(u) {
      if (justIssued[u.uid]) {
        return '<div class="mafc-auth-row">' +
          '<input class="mono" readonly id="mafcCodeShow_' + esc(u.uid) + '" value="' + esc(justIssued[u.uid]) + '"/>' +
          '<button type="button" class="btn ghost" data-act="copy" data-uid="' + esc(u.uid) + '">คัดลอก</button>' +
          '</div><div class="mafc-auth__warn">รหัสนี้จะแสดงครั้งเดียว — ส่งให้เจ้าตัวทางช่องทางส่วนตัว</div>';
      }
      if (pending[u.uid] === "issue") {
        return 'ยืนยันออกรหัสใหม่ให้ ' + esc(u.name || u.uid) + '? ' +
          '<button type="button" class="btn" data-act="issue-yes" data-uid="' + esc(u.uid) + '">ยืนยัน</button> ' +
          '<button type="button" class="btn ghost" data-act="cancel" data-uid="' + esc(u.uid) + '">ยกเลิก</button>';
      }
      if (pending[u.uid] === "revoke") {
        return 'ยืนยันปิดบัญชี ' + esc(u.name || u.uid) + '? ' +
          '<button type="button" class="btn" data-act="revoke-yes" data-uid="' + esc(u.uid) + '">ยืนยัน</button> ' +
          '<button type="button" class="btn ghost" data-act="cancel" data-uid="' + esc(u.uid) + '">ยกเลิก</button>';
      }
      return '<button type="button" class="btn ghost" data-act="issue" data-uid="' + esc(u.uid) + '">ออกรหัสใหม่</button> ' +
        '<button type="button" class="btn ghost" data-act="revoke" data-uid="' + esc(u.uid) + '"' + (u.active ? "" : " disabled") + '>ปิดบัญชี</button>';
    }
    function roleSelectHTML(u) {
      var opts = ["MD", "PM", "CM", "CUS"].map(function (r) {
        return '<option value="' + r + '"' + (r === u.role ? " selected" : "") + '>' + esc(roleTH(r)) + '</option>';
      }).join("");
      return '<select class="mafc-team-role" data-uid="' + esc(u.uid) + '" aria-label="บทบาทของ ' + esc(u.uid) + '">' + opts + '</select>';
    }
    function rowsHTML() {
      return list.map(function (u) {
        return '<tr>' +
          '<td class="mono" data-label="uid">' + esc(u.uid) + '</td>' +
          '<td data-label="ชื่อ">' + esc(u.name || "") + '</td>' +
          '<td data-label="บทบาท">' + roleSelectHTML(u) + '</td>' +
          '<td data-label="สถานะ">' + (u.active ? "ใช้งาน" : "ปิดแล้ว") + '</td>' +
          '<td class="mono" data-label="ออกรหัสล่าสุด">' + esc(fmtDateLike(u.issuedAt)) + '</td>' +
          '<td data-label="การจัดการ">' + actionsHTML(u) + '</td>' +
          '</tr>';
      }).join("");
    }
    function tableHTML() {
      return '<div class="mafc-team-wrap"><table id="mafcTeamTable">' +
        '<thead><tr><th>uid</th><th>ชื่อ</th><th>บทบาท</th><th>สถานะ</th><th>ออกรหัสล่าสุด</th><th>การจัดการ</th></tr></thead>' +
        '<tbody>' + rowsHTML() + '</tbody></table></div>';
    }
    function addFormHTML() {
      return '<div class="mafc-team-add">' +
        '<div class="f"><label for="mafcAddUid">uid</label><input id="mafcAddUid" class="mono" style="width:110px" value="' + esc(addForm.uid) + '"/></div>' +
        '<div class="f"><label for="mafcAddName">ชื่อ</label><input id="mafcAddName" style="width:160px" value="' + esc(addForm.name) + '"/></div>' +
        '<div class="f"><label for="mafcAddRole">บทบาท</label><select id="mafcAddRole" aria-label="บทบาทของคนที่จะเพิ่ม">' +
        ["MD", "PM", "CM", "CUS"].map(function (r) { return '<option value="' + r + '"' + (r === addForm.role ? " selected" : "") + '>' + esc(roleTH(r)) + '</option>'; }).join("") +
        '</select></div>' +
        '<button type="button" class="btn" id="mafcAddBtn">เพิ่มคน</button>' +
        '</div>';
    }
    function paint() {
      modal(
        '<div class="mafc-auth-modal"><h3 class="mafc-auth">จัดการทีม</h3>' +
        (errMsg ? '<p id="mafcTeamErr" class="mafc-auth__err" role="alert">' + esc(errMsg) + '</p>' : '<p id="mafcTeamErr" class="mafc-auth__err" role="alert" hidden></p>') +
        gateHTML() + tableHTML() + addFormHTML() +
        '<div class="mrow"><button type="button" class="btn ghost mclose">ปิด</button></div></div>'
      );
      wire();
      var target = null;
      if (focusHint) { try { target = document.querySelector(focusHint); } catch (_) { target = null; } }
      focusEl(target || document.querySelector("#modalHost .mafc-auth-modal h3"));
      focusHint = null;
    }
    function showErr(msg) { errMsg = msg || ""; }
    function reload() {
      post("gateGet", { token: CFG.token }).then(function (g) {
        var v = (g && g.ok && g.data) ? !!g.data.on : null;
        if (v !== gate) { gate = v; paint(); }
      }).catch(function () {});
      return post("teamList", { token: CFG.token }).then(function (res) {
        if (res && res.ok) { list = res.data || []; showErr(""); }
        else showErr((res && res.error) ? String(res.error) : "โหลดรายชื่อทีมไม่สำเร็จ");
        paint();
      }).catch(function () { showErr("เชื่อมต่อไม่ได้ ลองใหม่"); paint(); });
    }
    function wire() {
      var gbox = document.getElementById("mafcGate");
      if (gbox) gbox.addEventListener("click", function (e) {
        var b = e.target.closest("[data-gate]");
        if (!b) return;
        var a = b.getAttribute("data-gate");
        if (a === "toggle" && !gate) { gatePending = true; focusHint = '[data-gate="yes"]'; paint(); return; }
        if (a === "no") { gatePending = false; focusHint = '[data-gate="toggle"]'; paint(); return; }
        var on = a === "yes";
        gatePending = false;
        post("gateSet", { token: CFG.token, on: on }).then(function (res) {
          if (res && res.ok) { gate = !!res.data.on; gateWarn = (res.data && res.data.warn) ? String(res.data.warn) : ""; showErr(""); toast(gate ? "เปิดด่านอ่านแล้ว" : "ปิดด่านอ่านแล้ว"); }
          else showErr((res && res.error) || "เปลี่ยนด่านอ่านไม่สำเร็จ");
          focusHint = '[data-gate="toggle"]'; paint();
        }).catch(function () { showErr("เชื่อมต่อไม่ได้ ลองใหม่"); paint(); });
      });
      var table = document.getElementById("mafcTeamTable");
      if (table) {
        table.addEventListener("change", function (e) {
          var sel = e.target.closest(".mafc-team-role");
          if (!sel) return;
          var uid = sel.getAttribute("data-uid"), role = sel.value;
          focusHint = '.mafc-team-role[data-uid="' + uid + '"]';
          post("teamRole", { token: CFG.token, uid: uid, role: role }).then(function (res) {
            if (res && res.ok) { showErr(""); return reload(); }
            showErr((res && res.error) || "เปลี่ยนบทบาทไม่สำเร็จ"); paint();
          }).catch(function () { showErr("เชื่อมต่อไม่ได้ ลองใหม่"); paint(); });
        });
        table.addEventListener("click", function (e) {
          var b = e.target.closest("[data-act]");
          if (!b) return;
          var act = b.getAttribute("data-act"), uid = b.getAttribute("data-uid");
          if (act === "issue") { pending[uid] = "issue"; focusHint = '[data-act="issue-yes"][data-uid="' + uid + '"]'; paint(); return; }
          if (act === "revoke") { pending[uid] = "revoke"; focusHint = '[data-act="revoke-yes"][data-uid="' + uid + '"]'; paint(); return; }
          if (act === "cancel") { delete pending[uid]; focusHint = '[data-act="issue"][data-uid="' + uid + '"]'; paint(); return; }
          if (act === "copy") {
            var input = document.getElementById("mafcCodeShow_" + uid);
            var val = input ? input.value : "";
            try { navigator.clipboard && navigator.clipboard.writeText(val); toast("คัดลอกแล้ว"); }
            catch (_) { }
            return;
          }
          if (act === "issue-yes") {
            delete pending[uid];
            post("teamIssue", { token: CFG.token, uid: uid }).then(function (res) {
              if (res && res.ok) {
                justIssued[uid] = res.data.code;
                // ถ้า MD ออกรหัสใหม่ให้ "ตัวเอง" ต้องสลับ token ที่ใช้อยู่ตามไปด้วย
                // ไม่งั้นรหัสเดิมที่ถืออยู่จะใช้ไม่ได้อีกต่อไปและโดนล็อกตัวเองออก
                if (uid === CFG.user) { CFG.token = res.data.code; saveCfg(); }
                showErr("");
                focusHint = "#mafcCodeShow_" + uid;
                return reload();
              }
              showErr((res && res.error) || "ออกรหัสไม่สำเร็จ"); paint();
            }).catch(function () { showErr("เชื่อมต่อไม่ได้ ลองใหม่"); paint(); });
            return;
          }
          if (act === "revoke-yes") {
            delete pending[uid];
            focusHint = '.mafc-team-role[data-uid="' + uid + '"]';
            post("teamRevoke", { token: CFG.token, uid: uid }).then(function (res) {
              if (res && res.ok) { showErr(""); return reload(); }
              showErr((res && res.error) || "ปิดบัญชีไม่สำเร็จ"); paint();
            }).catch(function () { showErr("เชื่อมต่อไม่ได้ ลองใหม่"); paint(); });
            return;
          }
        });
      }
      var addBtn = document.getElementById("mafcAddBtn");
      if (addBtn) addBtn.onclick = function () {
        var uid = (document.getElementById("mafcAddUid").value || "").trim();
        var name = (document.getElementById("mafcAddName").value || "").trim();
        var role = document.getElementById("mafcAddRole").value;
        addForm.uid = uid; addForm.name = name; addForm.role = role; // จำค่าไว้ก่อนยิง เผื่อ error จะได้ไม่ต้องพิมพ์ใหม่
        if (!uid) { showErr("กรุณากรอก uid"); focusHint = "#mafcAddUid"; paint(); return; }
        post("teamAdd", { token: CFG.token, uid: uid, name: name, role: role }).then(function (res) {
          if (!(res && res.ok)) { showErr((res && res.error) || "เพิ่มคนไม่สำเร็จ"); focusHint = "#mafcAddUid"; paint(); return; }
          addForm = { uid: "", name: "", role: "CUS" }; // สำเร็จแล้วค่อยล้างฟอร์ม พร้อมรับคนถัดไป
          showErr("");
          focusHint = "#mafcAddUid";
          return reload();
        }).catch(function () { showErr("เชื่อมต่อไม่ได้ ลองใหม่"); focusHint = "#mafcAddUid"; paint(); });
      };
    }
    paint();
    reload();
  }

  /* ---------- เปิดโมดัลของเรา (แทนที่ openSettings ของเครื่องยนต์) ---------- */
  function openAuthModal() {
    if (authState === "in" && AUTH) renderAccountModal();
    else renderLoginModal();
  }

  /* ---------- ดักคลิกปุ่มตั้งค่าของเครื่องยนต์ตั้งแต่ช่วง capture
     (ก่อนที่ .onclick=openSettings ของเครื่องยนต์จะทำงาน) ---------- */
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target.closest("#btnSettings,#btnSettings2") : null;
    if (!t) return;
    e.stopPropagation();
    e.preventDefault();
    try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch (_) {}
    openAuthModal();
  }, true);

  /* ---------- boot ---------- */
  function boot() {
    injectStyle();
    if (CFG.token && CFG.url) {
      authState = "checking"; renderChips();
      post("me", { token: CFG.token }).then(function (res) {
        if (res && res.ok) {
          AUTH = res.data; authState = "in"; hideNeedLogin();
          try { if (typeof MODE === "undefined" || MODE !== "apps") refreshData(); } catch (_) { refreshData(); }
        } else if (res && res.code === "AUTH") {
          forceLogout();
        } else if (res && res.code === "BUSY") {
          // ระบบไม่ว่างชั่วคราว — ไม่ใช่ปัญหาเรื่องสิทธิ์ ห้าม logout เด็ดขาด แค่แจ้งเตือน
          try { toast((res && res.error) || "ระบบไม่ว่าง ลองใหม่อีกครั้ง"); } catch (_) {}
        } else {
          // เซิร์ฟเวอร์รุ่นเก่าที่ไม่รู้จักคำสั่ง หรือ error อื่นที่ไม่ใช่ AUTH/BUSY — เก็บ token ไว้ก่อน
          // ไม่ auto-logout และไม่ต้องโชว์อะไรเพิ่ม (คงสถานะกลาง ๆ ไว้)
        }
        renderChips();
      }).catch(function () {
        // เครือข่ายมีปัญหา — เก็บ token ไว้ คงสถานะกลาง ๆ ไว้เช่นกัน
        renderChips();
      });
    } else {
      authState = "out"; renderChips();
      /* ยังไม่ล็อกอิน: ถามเซิร์ฟเวอร์ว่าด่านอ่านเปิดไหม (คำขออ่านแรกของเครื่องยนต์อาจยิงไปก่อน addon นี้โหลด) */
      if (CFG.url) post("status", {}).then(function (r) { if (r && r.ok && r.data && r.data.gate) markNeedLogin(); }).catch(function () {});
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.__mafcAuthState = function () { return { state: authState, auth: AUTH }; };
})();
