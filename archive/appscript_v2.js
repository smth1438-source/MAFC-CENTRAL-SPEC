/* ============================================================
   MAFC PLAYGROUND V5 — Apps Script v2 (เขียนใหม่ทั้งหมด)
   ------------------------------------------------------------
   • ผูกกับชีตทดลอง MAFC-PLAYGROUND-V5 เท่านั้น (แยกจากของจริง 100%)
   • ตาราง MATERIALS เดียว (ไม่แยก 44 แท็บ) — คนเปิดชีตแก้ได้ อ่านง่าย
   • setup(): สร้างแท็บ + นำเข้าข้อมูลจริง (อ่านอย่างเดียวจากระบบเดิม)
     + นำเข้า BOQ 207 รายการ (ไม่มี FF / EE เดิมไม่แตะ)
   • มี: cache, LockService, กันเขียนซ้ำ (requestId), auto-ID,
     โครงการรายห้อง, ลิงก์นำเสนอ, ธงราคาเก่า, เรดาร์ราคารายสัปดาห์
   ============================================================ */

var TEAM_CODE = 'MAFC-PLAY-2026';          // รหัสทีมสำหรับเขียน (playground)
var OLD_API   = 'https://script.google.com/macros/s/AKfycbzTigBhUbgeQ4wN1tHhJIVWexVUd8hdFuaqooxcLw_YQN7_vvfZtYZc1ndMvOgbcJ5K/exec'; // อ่านอย่างเดียว
var CACHE_KEY = 'MAFC_V5_DATA';
var CACHE_TTL = 120;                        // วินาที
var STALE_DAYS = 90;                        // ธงราคาเก่า

var HDR = ['id','full_id','old_code','disc','grp','grp_name','name','size','grade','brand','link','price','unit','contact','img','price_date','std','status','source','sort','updated_at','updated_by','deleted'];

var SHEET_ID = '1x_QTGfK4xeL-V0yYt_2rhM-a1tVM6HOG5bh-gp5d8r8';   // ชีตทดลอง MAFC-PLAYGROUND-V5
function ss(){ return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet(); }
function sh(name){ var s=ss().getSheetByName(name); if(!s){ s=ss().insertSheet(name); } return s; }

/* ═══════════ SETUP — รันครั้งเดียว ═══════════ */
function setup(){
  var m = sh('MATERIALS');
  if(m.getLastRow()===0){ m.appendRow(HDR); m.setFrozenRows(1); m.getRange(1,1,1,HDR.length).setFontWeight('bold').setBackground('#0B1220').setFontColor('#fff'); }
  var p = sh('_PROJECTS');  if(p.getLastRow()===0) p.appendRow(['id','name','status','json','updated_at','updated_by']);
  var w = sh('_WATCH');     if(w.getLastRow()===0) w.appendRow(['id','link','price_sys','price_web','delta_pct','checked_at','note']);
  var pl= sh('_PRICE_LOG'); if(pl.getLastRow()===0) pl.appendRow(['at','id','old','new','user']);
  var lg= sh('_LOG');       if(lg.getLastRow()===0) lg.appendRow(['at','user','action','id','detail']);
  importReal();
  importBOQ();
  installTrigger();
  CacheService.getScriptCache().remove(CACHE_KEY);
  Logger.log('SETUP DONE — rows: '+sh('MATERIALS').getLastRow());
}

/* นำเข้าข้อมูลจริงจากระบบเดิม (READ ONLY — ของจริงไม่ถูกแตะ) */
function importReal(){
  var m=sh('MATERIALS'); if(m.getLastRow()>1) return;  // กัน setup ซ้ำ
  var wb=JSON.parse(UrlFetchApp.fetch(OLD_API,{muteHttpExceptions:true}).getContentText());
  var rows=[], now=new Date(), seqByGrp={};
  (wb.sheets||[]).forEach(function(s){
    var name=String(s.name||''); if(name.charAt(0)==='_')return;
    var disc=String(s.disc||'').toUpperCase(); var vals=s.values||[]; if(vals.length<2)return;
    var g='',gname='';
    for(var r=1;r<vals.length;r++){
      var code=String(vals[r][0]||'').trim(), desc=String(vals[r][1]||'').trim();
      if(!code&&!desc)continue;
      if(code&&code.indexOf('-')<0){ g=code; gname=desc; continue; }     // หัวกลุ่ม
      if(!code)continue;
      var grp=normGrp(code,g);
      seqByGrp[disc+grp]=(seqByGrp[disc+grp]||0)+1;
      var id=grp+'-'+pad2(seqByGrp[disc+grp]);
      rows.push([id, disc+'-'+id, code, disc, grp, gname||g, desc,
        String(vals[r][2]||''), String(vals[r][3]||''), String(vals[r][4]||''), String(vals[r][5]||''),
        numOr(vals[r][6]), String(vals[r][9]||''), String(vals[r][7]||''), String(vals[r][8]||''),
        String(vals[r][11]||''), String(vals[r][12]||''), String(vals[r][13]||''),
        'REAL', seqByGrp[disc+grp], now, 'setup', '']);
    }
  });
  if(rows.length) m.getRange(2,1,rows.length,HDR.length).setValues(rows);
  Logger.log('importReal: '+rows.length);
}

/* นำเข้า BOQ บ้านสตูล — เข้า GN/ST/AR/SN + EE กลุ่มใหม่ (BOQ) เท่านั้น · FF: ไม่มีเด็ดขาด */
function importBOQ(){
  var m=sh('MATERIALS');
  var have={}; getAll().forEach(function(x){ have[x.disc+'|'+x.name.toLowerCase()]=1; });
  var data=BOQ_DATA();     // ฝังท้ายไฟล์
  var rows=[], now=new Date();
  var grpMap={}, grpSeq={}, itemSeq={};
  // หาเลขกลุ่มถัดไปต่อ disc จากของที่มี
  getAll().forEach(function(x){ var mch=x.grp&&x.grp.match(/^([A-Z]+)(\d+)$/); if(mch){ var k=x.disc+'|'+mch[1]; grpSeq[k]=Math.max(grpSeq[k]||0, +mch[2]); } });
  data.forEach(function(it){
    if(it.disc==='FF') return;                                  // กันพลาดชั้นสุดท้าย
    if(have[it.disc+'|'+it.name.toLowerCase()]) return;         // มีแล้ว (EE เดิม) ไม่ยุ่ง
    var gk=it.disc+'|'+it.group;
    if(!grpMap[gk]){
      var pfx = it.disc==='EE' ? 'EB' : it.disc.substring(0,2); // EE จาก BOQ ใช้กลุ่ม EBxx กันชนกลุ่มเดิม
      var sk=it.disc+'|'+pfx; grpSeq[sk]=(grpSeq[sk]||0)+1;
      grpMap[gk]=pfx+pad2(grpSeq[sk]);
    }
    var grp=grpMap[gk];
    itemSeq[grp]=(itemSeq[grp]||0)+1;
    var id=grp+'-'+pad2(itemSeq[grp]);
    rows.push([id, it.disc+'-'+id, '', it.disc, grp, it.group, it.name, '', '', '', '',
      it.price, it.unit, '', '', '28/07/2569', '', '', 'BOQ-สตูล', itemSeq[grp], now, 'setup', '']);
  });
  if(rows.length) m.getRange(m.getLastRow()+1,1,rows.length,HDR.length).setValues(rows);
  Logger.log('importBOQ: '+rows.length);
}

function normGrp(code,g){
  var m=(g||code.split('-')[0]).match(/^([A-Za-z+]+)\s*(\d*)/);
  if(!m) return 'X00';
  var L=m[1].replace(/[^A-Za-z]/g,'').toUpperCase().substring(0,3)||'X';
  return L+pad2(m[2]?+m[2]:1);
}
function pad2(n){ return (n<10?'0':'')+n; }
function numOr(v){ var x=parseFloat(String(v==null?'':v).replace(/[^0-9.\-]/g,'')); return isNaN(x)?'':x; }

