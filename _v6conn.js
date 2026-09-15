/* =========================================================================
   MA.FC CENTRAL SPEC — addon p6 : สถานะการเชื่อมต่อ
   -------------------------------------------------------------------------
   ไม่แตะเครื่องยนต์เดิมแม้แต่บรรทัดเดียว (กฏเหล็กข้อ 1)
   แก้สองอาการที่ผู้ใช้เจอจริง
     1) ตอนโหลด หน้าขึ้น "โหมดสำเนา (ข้อมูลฝังในแอป)" ค้างได้ถึง ~25 วินาที
        (รอบเย็นของ Apps Script V4.00) ผู้ใช้เข้าใจว่าเว็บพัง
     2) การเรียก projectsList ที่ยังไม่มีกุญแจ เด้งข้อความ error ดิบ
        ทั้งที่การ "ดูรายการวัสดุ" ใช้งานได้ปกติ
   สี/ฟอนต์อ้างอิง design-system/mafc-central-spec/MASTER.md §3 §4
   ========================================================================= */
(function () {
  "use strict";
  if (window.__mafcConnP6) return;
  window.__mafcConnP6 = 1;

  var GRACE_MS = 30000;                       // เกินนี้ถือว่าต่อไม่ติดจริง
  var RE_LIVE  = /เชื่อมต่อชีตแบบสด/;
  var RE_COPY  = /โหมดสำเนา/;
  var RE_KEY   = /ตรวจการตั้งค่าปุ่มเฟือง/;   // ข้อความ error ของฝั่งเซิร์ฟเวอร์

  var t0        = Date.now();
  var state     = "connecting";               // connecting | live | readonly | offline
  var tailText  = "";                         // ส่วนหางของข้อความเดิม เช่น "· คลิกเพื่อเข้าดูรายการ"
  var painting  = false;
  var tick      = null;

  /* ---------- style ---------- */
  var css = [
    '.mafc-conn{',
    '  --c-bg:#16264A; --c-fg:#EDF1F7; --c-mut:#9AA7BC;',
    '  --c-ok:#4FD08A; --c-warn:#F59B2C; --c-line:#33456F;',
    '  display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap;',
    '  font-family:var(--sf,"Anuphan",system-ui,sans-serif); font-size:13px; line-height:1.4;',
    '  color:var(--c-fg);',
    '}',
    'html.mafc-light .mafc-conn{',
    '  --c-bg:#E7EDF6; --c-fg:#16181D; --c-mut:#6E737B;',
    '  --c-ok:#1E7A4C; --c-warn:#E8820C; --c-line:#CFCBBF;',
    '}',
    '.mafc-conn__pill{display:inline-flex;align-items:center;gap:7px;',
    '  background:var(--c-bg);border:1px solid var(--c-line);border-radius:999px;',
    '  padding:5px 12px;}',
    '.mafc-conn__dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--c-mut)}',
    '.mafc-conn[data-s="live"]     .mafc-conn__dot{background:var(--c-ok)}',
    '.mafc-conn[data-s="readonly"] .mafc-conn__dot{background:var(--c-warn)}',
    '.mafc-conn[data-s="offline"]  .mafc-conn__dot{background:var(--c-warn)}',
    '.mafc-conn[data-s="connecting"] .mafc-conn__dot{background:var(--c-warn);animation:mafcConnPulse 1.4s ease-in-out infinite}',
    '@keyframes mafcConnPulse{0%,100%{opacity:1}50%{opacity:.35}}',
    '@media (prefers-reduced-motion:reduce){.mafc-conn__dot{animation:none!important}}',
    '.mafc-conn__label{font-weight:600}',
    '.mafc-conn__note{color:var(--c-mut);font-size:12px}',
    '.mafc-conn__num{font-family:var(--mono,"IBM Plex Mono",ui-monospace,monospace);',
    '  font-variant-numeric:tabular-nums;font-size:12px;color:var(--c-mut)}',
    '.mafc-conn__act{min-height:44px;display:inline-flex;align-items:center;gap:6px;',
    '  background:transparent;border:1px solid var(--c-line);border-radius:8px;',
    '  color:var(--c-fg);font-family:inherit;font-size:12.5px;font-weight:600;',
    '  padding:0 14px;cursor:pointer;transition:background .18s ease,border-color .18s ease}',
    '.mafc-conn__act:hover{background:var(--c-bg);border-color:var(--c-warn)}',
    '.mafc-conn__act:focus-visible{outline:2px solid var(--c-warn);outline-offset:2px}',
    '.mafc-keyhint{display:block;font-size:13px;line-height:1.5;color:var(--c-mut,#9AA7BC)}',
    '@media print{.mafc-conn__act{display:none}}'
  ].join("\n");

  function injectStyle() {
    if (document.getElementById("mafcConnCSS")) return;
    var s = document.createElement("style");
    s.id = "mafcConnCSS";
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ---------- helpers ---------- */
  function secs() { return Math.max(0, Math.round((Date.now() - t0) / 1000)); }

  function openSettings() {
    var b = document.getElementById("btnSettings") || document.getElementById("btnSettings2");
    if (b) b.click();
  }

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  /* ---------- render ---------- */
  function paint() {
    var p = document.getElementById("hubStatus");
    if (!p) return;
    painting = true;

    var wrap = el("span", "mafc-conn");
    wrap.setAttribute("role", "status");
    wrap.setAttribute("aria-live", "polite");
    wrap.setAttribute("data-s", state);

    var pill = el("span", "mafc-conn__pill");
    pill.appendChild(el("span", "mafc-conn__dot"));

    var label = el("span", "mafc-conn__label");
    pill.appendChild(label);
    wrap.appendChild(pill);

    if (state === "connecting") {
      label.textContent = "กำลังต่อชีตแบบสด";
      pill.appendChild(el("span", "mafc-conn__num", secs() + " วิ"));
      wrap.appendChild(el("span", "mafc-conn__note",
        "ระหว่างนี้ดูข้อมูลสำเนาไปก่อนได้ · ครั้งแรกของวันนานได้ถึง 25 วินาที"));
    } else if (state === "live") {
      label.textContent = "ต่อชีตแล้ว · ข้อมูลล่าสุด";
      if (tailText) wrap.appendChild(el("span", "mafc-conn__note", tailText));
    } else if (state === "readonly") {
      label.textContent = "ต่อชีตแล้ว · ดูอย่างเดียว";
      wrap.appendChild(el("span", "mafc-conn__note",
        "ยังไม่ได้ใส่กุญแจในเครื่องนี้ จึงยังเพิ่ม/แก้/ลบ ไม่ได้"));
      var b1 = el("button", "mafc-conn__act", "ใส่กุญแจที่ ตั้งค่า");
      b1.type = "button";
      b1.setAttribute("aria-label", "เปิดหน้าตั้งค่าเพื่อใส่กุญแจสำหรับแก้ข้อมูล");
      b1.addEventListener("click", openSettings);
      wrap.appendChild(b1);
    } else {
      label.textContent = "ยังต่อชีตไม่ได้ · แสดงข้อมูลสำเนา";
      wrap.appendChild(el("span", "mafc-conn__note",
        "ข้อมูลที่เห็นอาจไม่ใช่ล่าสุด — ลองโหลดใหม่อีกครั้ง"));
      var b2 = el("button", "mafc-conn__act", "โหลดใหม่");
      b2.type = "button";
      b2.setAttribute("aria-label", "โหลดหน้าใหม่เพื่อลองต่อชีตอีกครั้ง");
      b2.addEventListener("click", function () { location.reload(); });
      wrap.appendChild(b2);
    }

    p.textContent = "";
    p.appendChild(wrap);
    painting = false;
  }

  /* ---------- อ่านสถานะจากข้อความที่เครื่องยนต์เขียน ---------- */
  function readEngine() {
    var p = document.getElementById("hubStatus");
    if (!p) return;
    if (p.querySelector(".mafc-conn")) return;      // ของเราอยู่แล้ว ไม่มีอะไรใหม่

    var txt = (p.textContent || "").trim();
    if (!txt) return;

    if (RE_LIVE.test(txt)) {
      state = (state === "readonly") ? "readonly" : "live";
      var cut = txt.indexOf("·");
      tailText = cut >= 0 ? txt.slice(cut).trim() : "";
      stopTick();
    } else if (RE_COPY.test(txt)) {
      state = (Date.now() - t0 > GRACE_MS) ? "offline" : "connecting";
      startTick();
    }
    paint();
  }

  function startTick() {
    if (tick) return;
    tick = setInterval(function () {
      if (state !== "connecting") { stopTick(); return; }
      if (Date.now() - t0 > GRACE_MS) { state = "offline"; stopTick(); }
      paint();
    }, 1000);
  }
  function stopTick() { if (tick) { clearInterval(tick); tick = null; } }

  /* ---------- แปลงข้อความ error เรื่องกุญแจให้อ่านรู้เรื่อง ---------- */
  function softenKeyError(root) {
    if (!root || root.nodeType !== 1) return;
    var list = root.querySelectorAll ? root.querySelectorAll("*") : [];
    var all = [root].concat(Array.prototype.slice.call(list));
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.children && n.children.length) continue;      // เอาเฉพาะใบสุดท้าย
      var t = n.textContent || "";
      if (!RE_KEY.test(t)) continue;
      n.classList.add("mafc-keyhint");
      n.textContent = "ยังไม่ได้ใส่กุญแจในเครื่องนี้ — ดูรายการวัสดุได้ตามปกติ แต่ยังเพิ่ม/แก้/ลบ ไม่ได้ กดปุ่ม ตั้งค่า เพื่อใส่กุญแจ";
      if (state === "live" || state === "connecting") { state = "readonly"; paint(); }
      else { state = "readonly"; }
    }
  }

  /* ---------- boot ---------- */
  function boot() {
    injectStyle();
    readEngine();
    if (state === "connecting") { paint(); startTick(); }

    var p = document.getElementById("hubStatus");
    if (p) {
      new MutationObserver(function () {
        if (painting) return;
        readEngine();
      }).observe(p, { childList: true, characterData: true, subtree: true });
    }

    new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) {
        var added = recs[i].addedNodes;
        for (var j = 0; j < added.length; j++) softenKeyError(added[j]);
      }
    }).observe(document.body, { childList: true, subtree: true });

    softenKeyError(document.body);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.__mafcConn = function () {
    return { state: state, elapsed: secs() };
  };
})();
