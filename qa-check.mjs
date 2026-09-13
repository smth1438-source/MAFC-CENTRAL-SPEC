import { chromium } from 'playwright';

const FILE = 'file://' + process.cwd() + '/index.html';
const SIZES = [[320,720],[390,844],[1440,900]];
const fails = [];
const notes = [];

function lin(c){ c/=255; return c<=0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4; }
function lum([r,g,b]){ return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b); }
function ratio(a,b){ const l1=lum(a),l2=lum(b); const [h,lo]=l1>l2?[l1,l2]:[l2,l1]; return (h+0.05)/(lo+0.05); }

const b = await chromium.launch();

for (const mode of ['dark','light']) {
  for (const [w,h] of SIZES) {
    const page = await b.newPage({ viewport:{width:w,height:h} });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0,160)));
    page.on('console', m => {
      const t = m.text();
      if (m.type()==='error' && !/net::|ERR_/i.test(t)) errs.push(t.slice(0,160));
    });
    await page.goto(FILE);
    await page.waitForTimeout(3000);
    if (mode==='light') {
      await page.evaluate(()=>document.documentElement.classList.add('mafc-light'));
      await page.waitForTimeout(400);
    }

    const r = await page.evaluate(() => {
      const parse = s => (s.match(/\d+/g)||[0,0,0]).slice(0,3).map(Number);
      const out = { low: [], hScroll: false, vh: [] };
      out.hScroll = document.documentElement.scrollWidth > window.innerWidth + 1;

      // contrast ของข้อความที่มองเห็น
      const els = [...document.querySelectorAll('body *')].filter(e => {
        const cs = getComputedStyle(e);
        if (cs.display==='none'||cs.visibility==='hidden'||parseFloat(cs.opacity)<0.1) return false;
        const txt = [...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join('');
        if (!txt) return false;
        const rc = e.getBoundingClientRect();
        return rc.width>0 && rc.height>0 && rc.top < window.innerHeight;
      });
      for (const e of els.slice(0,400)) {
        const cs = getComputedStyle(e);
        const fg = parse(cs.color);
        let bgEl = e, bg = null;
        while (bgEl) {
          const c = getComputedStyle(bgEl).backgroundColor;
          if (c && c!=='rgba(0, 0, 0, 0)' && c!=='transparent') { bg = parse(c); break; }
          bgEl = bgEl.parentElement;
        }
        if (!bg) continue;
        const size = parseFloat(cs.fontSize);
        const bold = (parseInt(cs.fontWeight)||400) >= 700;
        const need = (size>=24 || (size>=18.66 && bold)) ? 3 : 4.5;
        out.low.push({ tag:e.tagName, size, need, fg, bg,
          text:(e.textContent||'').trim().slice(0,40) });
      }
      // 100vh ที่ยังหลงเหลือ
      for (const sel of ['.sec','#app']) {
        const el = document.querySelector(sel);
        if (el) out.vh.push(sel + '=' + getComputedStyle(el).minHeight);
      }
      return out;
    });

    for (const c of r.low) {
      const v = ratio(c.fg, c.bg);
      if (v < c.need) fails.push(`contrast ${mode} ${w}px : ${v.toFixed(2)}:1 < ${c.need} — <${c.tag}> "${c.text}"`);
    }
    if (r.hScroll) fails.push(`h-scroll ${mode} ${w}px : หน้าเลื่อนแนวนอนได้`);
    if (errs.length) fails.push(`js-error ${mode} ${w}px : ${errs.slice(0,3).join(' / ')}`);
    notes.push(`${mode} ${w}px — ตรวจ ${r.low.length} element · ${r.vh.join(' ')}`);
    await page.close();
  }
}

// a11y: ปุ่มไอคอนต้องกดด้วยคีย์บอร์ดได้
{
  const page = await b.newPage({ viewport:{width:390,height:844} });
  await page.goto(FILE);
  await page.waitForTimeout(3000);
  const a = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.innerHTML = `
      <span class="ic act-del" title="ลบ">I</span>
      <span class="ic act-edit" title="แก้ไข">I</span>
      <label class="ic" title="เทียบ"><input type="checkbox"></label>
      <div class="tb" title="พิมพ์">I</div>
      <button class="navbtn" id="presPrev">A</button>`;
    document.body.appendChild(host);
    await new Promise(r=>setTimeout(r,600));
    const sel = '.ic,.tb,.navbtn,.ptbtn';
    const all = [...host.querySelectorAll(sel)].filter(e=>!e.querySelector('input'));
    let fired = 0;
    const del = host.querySelector('.act-del');
    del.addEventListener('click', ()=>fired++);
    del.focus();
    const focusable = document.activeElement === del;
    del.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    del.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));
    return {
      total: all.length,
      noName: all.filter(e=>!e.getAttribute('aria-label')).length,
      noRole: all.filter(e=>e.tagName!=='BUTTON'&&e.getAttribute('role')!=='button').length,
      notFocusable: all.filter(e=>e.tagName!=='BUTTON'&&!e.hasAttribute('tabindex')).length,
      prevName: document.getElementById('presPrev')?.getAttribute('aria-label'),
      focusable, fired
    };
  });
  if (a.noName)       fails.push(`a11y : ปุ่มไอคอนไม่มี aria-label ${a.noName} ตัว`);
  if (a.noRole)       fails.push(`a11y : ไม่มี role=button ${a.noRole} ตัว`);
  if (a.notFocusable) fails.push(`a11y : โฟกัสไม่ได้ ${a.notFocusable} ตัว`);
  if (!a.focusable)   fails.push('a11y : ปุ่มลบรับโฟกัสไม่ได้');
  if (a.fired < 2)    fails.push(`a11y : Enter/Space ยิง click ได้ ${a.fired}/2`);
  if (!a.prevName)    fails.push('a11y : #presPrev ไม่มีชื่อที่เข้าถึงได้');
  notes.push(`a11y — ปุ่มไอคอน ${a.total} ตัว · keyboard ${a.fired}/2 · presPrev="${a.prevName}"`);
  await page.close();
}

await b.close();

console.log('--- บันทึกการตรวจ ---');
notes.forEach(n => console.log('  ' + n));
if (fails.length) {
  console.log('');
  console.log('=== ไม่ผ่าน ' + fails.length + ' ข้อ ===');
  fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('');
console.log('=== ผ่านทั้งหมด ===');
