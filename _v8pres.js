/* =========================================================================
   MA.FC CENTRAL SPEC — addon p8 : ลิงก์นำเสนอลูกค้า (ขั้น 5)
   -------------------------------------------------------------------------
   ไม่แตะเครื่องยนต์เดิม — ทับฟังก์ชัน sharePresLink(p) (global) ด้วยตัวที่:
     1) ถามก่อนว่าจะ "แสดงราคา" ในลิงก์ไหม (ค่าเริ่มต้น = ไม่แสดง)
     2) ส่งเฉพาะช่องที่หน้านำเสนอต้องใช้ (ห้ามก่อน) — เบอร์เซลล์ / ค่าแรง / วันที่ราคา
        ไม่ออกไปในลิงก์เลย · ราคาออกไปเฉพาะเมื่อเลือก "แสดงราคา"
     3) เปิดลิงก์แบบซ่อนราคา → การ์ด "มูลค่ารวมโดยประมาณ" ขึ้นว่าไม่แสดงราคา แทนเลข 0
   ข้อมูลในลิงก์ถอดอ่านได้ (base64) — จึงต้องตัดที่ต้นทาง ไม่ใช่แค่ซ่อนตอนแสดง
   ========================================================================= */
(function () {
  "use strict";
  if (window.__mafcPresP8) return;
  window.__mafcPresP8 = 1;

  var ITEM_KEEP = ["iid", "catId", "catCode", "catName", "section", "mainCode", "code", "desc", "size", "brand",
    "grade", "link", "img", "location", "qty", "unit", "a1", "a2", "roof", "note"];

  function pick(o, keys) {
    var out = {};
    keys.forEach(function (k) { if (o && o[k] != null && o[k] !== "") out[k] = o[k]; });
    return out;
  }
  function payload(p, showPrice) {
    var items = (p.items || []).map(function (it) {
      var x = pick(it, ITEM_KEEP);
      if (showPrice && it && it.price != null && it.price !== "") x.price = it.price;
      return x;
    });
    var obj = { name: p.name, stage: p.stage, cover: p.cover || {}, rooms: p.rooms || [], items: items };
    if (!showPrice) obj.hidePrice = 1;
    return obj;
  }
  function encode(obj) { return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }

  function showLink(link, showPrice) {
    modal('<h3>🔗 ลิงก์แชร์ให้ลูกค้า</h3>' +
      '<div style="color:var(--gray);font-size:13px;margin-bottom:10px">' +
      (showPrice ? 'ลิงก์นี้ <b>แสดงราคา</b>' : 'ลิงก์นี้ <b>ไม่มีราคา</b> อยู่ในลิงก์เลย') +
      ' · ไม่มีเบอร์เซลล์/ค่าแรง · ลูกค้าเปิดแล้วเห็นหน้านำเสนอ 16:9 ทันที</div>' +
      '<textarea id="shareBox" readonly aria-label="ลิงก์แชร์ให้ลูกค้า" style="width:100%;height:88px;border:1px solid var(--line);border-radius:12px;padding:12px;font-family:var(--mono);font-size:12px;resize:none">' + esc(link) + '</textarea>' +
      '<div class="mrow"><button type="button" class="btn ghost mclose">ปิด</button><button type="button" class="btn" id="shareCopy">📋 คัดลอกลิงก์</button></div>');
    var sb = document.getElementById("shareBox");
    if (sb) { sb.focus(); sb.select(); }
    document.getElementById("shareCopy").onclick = function () {
      var done = function () { toast("คัดลอกลิงก์แล้ว"); };
      try { navigator.clipboard.writeText(link).then(done, function () { sb.select(); document.execCommand("copy"); done(); }); }
      catch (_) { sb.select(); document.execCommand("copy"); done(); }
    };
  }

  function sharePresLinkSafe(p) {
    try {
      if (!p) { toast("เลือกโครงการก่อน"); return; }
      modal('<h3>🔗 ลิงก์แชร์ให้ลูกค้า</h3>' +
        '<p style="margin:0 0 12px">จะให้ลูกค้าเห็นราคาในลิงก์นี้ไหม?</p>' +
        '<div class="mrow" style="flex-wrap:wrap">' +
        '<button type="button" class="btn ghost mclose">ยกเลิก</button>' +
        '<button type="button" class="btn ghost" id="presWithPrice" style="min-height:44px">แสดงราคา</button>' +
        '<button type="button" class="btn" id="presNoPrice" style="min-height:44px">ไม่แสดงราคา (แนะนำ)</button></div>');
      var base = location.origin + location.pathname;
      document.getElementById("presNoPrice").onclick = function () { showLink(base + "#pres=" + encode(payload(p, false)), false); };
      document.getElementById("presWithPrice").onclick = function () { showLink(base + "#pres=" + encode(payload(p, true)), true); };
      var def = document.getElementById("presNoPrice"); if (def) def.focus();
    } catch (e) { toast("สร้างลิงก์ไม่สำเร็จ: " + (e && e.message || e)); }
  }
  sharePresLinkSafe.__mafcP8 = 1;

  /* ปุ่มที่สอง "🔗 ลิงก์นำเสนอลูกค้า" ในหน้าโครงการ (addon เดิม: ลิงก์ ?present=<id> ที่ให้เบราว์เซอร์ลูกค้า
     ดึงโครงการ + คลังทั้งหมดจากเซิร์ฟเวอร์) → เปลี่ยนให้ใช้ลิงก์แบบปลอดภัยตัวเดียวกัน */
  function activeProject() {
    var p = null;
    try {
      var ap = window.mafcActiveProj ? window.mafcActiveProj() : null, id = ap && ap.id;
      if (typeof PROJECTS !== "undefined" && PROJECTS && id) PROJECTS.forEach(function (o) { if (!p && String(o.id) === String(id)) p = o; });
      if (!p && ap && ap.items) p = ap;
      if (!p && typeof curProj === "function") p = curProj();
    } catch (_) {}
    return p;
  }
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target.closest("#mafcShare") : null;
    if (!t) return;
    e.stopPropagation(); e.preventDefault();
    sharePresLinkSafe(activeProject());
  }, true);
  (function hidePriceBox() {
    var st = document.createElement("style");
    st.textContent = "#mafcShareBar label{display:none!important}";
    (document.head || document.documentElement).appendChild(st);
  })();
  try { window.sharePresLink = sharePresLinkSafe; } catch (_) {}
  window.__mafcPresPayload = payload;   /* ใช้ในเทส */

  /* เปิดลิงก์แบบซ่อนราคา → แทนเลขมูลค่ารวม (ซึ่งจะเป็น 0) ด้วยข้อความ */
  function hiddenPriceLink() {
    try {
      var m = (location.hash || "").match(/pres=([^&]+)/);
      if (!m) return false;
      var obj = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
      return !!(obj && obj.hidePrice);
    } catch (_) { return false; }
  }
  function patchTotals(root) {
    var nodes = (root || document).querySelectorAll ? (root || document).querySelectorAll("div") : [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.children.length || (n.textContent || "").trim() !== "มูลค่ารวมโดยประมาณ") continue;
      var val = n.nextElementSibling, unit = val && val.nextElementSibling;
      if (val && !val.__mafcHidden) { val.__mafcHidden = 1; val.textContent = "—"; }
      if (unit && unit.textContent !== "เอกสารนี้ไม่แสดงราคา") unit.textContent = "เอกสารนี้ไม่แสดงราคา";
    }
  }
  if (hiddenPriceLink()) {
    var start = function () {
      patchTotals(document);
      new MutationObserver(function () { patchTotals(document); }).observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  }
})();