/* ═══════════ อ่านข้อมูล (มี cache) ═══════════ */
function getAll(){
  var m=sh('MATERIALS'); var n=m.getLastRow(); if(n<2) return [];
  var v=m.getRange(2,1,n-1,HDR.length).getValues();
  return v.map(function(r,i){ var o={_row:i+2}; HDR.forEach(function(h,j){ o[h]=r[j]; }); return o; })
          .filter(function(o){ return o.id && !o.deleted; });
}
function readAll(includeCost){
  var c=CacheService.getScriptCache(); var key=CACHE_KEY+(includeCost?'_T':'_P');
  var hit=c.get(key); if(hit) return JSON.parse(hit);
  var items=getAll().map(function(o){
    var x={id:o.id,fid:o.full_id,old:o.old_code,disc:o.disc,grp:o.grp,grpName:o.grp_name,
      name:o.name,size:o.size,grade:o.grade,brand:o.brand,link:o.link,unit:o.unit,img:o.img,
      pd:o.price_date,std:o.std,status:o.status,src:o.source,stale:isStale(o.price_date)};
    if(includeCost){ x.price=o.price; x.contact=o.contact; }
    return x;
  });
  var watch={}; try{ var w=sh('_WATCH'); var wn=w.getLastRow();
    if(wn>1){ w.getRange(2,1,wn-1,7).getValues().forEach(function(r){ if(r[0]) watch[r[0]]={web:r[3],delta:r[4],at:r[5],note:r[6]}; }); } }catch(e){}
  var out={ok:true, updated:new Date().toISOString(), items:items, watch:watch, projects:projList().projects};
  c.put(key, JSON.stringify(out), CACHE_TTL);
  return out;
}
function isStale(pd){
  if(!pd) return true;
  var m=String(pd).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); if(!m) return true;
  var y=+m[3]; if(y>2400)y-=543; if(y<100)y+=2000;
  var d=new Date(y,+m[2]-1,+m[1]);
  return (Date.now()-d.getTime()) > STALE_DAYS*24*3600*1000;
}
function bustCache(){ var c=CacheService.getScriptCache(); c.remove(CACHE_KEY+'_T'); c.remove(CACHE_KEY+'_P'); }

/* ═══════════ Router ═══════════ */
function doGet(e){ return route(e); }
function doPost(e){
  var p={}; try{ if(e&&e.postData&&e.postData.contents) p=JSON.parse(e.postData.contents); }catch(err){}
  var merged={},k; if(e&&e.parameter)for(k in e.parameter)merged[k]=e.parameter[k];
  for(k in p)merged[k]=p[k];
  return route({parameter:merged});
}
function route(e){
  e=e||{}; var p=e.parameter||{}; var cb=p.callback||''; var act=p.action||'read';
  var WRITE={add:1,update:1,del:1,restore:1,projSave:1,projDel:1,checkNow:1};
  if(WRITE[act]){
    if(String(p.token||'')!==TEAM_CODE) return reply(cb,{ok:false,error:'unauthorized'});
    // กันเขียนซ้ำ (BUG-03 เดิม)
    if(p.reqId){ var c=CacheService.getScriptCache(); if(c.get('REQ_'+p.reqId)) return reply(cb,{ok:true,dup:true}); c.put('REQ_'+p.reqId,'1',600); }
    var lock=LockService.getScriptLock();                        // กันชนกัน (BUG-04 เดิม)
    try{ lock.waitLock(10000); }catch(err){ return reply(cb,{ok:false,error:'ระบบกำลังยุ่ง ลองอีกครั้ง'}); }
    try{ return reply(cb, dispatch(act,p)); } finally{ lock.releaseLock(); }
  }
  if(act==='present') return reply(cb, present(p));
  if(act==='nextId')  return reply(cb, {ok:true, id:nextId(p.disc,p.grp)});
  if(act==='watch')   return reply(cb, {ok:true, watch:readAll(false).watch});
  return reply(cb, readAll(String(p.token||'')===TEAM_CODE));
}
function dispatch(act,p){
  if(act==='add')     return addItem(p);
  if(act==='update')  return updItem(p);
  if(act==='del')     return delItem(p);
  if(act==='restore') return restoreItem(p);
  if(act==='projSave')return projSave(p);
  if(act==='projDel') return projDel(p);
  if(act==='checkNow')return {ok:true, result:checkPrices(20)};
  return {ok:false,error:'unknown action'};
}
function reply(cb,obj){
  var s=JSON.stringify(obj);
  return cb? ContentService.createTextOutput(cb+'('+s+')').setMimeType(ContentService.MimeType.JAVASCRIPT)
           : ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}
function log_(user,action,id,detail){ try{ sh('_LOG').appendRow([new Date(),user||'',action,id||'',String(detail||'').slice(0,200)]); }catch(e){} }

/* ═══════════ auto-ID ═══════════ */
function nextId(disc,grp){
  disc=String(disc||'').toUpperCase(); grp=String(grp||'').toUpperCase();
  var mx=0;
  getAll().forEach(function(o){ if(o.disc===disc&&o.grp===grp){ var m=String(o.id).match(/-(\d+)$/); if(m) mx=Math.max(mx,+m[1]); } });
  // รวมแถวที่ลบแล้วด้วย — รหัสไม่ reuse
  var m2=sh('MATERIALS'); var n=m2.getLastRow();
  if(n>1){ m2.getRange(2,1,n-1,5).getValues().forEach(function(r){ if(String(r[3])===disc&&String(r[4])===grp){ var mm=String(r[0]).match(/-(\d+)$/); if(mm) mx=Math.max(mx,+mm[1]); } }); }
  return grp+'-'+pad2(mx+1);
}

/* ═══════════ เขียน ═══════════ */
function addItem(p){
  var disc=String(p.disc||'').toUpperCase();
  var grp=String(p.grp||'').toUpperCase();
  var grpName=String(p.grpName||'');
  if(!disc||!grp||!p.name) return {ok:false,error:'ข้อมูลไม่ครบ (หมวด/กลุ่ม/ชื่อ)'};
  var id=nextId(disc,grp);
  var now=new Date();
  sh('MATERIALS').appendRow([id, disc+'-'+id, '', disc, grp, grpName, String(p.name),
    String(p.size||''), String(p.grade||''), String(p.brand||''), String(p.link||''),
    numOr(p.price), String(p.unit||''), String(p.contact||''), String(p.img||''),
    String(p.priceDate||todayTH()), String(p.std||''), String(p.status||''),
    'WEB', 0, now, String(p.user||''), '']);
  bustCache(); log_(p.user,'add',id,p.name);
  return {ok:true, id:id, fid:disc+'-'+id};
}
function findRow(id){
  var m=sh('MATERIALS'); var n=m.getLastRow(); if(n<2) return -1;
  var v=m.getRange(2,1,n-1,1).getValues();
  for(var i=0;i<v.length;i++) if(String(v[i][0])===String(id)) return i+2;
  return -1;
}
function updItem(p){
  var r=findRow(p.id); if(r<0) return {ok:false,error:'ไม่พบรหัส '+p.id+' — รีเฟรชก่อน'};   // ไม่แอบ add (BUG-05 เดิม)
  var m=sh('MATERIALS');
  var cur=m.getRange(r,1,1,HDR.length).getValues()[0];
  var map={name:6,size:7,grade:8,brand:9,link:10,price:11,unit:12,contact:13,img:14,priceDate:15,std:16,status:17};
  var oldPrice=cur[11];
  Object.keys(map).forEach(function(k){ if(p[k]!==undefined) cur[map[k]] = (k==='price')?numOr(p[k]):String(p[k]); });  // ค่าว่างเขียนทับได้ (BUG-02 เดิม)
  cur[20]=new Date(); cur[21]=String(p.user||'');
  m.getRange(r,1,1,HDR.length).setValues([cur]);
  if(p.price!==undefined && String(numOr(p.price))!==String(oldPrice)) sh('_PRICE_LOG').appendRow([new Date(),p.id,oldPrice,numOr(p.price),p.user||'']);
  bustCache(); log_(p.user,'update',p.id,'');
  return {ok:true};
}
function delItem(p){
  var r=findRow(p.id); if(r<0) return {ok:false,error:'ไม่พบรหัส'};
  sh('MATERIALS').getRange(r,HDR.length).setValue('DEL '+new Date().toISOString()+' by '+(p.user||''));  // soft delete
  bustCache(); log_(p.user,'del',p.id,'');
  return {ok:true};
}
function restoreItem(p){
  var r=findRow(p.id); if(r<0) return {ok:false,error:'ไม่พบรหัส'};
  sh('MATERIALS').getRange(r,HDR.length).setValue('');
  bustCache(); log_(p.user,'restore',p.id,'');
  return {ok:true};
}
function todayTH(){ var d=new Date(); return d.getDate()+'/'+(d.getMonth()+1)+'/'+(d.getFullYear()+543); }

/* ═══════════ โครงการรายห้อง + นำเสนอ ═══════════ */
function projList(){
  var p=sh('_PROJECTS'); var n=p.getLastRow(); var out=[];
  if(n>1){ p.getRange(2,1,n-1,6).getValues().forEach(function(r){
    if(!r[0]||r[2]==='DELETED')return;
    var o={}; try{o=JSON.parse(r[3]||'{}');}catch(e){}
    o.id=String(r[0]); o.name=String(r[1]); o.status=String(r[2]||'ร่าง'); o.updated=String(r[4]);
    out.push(o); }); }
  return {ok:true, projects:out};
}
function projSave(p){
  var id=String(p.id||('P'+Date.now()));
  var ps=sh('_PROJECTS'); var n=ps.getLastRow(); var row=-1;
  if(n>1){ var ids=ps.getRange(2,1,n-1,1).getValues();
    for(var i=0;i<ids.length;i++) if(String(ids[i][0])===id){ row=i+2; break; } }
  var rec=[id, String(p.name||''), String(p.status||'ร่าง'), String(p.json||'{}'), new Date(), String(p.user||'')];
  if(row>0) ps.getRange(row,1,1,6).setValues([rec]); else ps.appendRow(rec);
  bustCache(); log_(p.user,'projSave',id,p.name);
  return {ok:true, id:id};
}
function projDel(p){
  var ps=sh('_PROJECTS'); var n=ps.getLastRow();
  if(n>1){ var ids=ps.getRange(2,1,n-1,1).getValues();
    for(var i=0;i<ids.length;i++) if(String(ids[i][0])===String(p.id)){ ps.getRange(i+2,3).setValue('DELETED'); break; } }
  bustCache(); return {ok:true};
}
/* หน้าลูกค้า: ไม่มีราคาทุน/เบอร์เซลล์เด็ดขาด */
function present(p){
  var id=String(p.id||'');
  var pj=projList().projects.filter(function(x){return x.id===id && x.share;})[0];
  if(!pj) return {ok:false,error:'ไม่พบลิงก์นำเสนอ หรือถูกปิดแล้ว'};
  var items={}; getAll().forEach(function(o){ items[o.id]={id:o.id,name:o.name,size:o.size,grade:o.grade,brand:o.brand,img:o.img,unit:o.unit}; });
  (pj.rooms||[]).forEach(function(rm){ (rm.mats||[]).forEach(function(mt){ mt.info=items[mt.id]||null; }); });
  log_('','presentView',id,'');
  return {ok:true, project:{name:pj.name, cover:pj.cover||{}, rooms:pj.rooms||[], showPrice:false}};
}

/* ═══════════ เรดาร์ราคา (best-effort) ═══════════ */
function installTrigger(){
  var has=ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()==='weeklyCheck';});
  if(!has) ScriptApp.newTrigger('weeklyCheck').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
}
function weeklyCheck(){ checkPrices(60); }
function checkPrices(maxN){
  var all=getAll().filter(function(o){ return o.link && /^https?:\/\//.test(o.link) && o.price; });
  var w=sh('_WATCH'); if(w.getLastRow()>1) w.getRange(2,1,w.getLastRow()-1,7).clearContent();
  var done=0, found=0, rows=[];
  for(var i=0;i<all.length && done<(maxN||30); i++){
    var o=all[i]; done++;
    var web=fetchPrice(o.link);
    var note = web==null ? 'อ่านอัตโนมัติไม่ได้' : '';
    var delta = (web!=null&&o.price) ? Math.round((web-o.price)/o.price*1000)/10 : '';
    if(web!=null) found++;
    rows.push([o.id, o.link, o.price, web==null?'':web, delta, new Date(), note]);
  }
  if(rows.length) w.getRange(2,1,rows.length,7).setValues(rows);
  bustCache();
  return {checked:done, readable:found};
}
function fetchPrice(url){
  try{
    var res=UrlFetchApp.fetch(url,{muteHttpExceptions:true,followRedirects:true,
      headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}});
    if(res.getResponseCode()>=400) return null;
    var html=res.getContentText();
    var pats=[/"price"\s*:\s*"?([0-9,]+(?:\.\d+)?)"?/i,
              /itemprop="price"\s+content="([0-9,\.]+)"/i,
              /class="[^"]*price[^"]*"[^>]*>\s*฿?\s*([0-9,]+(?:\.\d+)?)/i,
              /฿\s*([0-9,]{2,12}(?:\.\d+)?)/];
    for(var i=0;i<pats.length;i++){
      var m=html.match(pats[i]);
      if(m){ var v=parseFloat(m[1].replace(/,/g,'')); if(v>1&&v<10000000) return v; }
    }
  }catch(e){}
  return null;
}

/* ═══════════ BOQ DATA (ฝังจากไฟล์ CM06-69-05-RSL 28/07/2569) ═══════════ */
function BOQ_DATA(){ return [{"disc": "GN", "section": "GN", "group": "งานเตรียมพื้นที่ และงานผัง", "name": "งานวางจุดกำหนดระดับ +- 00.00", "qty": 1, "unit": "จุด", "price": 12501.0}, {"disc": "GN", "section": "GN", "group": "งานอาคารชั่วคราว", "name": "ที่พักและแคมป์คนงาน", "qty": 1, "unit": "งาน", "price": 25000.0}, {"disc": "GN", "section": "GN", "group": "งานอาคารชั่วคราว", "name": "อาคารสำหนักงาน พื้นที่ก่อสร้าง", "qty": 1, "unit": "งาน", "price": 25000.0}, {"disc": "GN", "section": "GN", "group": "งานรั้วชั่วคราว และทางเข้าออก", "name": "รัวก่อสร้างชั่วคราว", "qty": 150, "unit": "งาน", "price": 100.0}, {"disc": "GN", "section": "GN", "group": "งานรั้วชั่วคราว และทางเข้าออก", "name": "ทางเข้าออกคอนกรีตหยาบ", "qty": 1, "unit": "งาน", "price": 5700.0}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานเสาเข็ม และงานดิน", "name": "F1-1 สาเข็มตอกสี่เหลี่ยม ขนาด 0.26x0.26 ม. ยาว 8.00 ม.", "qty": 20, "unit": "ต้น", "price": 5225.0}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานเสาเข็ม และงานดิน", "name": "F2-1 เสาเข็มสี่เหลี่ยม 0.22x0.22 ม. ยาว 8.00 ม.", "qty": 7, "unit": "ต้น", "price": 4560.0}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "ทรายหยาบ", "qty": 4, "unit": "ลบ.ม.", "price": 589.0}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "คอนกรีตหยาบ", "qty": 4, "unit": "ลบ.ม.", "price": 1786.0}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "แบบเหล็กฟุตติ้ง 1.0 x 0.60 m", "qty": 7, "unit": "แผ่น", "price": 39.9}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "แบบเหล็กฟุตติ้ง 1.00 x 0.60 m", "qty": 7, "unit": "แผ่น", "price": 39.9}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "ไม้พารา 1\"x2\" ยาว 1 เมตร", "qty": 1401, "unit": "ท่อน", "price": 7.31}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "ตะปู 3\"", "qty": 5, "unit": "ลัง", "price": 679.25}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "เหล็กเส้นกลมผิวเรียบ RB 6 มม. SR.24 ยาว 10 ม.,หนัก 2.22 กก. ต่อเส้น", "qty": "", "unit": "เส้น", "price": 51.3}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "เหล็กเส้นกลมผิวเรียบ RB 9 มม. SR.24 ยาว 10 ม.,หนัก 4.99 กก. ต่อเส้น", "qty": "", "unit": "เส้น", "price": 147.39}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "เหล็กเส้นกลมผิวข้ออ้อย DB 12 มม. SD.40 ยาว 10 ม.,หนัก 8.88 กก. ต่อเส้น", "qty": 82, "unit": "เส้น", "price": 199.23}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "เหล็กเส้นกลมผิวข้ออ้อย DB 16 มม. SD.40 ยาว 10 ม.,หนัก 15.80 กก. ต่อเส้น", "qty": "", "unit": "เส้น", "price": 355.77}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "เหล็กเส้นกลมผิวข้ออ้อย DB 20 มม. SD.40 ยาว 10 ม.,หนัก 24.66 กก. ต่อเส้น", "qty": "", "unit": "เส้น", "price": 567.21}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "เหล็กเส้นกลมผิวข้ออ้อย DB 25 มม. SD.40 ยาว 10 ม.,หนัก35.53 กก. ต่อเส้น", "qty": "", "unit": "เส้น", "price": 762.38}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "ไวร์เมช WMI รุ่น 3.0 มม. (ตาห่าง 20 x 20 ซม.) ขนาด 2 x 25 เมตร", "qty": "", "unit": "ม้วน", "price": 1931.35}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "ไวร์เมช WMI รุ่น 5.0 มม. (ตาห่าง 20 x 20 ซม.) ขนาด 2 x 25 เมตร", "qty": "", "unit": "ม้วน", "price": 4777.55}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "ลวดผูกเหล็ก เบอร์ 18 ศก. 1.24 มม. หนัก 2.50 กก.ต่อขด", "qty": 6, "unit": "ขด", "price": 102.41}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "ใบตัดเหล็ก 14 นิ้ว", "qty": 3, "unit": "ใบ", "price": 114.0}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "ลูกปูน หนา 50 มม.", "qty": 320, "unit": "ก้อน", "price": 2.85}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานฐานราก", "name": "คอนกรีตผสมเสร็จรูป ลูกบาศก์ 240 กก./ตร.ซม. (ผสมกันซึม)", "qty": 5, "unit": "ลบ.ม.", "price": 2185.0}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานเสาตอม่อ", "name": "แบบเหล็ก 0.25 x 1.50 m.", "qty": 5, "unit": "แผ่น", "price": 28.5}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานเสาตอม่อ", "name": "แบบเหล็ก 0.35 x 1.50 m.", "qty": 5, "unit": "แผ่น", "price": 28.5}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานเสาตอม่อ", "name": "เหล็กฉากเข้ามุมเสา 1.50 m.", "qty": 5, "unit": "แผ่น", "price": 17.81}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานเสาตอม่อ", "name": "ตัวหนอน", "qty": 5, "unit": "ตัว", "price": 4.75}, {"disc": "ST", "section": "ST1 ฐานราก", "group": "งานเสาตอม่อ", "name": "ลูกปูน หนา 25 มม.", "qty": 216, "unit": "ก้อน", "price": 1.9}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างคานชั้นที่ 1", "name": "แบบเหล็ก 0.40x1.50 ม.", "qty": 0.35, "unit": "แผ่น", "price": 111.72}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างคานชั้นที่ 1", "name": "แบบเหล็ก 0.40x1.20 ม.", "qty": 0.2, "unit": "แผ่น", "price": 89.38}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างคานชั้นที่ 1", "name": "แบบเหล็ก 0.40x1.00 ม.", "qty": 0.15, "unit": "แผ่น", "price": 83.79}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างคานชั้นที่ 1", "name": "แบบเหล็ก 0.40x0.90 ม.", "qty": 0.12, "unit": "แผ่น", "price": 22.34}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างคานชั้นที่ 1", "name": "แบบเหล็ก 0.40x0.6 0 ม.", "qty": 0.25, "unit": "แผ่น", "price": 22.34}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างคานชั้นที่ 1", "name": "แบบเหล็ก 0.20x0.60 ม.", "qty": 0.2, "unit": "แผ่น", "price": 11.17}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างคานชั้นที่ 1", "name": "แบบเหล็ก 0.30x0.60 ม.", "qty": 0.2, "unit": "แผ่น", "price": 16.76}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างคานชั้นที่ 1", "name": "ฉากมุมนอก", "qty": 0.15, "unit": "ชิ้น", "price": 33.25}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างคานชั้นที่ 1", "name": "ฉากมุมใน", "qty": 0.5, "unit": "ชิ้น", "price": 33.25}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานระบบกันปลวก", "name": "ติดตั้งท่อกันปลวกและอัดน้ำยาหน้าดิน", "qty": 215, "unit": "ตร.ม.", "price": 85.5}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานพื้นหล่อในที่ชั้นที่ 1", "name": "ดินถม", "qty": 25, "unit": "ลบ.ม.", "price": 427.5}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานพื้นหล่อในที่ชั้นที่ 1", "name": "พลาสติกอเนกประสงค์ (พลาสติกปูพื้นคอนกรีต) ขนาด 1.2 x 50 เมตร สีขาวขุ่น", "qty": 1, "unit": "ม่วน", "price": 332.5}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างพื้น แผ่นพื้นเสริมลวดอัดแรง PS ชั้นที่ 1", "name": "แผ่นพื้นท้องเรียบ LL 300 กก. ต่อ ตร.ม. 0.35x0.05 m. ยาว 0.90 ม.", "qty": 20, "unit": "แผ่น", "price": 114.0}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างพื้น แผ่นพื้นเสริมลวดอัดแรง PS ชั้นที่ 1", "name": "แผ่นพื้นท้องเรียบ LL 300 กก. ต่อ ตร.ม. 0.35x0.05 m. ยาว 1.00 ม.", "qty": 28, "unit": "แผ่น", "price": 123.5}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างพื้น แผ่นพื้นเสริมลวดอัดแรง PS ชั้นที่ 1", "name": "แผ่นพื้นท้องเรียบ LL 300 กก. ต่อ ตร.ม. 0.35x0.05 m. ยาว 1.05 ม.", "qty": 5, "unit": "แผ่น", "price": 128.25}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างพื้น แผ่นพื้นเสริมลวดอัดแรง PS ชั้นที่ 1", "name": "แผ่นพื้นท้องเรียบ LL 300 กก. ต่อ ตร.ม. 0.35x0.05 m. ยาว 1.20 ม.", "qty": 9, "unit": "แผ่น", "price": 142.5}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างพื้น แผ่นพื้นเสริมลวดอัดแรง PS ชั้นที่ 1", "name": "แผ่นพื้นท้องเรียบ LL 300 กก. ต่อ ตร.ม. 0.35x0.05 m. ยาว 1.40 ม.", "qty": 5, "unit": "แผ่น", "price": 171.0}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างพื้น แผ่นพื้นเสริมลวดอัดแรง PS ชั้นที่ 1", "name": "แผ่นพื้นท้องเรียบ LL 300 กก. ต่อ ตร.ม. 0.35x0.05 m. ยาว 1.90 ม.", "qty": 10, "unit": "แผ่น", "price": 218.5}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างพื้น แผ่นพื้นเสริมลวดอัดแรง PS ชั้นที่ 1", "name": "แผ่นพื้นท้องเรียบ LL 300 กก. ต่อ ตร.ม. 0.35x0.05 m. ยาว 2.40 ม.", "qty": 9, "unit": "แผ่น", "price": 304.0}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างพื้น แผ่นพื้นเสริมลวดอัดแรง PS ชั้นที่ 1", "name": "แผ่นพื้นท้องเรียบ LL 300 กก. ต่อ ตร.ม. 0.35x0.05 m. ยาว 3.70 ม.", "qty": 41, "unit": "แผ่น", "price": 399.0}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างพื้น แผ่นพื้นเสริมลวดอัดแรง PS ชั้นที่ 1", "name": "แบบเหล็ก 0.15 X 1.50 เมตร", "qty": 10, "unit": "แผ่น", "price": 190.0}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างพื้น แผ่นพื้นเสริมลวดอัดแรง PS ชั้นที่ 1", "name": "คอนกรีตผสมเสร็จรูป ลูกบาศก์ 240 กก./ตร.ซม.", "qty": 12.5, "unit": "ลบ.ม.", "price": 1919.0}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างเสาชั้นที่ 1", "name": "แบบเสาแอล กว้าง 20 ซม.x 20 ซม.x ยาว 350 ซม.", "qty": 5, "unit": "แผ่น", "price": 304.0}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างเสาชั้นที่ 1", "name": "พลาสติกบ่มคอนกรีต ยาว 15 หลา (1 ม้วน/ 19 ตรม)", "qty": 6, "unit": "ม้วน", "price": 171.0}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างเสาชั้นที่ 1", "name": "ค้ำยัน ไม้ยูคา 2\" ยาว 4 ม.", "qty": 84, "unit": "ท่อน", "price": 76.0}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างเสาชั้นที่ 1", "name": "ตะปูคอนกรีตขาว ขนาด 2 1/2 นิ้ว แพ็ค 5กก.", "qty": 1, "unit": "แพ็ค", "price": 617.5}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างงานเทพื้น GS", "name": "อิฐบล็อค มอก. 7x19x39 ซม.", "qty": "", "unit": "ก้อน", "price": 8.55}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างงานเทพื้น GS", "name": "ปูนซีเมนต์สำหรับงานโครงสร้าง (50 กก./ ถุง)", "qty": "", "unit": "ถุง", "price": 142.5}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างงานเทพื้น GS", "name": "ปูนเซีเมนต์ ฉาบสูตรพิเศษ", "qty": "", "unit": "ถุง", "price": 142.5}, {"disc": "ST", "section": "ST2 โครงสร้างชั้น 1", "group": "งานโครงสร้างงานเทพื้น GS", "name": "ทรายละเอียด", "qty": "", "unit": "ลบ.ม.", "price": 617.5}, {"disc": "ST", "section": "ST3 โครงสร้างชั้น 2", "group": "งานโครงสร้างคานชั้น 2", "name": "ไม้อัดเคลือบฟิล์มดำ 15 มม.", "qty": 27, "unit": "แผ่น", "price": 539.22}, {"disc": "ST", "section": "ST3 โครงสร้างชั้น 2", "group": "งานโครงสร้างคานชั้น 2", "name": "เสาเหล็กค้ำยัน 3.5 ม. (POP 3.5 M)", "qty": 191.4, "unit": "ท่อน", "price": 114.0}, {"disc": "ST", "section": "ST3 โครงสร้างชั้น 2", "group": "งานโครงสร้างคานชั้น 2", "name": "เหล็กกล่อง 2\"x4\"x3 ม.", "qty": 76.56, "unit": "ท่อน", "price": 95.0}, {"disc": "ST", "section": "ST3 โครงสร้างชั้น 2", "group": "งานโครงสร้างพื้นคอนกรีตหล่อในที่ ชั้น 2", "name": "ไม้ 1.5\"x3\" ยาว 3 เมตร", "qty": 99, "unit": "ท่อน", "price": 156.75}, {"disc": "ST", "section": "ST3 โครงสร้างชั้น 2", "group": "งานโครงสร้างพื้นคอนกรีตหล่อในที่ ชั้น 2", "name": "เหล็กแป๊ปกลม 1 นิ้วครึ่ง ยาว 3 ม.", "qty": 33, "unit": "ท่อน", "price": 57.0}, {"disc": "ST", "section": "ST3 โครงสร้างชั้น 2", "group": "งานโครงสร้างพื้น แผ่นพื้นเสริมลวดอัดแรง PS ชั้น 2", "name": "แผ่นพื้นท้องเรียบ LL 300 กก. ต่อ ตร.ม. 0.35x0.05 m. ยาว 1.70 ม.", "qty": 10, "unit": "แผ่น", "price": 199.5}, {"disc": "ST", "section": "ST3 โครงสร้างชั้น 2", "group": "งานโครงสร้างบันได ค.ส.ล. ชั้นที่ 1 ขึ้น ชั้นที่ 2 (บันไดท้องเรียบ)", "name": "ค้ำยัน ไม้ยูคา 3\" ยาว 4 เมตร", "qty": 13, "unit": "ท่อน", "price": 83.6}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานโครงสร้างหลังคาเหล็ก", "name": "อะเส เหล็กกล่องสี่เหลี่ยมผืนผ้า 150 x 50 หนา 4.5 mm", "qty": 8, "unit": "เส้น", "price": 2375.0}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานโครงสร้างหลังคาเหล็ก", "name": "จันทัน เหล็กกล่องสี่เหลียมผืนผ้า 100x50 หนา 2.3 mm", "qty": 15, "unit": "เส้น", "price": 1144.75}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานโครงสร้างหลังคาเหล็ก", "name": "เเป เหล็กกล่องสี่เหลียมผืนผ้า 50x25 หนา 2.3 mm", "qty": 15, "unit": "เส้น", "price": 560.5}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานโครงสร้างหลังคาเหล็ก", "name": "รางน้ำฝน เหล็กกล่อง 25x25 หนา 2.30 มม.", "qty": 5, "unit": "เส้น", "price": 365.75}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานโครงสร้างหลังคาเหล็ก", "name": "เหล็กเพลทหัวเสากลม 200x200 หนา 9 มม.", "qty": 4, "unit": "แผ่น", "price": 203.3}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานโครงสร้างหลังคาเหล็ก", "name": "พุกเหล็ก 3/8", "qty": 16, "unit": "ตัว", "price": 10.16}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานโครงสร้างหลังคาเหล็ก", "name": "สีทาเหล็ก", "qty": 67.21, "unit": "ตร.ม.", "price": 114.0}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานโครงสร้างหลังคาเหล็ก", "name": "ไม้เชิงชาย เฌอร่า รุ่น ลบขอบ ผิวเรียบ ขนาด 15 x 300 x 1.6 ซม. สีธรรมชาติ", "qty": 17, "unit": "แผ่น", "price": 166.25}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานโครงสร้างหลังคาเหล็ก", "name": "ไม้เชิงชาย เฌอร่า รุ่น ลบขอบ ผิวเรียบ ขนาด 20 x 300 x 1.6 ซม. สีธรรมชาติ", "qty": 17, "unit": "แผ่น", "price": 239.4}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานโครงสร้างหลังคาเหล็ก", "name": "ไม้เชิงชาย ผิวเรียบ เฌอร่า รุ่น ลบขอบ ขนาด 20 x 400 x 1.6 ซม. สีธรรมชาติ", "qty": 32, "unit": "แผ่น", "price": 239.4}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานมุงหลังคา", "name": "หลังคาตรง ลอนสแนปล็อค ติดพียู 0.40 มม. Zasc Cool (เลือกสีภายหลัง)", "qty": 304.14, "unit": "ตร.ม.", "price": 418.0}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานมุงหลังคา", "name": "ครอบข้าง", "qty": 150, "unit": "ม.", "price": 313.5}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานมุงหลังคา", "name": "ครอบ 0.40TCT AZ150", "qty": 30, "unit": "ม.", "price": 313.5}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานมุงหลังคา", "name": "Screw ยิงแผ่น", "qty": 30, "unit": "ม.", "price": 617.5}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานมุงหลังคา", "name": "Screw ยิงแผ่น ปิดครอบ", "qty": 180, "unit": "ตร.ม.", "price": 332.5}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานมุงหลังคา", "name": "อุปกรณ์เบ็ดเตล็ด", "qty": 1, "unit": "เหมา", "price": 8640.25}, {"disc": "ST", "section": "ST4 โครงหลังคา", "group": "งานมุงหลังคา", "name": "รางน้ำฝน ไวนิล SCG SMART 3 ม. สีเทา พร้อมข้อต่อ", "qty": "", "unit": "ชุด", "price": 1425.0}, {"disc": "AR", "section": "AR", "group": "งานก่อผนัง", "name": "อิฐมวลเบา Q-CON ขนาด 20X 60X7.5 ซม.", "qty": 2115, "unit": "ก้อน", "price": 33.25}, {"disc": "AR", "section": "AR", "group": "งานก่อผนัง", "name": "ปูนสำเร็จรูปก่อบล็อกมวลเบา", "qty": 23, "unit": "ถุง", "price": 180.5}, {"disc": "AR", "section": "AR", "group": "งานก่อผนัง", "name": "ปูนซีเมนต์ ตราTPI 199 (50 กก./ ถุง)", "qty": 9, "unit": "ถุง", "price": 142.5}, {"disc": "AR", "section": "AR", "group": "งานก่อผนัง", "name": "ทรายหยาบ", "qty": 2, "unit": "ลบ.ม.", "price": 589.0}, {"disc": "AR", "section": "AR", "group": "งานก่อผนัง", "name": "หินเบอร์ 1-2", "qty": 3, "unit": "ลบ.ม.", "price": 665.0}, {"disc": "AR", "section": "AR", "group": "งานก่อผนัง", "name": "ไม้แบบหล่อคอนกรีต+ตะปู (นำมาใช้ต่อจากงานโครงสร้าง 70%)", "qty": 21, "unit": "ตร.ม.", "price": 57.0}, {"disc": "AR", "section": "AR", "group": "งานก่อผนัง", "name": "เหล็กเสริม RB dir 6 มม.", "qty": 12, "unit": "เส้น", "price": 148.2}, {"disc": "AR", "section": "AR", "group": "งานก่อผนัง", "name": "เหล็กเสริม RB dir 9 มม.", "qty": 24, "unit": "เส้น", "price": 68.4}, {"disc": "AR", "section": "AR", "group": "งานก่อผนัง", "name": "ลวดผูกเหล็กเสริม", "qty": 34, "unit": "ขด", "price": 93.1}, {"disc": "AR", "section": "AR", "group": "งานก่อผนัง", "name": "อิฐโชว์แนว 2 รู ทึบ", "qty": 1540, "unit": "ก้อน", "price": 33.25}, {"disc": "AR", "section": "AR", "group": "งานก่อผนัง", "name": "ปูนกาวตราจระเข้เขียว", "qty": 33, "unit": "ถุง", "price": 188.1}, {"disc": "AR", "section": "AR", "group": "งานฉาบผนัง", "name": "ปูนฉาบบล็อกมวลเบา TPI รุ่น TPI-M-210 ขนาด 50 กก.", "qty": 70, "unit": "ถุง", "price": 133.0}, {"disc": "AR", "section": "AR", "group": "งานฉาบผนัง", "name": "ตาข่ายสี่เหลี่ยม เบอร์ 24 ตาห่าง 1/2 นิ้ว MT ขนาด 0.90 x 30 เมตร", "qty": 4, "unit": "ม้วน", "price": 356.25}, {"disc": "AR", "section": "AR", "group": "งานฉาบผนัง", "name": "ปูนเสือซีเมนต์ ฉาบสูตรพิเศษ ปูนเสือพลัส ฉาบปรับระดับ", "qty": 101, "unit": "ถุง", "price": 156.75}, {"disc": "AR", "section": "AR", "group": "งานฉาบผนัง", "name": "ทรายละเอียด", "qty": 11, "unit": "ลบ.ม.", "price": 617.5}, {"disc": "AR", "section": "AR", "group": "งานฉาบผนัง", "name": "ซีเมนต์แต่งผิวบาง ชนิดเนื้อละเอียด จระเข้ รุ่น 1261 ขนาด 25 กก.", "qty": 12, "unit": "ถุง", "price": 341.05}, {"disc": "AR", "section": "AR", "group": "งานฉาบผนัง", "name": "ไมโครซีเมนต์ NO.09 พื้น-ผนังไร้รอยต่อ กันน้ำ ทนทาน | NINE", "qty": 1, "unit": "ถัง", "price": 1767.0}, {"disc": "AR", "section": "AR", "group": "งานฉาบผนัง", "name": "เซี้ยม ชวากร รุ่น มุมคม ขนาด 1.0 x 200 ซม. สีเทา", "qty": 320, "unit": "เส้น", "price": 23.75}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "โครงร่าว ซีลายน์", "qty": 101, "unit": "เส้น", "price": 78.85}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "โครงร่าวริม", "qty": 36, "unit": "เส้น", "price": 30.4}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "คลิปล็อค", "qty": 286, "unit": "ชิ้น", "price": 1.9}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "ตัวต่อโครง", "qty": 101, "unit": "ชิ้น", "price": 3.8}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "ขอล็อคโครง", "qty": 94, "unit": "ชุด", "price": 4.75}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "สปริงล็อค", "qty": 94, "unit": "ชุด", "price": 6.65}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "ลวดแขวนท่อนบน", "qty": 94, "unit": "ชุด", "price": 23.75}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "ฉากยึดท้องพื้น", "qty": 94, "unit": "ชุด", "price": 2.85}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "พุกเหล็ก", "qty": 94, "unit": "ชุด", "price": 3.8}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "แผ่นยิปซั่ม 120x240x0.9 ซม.", "qty": 41, "unit": "แผ่น", "price": 118.75}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "สกรูยิงแผ่นยิปซั่ม (กล่องละ 500 ตัว)", "qty": 4, "unit": "กล่อง", "price": 90.25}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "ปูนฉาบรอยต่อยิปซั่ม", "qty": 3, "unit": "ถุง", "price": 209.0}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "เทปผ้ายิปซั่มปิดรอยต่อ", "qty": 6, "unit": "ม้วน", "price": 142.5}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "แผ่นยิปซั่มชนิดกันชื้น 120x240x0.9 ซม.", "qty": 3, "unit": "แผ่น", "price": 180.5}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายใน", "name": "ฉนวนกันความร้อน เอสซีจี รุ่น STAY COOL หนา 75 มม. (3 นิ้ว) พรีเมี่ยม", "qty": 40, "unit": "ม้วน", "price": 379.05}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายนอก", "name": "เฌอร่า ผิวเรียบ รุ่น เซาะร่องวี 4 ขนาด 120x240x0.6 ซม.", "qty": 42, "unit": "แผ่น", "price": 323.0}, {"disc": "AR", "section": "AR", "group": "งานฝ้าเพดานภายนอก", "name": "สกรูยิงแผ่น (กล่องละ 500 ตัว)", "qty": 4, "unit": "กล่อง", "price": 90.25}, {"disc": "AR", "section": "AR", "group": "พื้นขัดมัน", "name": "ปูนซีเมนต์ 180 ksc. หนา 0.03 ม.", "qty": 3, "unit": "ลบ.ม.", "price": 1900.0}, {"disc": "AR", "section": "AR", "group": "พื้นขัดมัน", "name": "ปูนเพิ่มความแข็ง LANKO 243 ขนาด 25 กก.", "qty": 16, "unit": "ถุง", "price": 254.6}, {"disc": "AR", "section": "AR", "group": "พื้นขัดมัน", "name": "เส้นแบ่งทองเหลือง รุ่น 1.75 หุน", "qty": 21, "unit": "เส้น", "price": 114.0}, {"disc": "AR", "section": "AR", "group": "พื้นขัดมัน", "name": "จระเข้ เฟล็กซ์ ชิลด์ 20 กก", "qty": 3, "unit": "กระบ๋อง", "price": 2185.0}, {"disc": "AR", "section": "AR", "group": "พื้นปรับระดับสำหรับปูกระเบื้อง", "name": "ปูนซีเมนต์ ตราTPI 199 (50 กก./ถุง)", "qty": 145, "unit": "ถุง", "price": 142.5}, {"disc": "AR", "section": "AR", "group": "พื้นปรับระดับสำหรับปูกระเบื้อง", "name": "ปูนกาวซีเมนต์ จระเข้ รุ่นจระเข้เขียว (20 กก./ถุง)", "qty": 145, "unit": "ถุง", "price": 183.35}, {"disc": "AR", "section": "AR", "group": "พื้นปรับระดับสำหรับปูกระเบื้อง", "name": "ทรายหยาบปรับระดับ", "qty": 15, "unit": "ลบ.ม.", "price": 589.0}, {"disc": "EE", "section": "EE", "group": "PREPARATION WORKS งานเตรียมการ", "name": "งานเตรียมพื้นที่ / มาร์คตำแหน่ง / ประสานงาน กฟภ.", "qty": 1, "unit": "SET", "price": 4750.0}, {"disc": "EE", "section": "EE", "group": "ระบบเมนไฟฟ้าเข้าอาคารและตู้ Load Center (มิเตอร์ 3 เฟส 15(45)A)", "name": "PB / PULL BOX จุดรับสายเข้าอาคาร", "qty": 1, "unit": "SET", "price": 1425.0}, {"disc": "EE", "section": "EE", "group": "ระบบเมนไฟฟ้าเข้าอาคารและตู้ Load Center (มิเตอร์ 3 เฟส 15(45)A)", "name": "ตู้ Load Center 3 เฟส 30 ช่อง พร้อมบัสบาร์+กราวด์บาร์", "qty": 1, "unit": "SET", "price": 8075.0}, {"disc": "EE", "section": "EE", "group": "ระบบเมนไฟฟ้าเข้าอาคารและตู้ Load Center (มิเตอร์ 3 เฟส 15(45)A)", "name": "MCCB 15ka/ AT50 3P / MAIN", "qty": 1, "unit": "SET", "price": 2470.0}, {"disc": "EE", "section": "EE", "group": "ระบบเมนไฟฟ้าเข้าอาคารและตู้ Load Center (มิเตอร์ 3 เฟส 15(45)A)", "name": "THW 25 Sq.mm. MAIN", "qty": 80, "unit": "M", "price": 114.0}, {"disc": "EE", "section": "EE", "group": "ระบบเมนไฟฟ้าเข้าอาคารและตู้ Load Center (มิเตอร์ 3 เฟส 15(45)A)", "name": "THW 10 Sq.mm. GND + แท่งกราวด์ 2.4 ม.", "qty": 22, "unit": "M", "price": 38.0}, {"disc": "EE", "section": "EE", "group": "ระบบเมนไฟฟ้าเข้าอาคารและตู้ Load Center (มิเตอร์ 3 เฟส 15(45)A)", "name": "ท่อPVC 1.1/2\" สีเหลือง MAIN", "qty": 21, "unit": "M", "price": 54.15}, {"disc": "EE", "section": "EE", "group": "ระบบเมนไฟฟ้าเข้าอาคารและตู้ Load Center (มิเตอร์ 3 เฟส 15(45)A)", "name": "FITTING AND ACCESSORIES /วัสดุสิ้นเปลืองและอุปกรณ์ประกอบ", "qty": 1, "unit": "lot", "price": 1331.0}, {"disc": "EE", "section": "EE", "group": "ตู้โหลดไฟฟ้าภายในอาคาร", "name": "MCB 6ka / AT10 (แสงสว่างชั้น 1 / ชั้น 2)", "qty": 2, "unit": "SET", "price": 114.0}, {"disc": "EE", "section": "EE", "group": "ตู้โหลดไฟฟ้าภายในอาคาร", "name": "MCB 6ka / AT16 (เต้ารับ 6 วงจร + แอร์ 12k/18k 5 วงจร)", "qty": 11, "unit": "SET", "price": 114.0}, {"disc": "EE", "section": "EE", "group": "ตู้โหลดไฟฟ้าภายในอาคาร", "name": "MCB 6ka / AT20 (เต้ารับครัว + แอร์ 24k ×2)", "qty": 3, "unit": "SET", "price": 114.0}, {"disc": "EE", "section": "EE", "group": "ตู้โหลดไฟฟ้าภายในอาคาร", "name": "RCBO 30mA / AT20 (น้ำอุ่น 5 + ปั๊มน้ำ 1)", "qty": 6, "unit": "SET", "price": 807.5}, {"disc": "EE", "section": "EE", "group": "ตู้โหลดไฟฟ้าภายในอาคาร", "name": "MCB 6ka / AT16 SPARE", "qty": 4, "unit": "SET", "price": 114.0}, {"disc": "EE", "section": "EE", "group": "ระบบเดินสายไฟฟ้าและท่อร้อยสายภายในอาคาร", "name": "THW Ø - 2.5 Sq.mm.", "qty": 1900, "unit": "M", "price": 10.45}, {"disc": "EE", "section": "EE", "group": "ระบบเดินสายไฟฟ้าและท่อร้อยสายภายในอาคาร", "name": "PVC Ø - 1/2 \"", "qty": 640, "unit": "M", "price": 11.4}, {"disc": "EE", "section": "EE", "group": "ระบบเดินสายไฟฟ้าและท่อร้อยสายภายในอาคาร", "name": "กล่องพักสายเหลี่ยม TOP ขนาด 2 x 4 นิ้ว สีเหลือง", "qty": 30, "unit": "ใบ", "price": 23.75}, {"disc": "EE", "section": "EE", "group": "ระบบเดินสายไฟฟ้าและท่อร้อยสายภายในอาคาร", "name": "THW Ø - 4 Sq.mm. (วงจรครัว/สายวงจรย่อยรวม)", "qty": 240, "unit": "M", "price": 16.15}, {"disc": "EE", "section": "EE", "group": "ระบบเดินสายไฟฟ้าและท่อร้อยสายภายในอาคาร", "name": "THW 2.5 Sq.mm. (แอร์ 12k/18k ×5 + ปั๊มน้ำ)", "qty": 338, "unit": "M", "price": 10.45}, {"disc": "EE", "section": "EE", "group": "ระบบเดินสายไฟฟ้าและท่อร้อยสายภายในอาคาร", "name": "THW 4 Sq.mm. (แอร์ 24k ×2 + น้ำอุ่น 5 จุด)", "qty": 315, "unit": "M", "price": 16.15}, {"disc": "EE", "section": "EE", "group": "ระบบเดินสายไฟฟ้าและท่อร้อยสายภายในอาคาร", "name": "PVC Ø - 3/4 \"", "qty": 30, "unit": "M", "price": 14.25}, {"disc": "EE", "section": "EE", "group": "ระบบเดินสายไฟฟ้าและท่อร้อยสายภายในอาคาร", "name": "Waterproof Isolator Switch (จุด CDU)", "qty": 7, "unit": "SET", "price": 655.5}, {"disc": "EE", "section": "EE", "group": "ระบบเต้ารับไฟฟ้าภายในอาคาร", "name": "Panasonic Partio เต้ารับกราวด์คู่+ม่านนิรภัย หน้ากาก 2 ช่อง", "qty": 42, "unit": "set", "price": 242.25}, {"disc": "EE", "section": "EE", "group": "ระบบเต้ารับไฟฟ้าภายในอาคาร", "name": "Panasonic ชุดเต้ารับคู่แบบมีม่าน พร้อมสวิทซ์ควบคุม (เคาน์เตอร์ครัว)", "qty": 1, "unit": "set", "price": 384.75}, {"disc": "EE", "section": "EE", "group": "ระบบเต้ารับไฟฟ้าภายในอาคาร", "name": "Panasonic Partio เต้ารับกราวด์คู่มีม่านนิรภัย ฝาครอบกันน้ำ (WD)", "qty": 15, "unit": "set", "price": 621.3}, {"disc": "EE", "section": "EE", "group": "ระบบไฟฟ้าสำหรับพัดลม+ครื่องทำน้ำอุ่น", "name": "พัดลมโคจรติดเพดาน 56 นิ้ว พร้อมสวิตช์ปรับแรง", "qty": 5, "unit": "SET", "price": 2375.0}, {"disc": "EE", "section": "EE", "group": "ระบบไฟฟ้าสำหรับพัดลม+ครื่องทำน้ำอุ่น", "name": "เครื่องทำน้ำอุ่น 3,500W", "qty": 5, "unit": "SET", "price": 2840.5}, {"disc": "EE", "section": "EE", "group": "ระบบไฟฟ้าแสงสว่าง", "name": "ดาวน์ไลท์ LED 7W 560lm (3000K/6500K ตามแบบ) ภายใน", "qty": 20, "unit": "SET", "price": 64.12}, {"disc": "EE", "section": "EE", "group": "ระบบไฟฟ้าแสงสว่าง", "name": "ดาวน์ไลท์ LED 9W 900lm 6500K (โถง/ครัว/ทานอาหาร 300 lux)", "qty": 12, "unit": "SET", "price": 78.38}, {"disc": "EE", "section": "EE", "group": "ระบบไฟฟ้าแสงสว่าง", "name": "โคมกันน้ำภายนอก ชายคา/ระเบียง LED 7W", "qty": 6, "unit": "SET", "price": 284.05}, {"disc": "EE", "section": "EE", "group": "ระบบไฟฟ้าแสงสว่าง", "name": "โคมกันน้ำโรงจอดรถ LED 7W", "qty": 4, "unit": "SET", "price": 149.62}, {"disc": "EE", "section": "EE", "group": "ระบบไฟฟ้าแสงสว่าง", "name": "โคมไฟหัวเตียง/สปอต 3 ดวง LED 7W 640lm 3000K", "qty": 2, "unit": "ชุด", "price": 1425.0}, {"disc": "EE", "section": "EE", "group": "ระบบไฟฟ้าแสงสว่าง", "name": "Panasonic สวิตช์ทางเดียว หน้ากาก 1 ช่อง", "qty": 8, "unit": "SET", "price": 94.05}, {"disc": "EE", "section": "EE", "group": "ระบบไฟฟ้าแสงสว่าง", "name": "Panasonic สวิตช์ทางเดียว 2 ตัว หน้ากาก 2 ช่อง", "qty": 7, "unit": "SET", "price": 133.0}, {"disc": "EE", "section": "EE", "group": "ระบบไฟฟ้าแสงสว่าง", "name": "Panasonic สวิตช์ทางเดียว 3 ตัว หน้ากาก 3 ช่อง", "qty": 3, "unit": "SET", "price": 170.05}, {"disc": "EE", "section": "EE", "group": "ระบบไฟฟ้าแสงสว่าง", "name": "ดาวน์ไลท์ LED 9W 900lm 6500K (อเนกประสงค์/โถง 300 lux)", "qty": 17, "unit": "SET", "price": 78.38}, {"disc": "EE", "section": "EE", "group": "ระบบไฟฟ้าแสงสว่าง", "name": "โคมเพดาน LED 25W 1875lm 6500K (ส่วนซักล้าง)", "qty": 1, "unit": "SET", "price": 940.5}, {"disc": "SN", "section": "SN", "group": "งานวางท่อและวางระบบบำบัดน้ำเสีย", "name": "วงบ่อซีเมนต์ 1000x400 มม.", "qty": 12, "unit": "ลูก", "price": 845.5}, {"disc": "SN", "section": "SN", "group": "งานวางท่อและวางระบบบำบัดน้ำเสีย", "name": "ถังบำบัดน้ำเสีย PURE PS 1600 ลิตร", "qty": 2, "unit": "ชุด", "price": 6640.5}, {"disc": "SN", "section": "SN", "group": "งานวางท่อและวางระบบบำบัดน้ำเสีย", "name": "ถังดักไขมัน DOS G-TEK GT-05/GY-40L 40 ลิตร", "qty": 1, "unit": "ชุด", "price": 1890.5}, {"disc": "SN", "section": "SN", "group": "งานวางท่อและวางระบบบำบัดน้ำเสีย", "name": "บ่อพักน้ำเสีย 400x400x400 มม. พร้อมฝา", "qty": 13, "unit": "ชุด", "price": 475.0}, {"disc": "SN", "section": "SN", "group": "งานวางท่อและวางระบบบำบัดน้ำเสีย", "name": "ท่อ PVC ชั้น 8.5 ปลายบาน 6 นิ้ว ยาว 4 ม. (ท่อระบายรวม) — ยาวจริง 39.38 ม.", "qty": 10, "unit": "เส้น", "price": 1358.5}, {"disc": "SN", "section": "SN", "group": "งานวางท่อและวางระบบบำบัดน้ำเสีย", "name": "เหล็กเส้นกลมผิวเรียบ RB 9 มม. SR.24 (ยึด/รัดบ่อ-ถัง)", "qty": 10, "unit": "เส้น", "price": 147.39}, {"disc": "SN", "section": "SN", "group": "งานวางท่อและวางระบบบำบัดน้ำเสีย", "name": "คอนกรีตผสมเสร็จ 240 กก./ตร.ซม. (รองถัง/บ่อ)", "qty": 1, "unit": "ลบ.ม.", "price": 1919.0}, {"disc": "SN", "section": "SN", "group": "งานวางท่อและวางระบบบำบัดน้ำเสีย", "name": "ถังเก็บน้ำบนดิน DOS LIFE CHAMP 1500 ลิตร", "qty": 2, "unit": "ถัง", "price": 6555.0}, {"disc": "SN", "section": "SN", "group": "งานวางท่อและวางระบบบำบัดน้ำเสีย", "name": "ปั๊มน้ำอัตโนมัติ MITSUBISHI WP-205QS", "qty": 1, "unit": "ชุด", "price": 5605.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ข้อต่อกันซึม (Flashing Sleeve) ขนาด 2\"", "qty": 8, "unit": "อัน", "price": 171.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ข้อต่อกันซึม (Flashing Sleeve) ขนาด 4\"", "qty": 6, "unit": "อัน", "price": 608.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ท่อ PP-R PN10 Ø 20 มม. (1/2\") — ยาวจริง 64.63 ม.", "qty": 17, "unit": "เส้น", "price": 152.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ท่อ PVC Ø 35 มม. 1 1/4\" (ท่ออากาศ) — ยาวจริง 63.44 ม.", "qty": 16, "unit": "เส้น", "price": 114.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ท่อ PP-R PN10 Ø 25 มม. (3/4\") — 5.06 ม.", "qty": 3, "unit": "เส้น", "price": 209.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ท่อ PP-R PN10 Ø 32 มม. (1\" ท่อเมน) — 111.91 ม.", "qty": 30, "unit": "เส้น", "price": 304.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ท่อ PVC Class 8.5 Ø 55 มม. (2\") — 14.52 ม.", "qty": 4, "unit": "เส้น", "price": 259.35}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ท่อ PVC Class 8.5 Ø 65 มม. (2 1/2\") — 6.14 ม.", "qty": 2, "unit": "เส้น", "price": 361.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ท่อ PVC Class 8.5 Ø 80-90 มม. (3\") — 21.77 ม.", "qty": 7, "unit": "เส้น", "price": 494.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ท่อ PVC Class 8.5 Ø 100 มม. (4\") — 17.02 ม.", "qty": 5, "unit": "เส้น", "price": 869.25}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ข้องอ 90 PP-R Ø 20 มม.", "qty": 40, "unit": "อัน", "price": 14.25}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ข้องอ 90 PP-R Ø 25 มม.", "qty": 8, "unit": "อัน", "price": 23.75}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ข้องอ 90 หนา 2\" GP", "qty": 15, "unit": "อัน", "price": 38.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "สามทาง PP-R Ø 20 มม.", "qty": 10, "unit": "อัน", "price": 17.1}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ข้องอ 45 แบบหนา 2\" SCG หรือเทียบเท่า", "qty": 25, "unit": "อัน", "price": 47.5}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ข้องอ 45 แบบหนา 4\" SCG หรือเทียบเท่า", "qty": 20, "unit": "อัน", "price": 114.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "ข้อต่อยูแทรพ มีช่องระบาย 2\" SCG", "qty": 5, "unit": "อัน", "price": 285.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "สามทาง Y 4\" SCG หรือเทียบเท่า", "qty": 4, "unit": "อัน", "price": 228.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "สามทาง Y 2\" SCG หรือเทียบเท่า", "qty": 6, "unit": "อัน", "price": 114.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 1", "name": "อุปกรณ์เบ็ดเตล็ด ก้ามปู, กาว, เทปพันท่อ (~12% วัสดุ)", "qty": 1, "unit": "ชุด", "price": 4407.0}, {"disc": "SN", "section": "SN", "group": "งานเดินน้ำดีฝังผนัง ชั้นที่ 1", "name": "ท่อ PP-R PN10 Ø 20 มม.", "qty": 3, "unit": "เส้น", "price": 152.0}, {"disc": "SN", "section": "SN", "group": "งานเดินน้ำดีฝังผนัง ชั้นที่ 1", "name": "ข้อต่อตรงเกลียวใน PP-R 20 มม.×1/2\" (brass insert)", "qty": 5, "unit": "อัน", "price": 71.25}, {"disc": "SN", "section": "SN", "group": "งานเดินน้ำดีฝังผนัง ชั้นที่ 1", "name": "ข้องอ 90 เกลียวใน PP-R 20 มม.×1/2\" (brass insert)", "qty": 5, "unit": "อัน", "price": 80.75}, {"disc": "SN", "section": "SN", "group": "งานเดินน้ำดีฝังผนัง ชั้นที่ 1", "name": "อุปกรณ์เบ็ดเตล็ด ก้ามปู, กาว, เทปพันท่อ", "qty": 1, "unit": "ชุด", "price": 190.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 2", "name": "ท่อ PP-R PN10 Ø 20 มม. (1/2\") — ยาวจริง 22.84 ม.", "qty": 6, "unit": "เส้น", "price": 152.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 2", "name": "ท่อ PVC Ø 35 มม. 1 1/4\" (ท่ออากาศ) — 2.76 ม.", "qty": 1, "unit": "เส้น", "price": 114.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 2", "name": "ท่อ PP-R PN10 Ø 25 มม. (3/4\") — 5.47 ม.", "qty": 2, "unit": "เส้น", "price": 209.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 2", "name": "ท่อ PP-R PN10 Ø 32 มม. (1\") — 7.63 ม.", "qty": 2, "unit": "เส้น", "price": 304.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 2", "name": "ท่อ PVC Class 8.5 Ø 55 มม. (2\") — 14.56 ม.", "qty": 4, "unit": "เส้น", "price": 259.35}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 2", "name": "ท่อ PVC Class 8.5 Ø 80-90 มม. (3\") — 22.33 ม.", "qty": 6, "unit": "เส้น", "price": 494.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 2", "name": "ท่อ PVC Class 8.5 Ø 100 มม. (4\") — 16.11 ม.", "qty": 5, "unit": "เส้น", "price": 869.25}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 2", "name": "ข้องอ 45 แบบหนา 2\" SCG", "qty": 18, "unit": "อัน", "price": 47.5}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 2", "name": "ข้องอ 45 แบบหนา 4\" SCG", "qty": 24, "unit": "อัน", "price": 114.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 2", "name": "สามทาง Y 4\" SCG", "qty": 2, "unit": "อัน", "price": 228.0}, {"disc": "SN", "section": "SN", "group": "งานเดินเมนน้ำดีและท่อน้ำทิ้ง ชั้นที่ 2", "name": "สามทาง Y 2\" SCG", "qty": 4, "unit": "อัน", "price": 114.0}, {"disc": "SN", "section": "SN", "group": "งานเดินน้ำดีฝังผนัง ชั้นที่ 2", "name": "สามทางเกลียวใน PP-R 20 มม.×1/2\" (brass insert)", "qty": 4, "unit": "อัน", "price": 90.25}]; }
