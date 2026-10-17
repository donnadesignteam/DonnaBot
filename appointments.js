// ── ลงนัดติดตั้ง/วัดหน้างานผ่านแชท LINE ─────────────────────────────
// คำสั่ง: #นัด <ข้อความนัดแบบที่ทีมโพสต์ในกลุ่ม (มีรายการสินค้าต่อท้ายได้)> · #แก้ <ลูกค้า> <วันเวลาใหม่/ช่องที่แก้> (#เลื่อน ใช้แทนกันได้)
//        · #เพิ่มรายการ <ลูกค้า> + รายการสินค้า · #สรุป (ทุกโซน) / #สรุปกทม / #สรุปเชียงใหม่ / #สรุปเชียงราย · #ปฏิทิน [โซน] [เดือน]
// ระยะทดสอบ: ใช้ในกลุ่มทดสอบ (GROUP_TEST ใน index.js — 12ต.ค.69 ย้ายจากแชทส่วนตัว) และ **ไม่เขียนตาราง installations** (DRY_RUN)
//   · #นัด / #เลื่อน → AI อ่านข้อความ → การ์ดยืนยัน → กด ✅ แค่ตอบว่า "ถ้าใช้จริงจะบันทึกอะไร"
//   · #สรุป / การหางานของ #เลื่อน = อ่านตาราง installations จริง (อ่านอย่างเดียว)
// ใช้จริง (ปิด DRY_RUN): กด ✅ → saveNew / saveEdit เขียนลงเว็บแบบเดียวกับหน้าปฏิทินงานติดตั้งของ donnaweb
//   (เลข IN จากตัวนับกลาง · งานติดตั้งสร้างใบออเดอร์คู่ให้ · แก้แล้ว sync ไปใบออเดอร์ที่ผูกไว้)
// ตอบด้วย reply ทั้งหมด (ฟรี ไม่กินโควตาข้อความ LINE)

const crypto = require('crypto');
const { calendarMessage } = require('./calendar');
// ‼️ ชั่วคราว 12ต.ค.69 (user สั่ง): เปิดบันทึกลงเว็บจริงเพื่อลองในกลุ่มทดสอบ — คำสั่งยังใช้ได้เฉพาะ GROUP_TEST (index.js)
//    ลองเสร็จให้กลับเป็นโหมดทดสอบ: เปลี่ยนค่าตั้งต้นบรรทัดล่างกลับเป็น true (หรือตั้ง APPT_DRY_RUN=true ใน Railway)
const DRY_RUN_DEFAULT = false;
const DRY_RUN = process.env.APPT_DRY_RUN ? process.env.APPT_DRY_RUN !== 'false' : DRY_RUN_DEFAULT;
const TAG = DRY_RUN ? ' (ทดสอบ)' : '';

const ZONES = ['กทม', 'เชียงราย', 'เชียงใหม่'];
// แชทนี้ทำตัวเป็นกลุ่มไหน — กำหนดโซนที่ #สรุป/#เลื่อน ดู และโซนตั้งต้นของ #นัด เมื่อเดาโซนจากข้อความไม่ได้
// ระยะทดสอบ: กลุ่มทดสอบ = จำลองกลุ่ม "วัดหน้างาน&ติดตั้งลูกค้า" (เชียงราย+ต่างจังหวัด) ตามที่ user สั่ง 8ต.ค.69
const PROFILES = {
  north: { label: '#เชียงราย+ต่างจังหวัด', zones: ['เชียงราย', 'เชียงใหม่'], defaultZone: 'เชียงราย' },
  bkk: { label: '#กทม', zones: ['กทม'], defaultZone: 'กทม' },
};
const DONE = ['ติดตั้งเสร็จ', 'วัดหน้างานแล้ว'];
const TH_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

// รายการที่รอกดยืนยัน — เก็บในหน่วยความจำ (รีสตาร์ทแล้วหาย ให้พิมพ์ใหม่) อายุ 2 ชม.
const pending = new Map();
const newToken = () => Math.random().toString(36).slice(2, 10);
const keep = (obj) => {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > 2 * 3600e3) pending.delete(k);
  const t = newToken();
  pending.set(t, { ...obj, at: now });
  return t;
};

// วันนี้ตามเวลาไทย (YYYY-MM-DD)
const bkkToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const thaiDayLabel = (iso) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `วัน${TH_DAYS[wd]}ที่ ${d}/${m}/${y}`;
};
// appointment_datetime ในฐาน = timestamptz → แปลงเป็นวัน/เวลาไทย
const toBkk = (ts) => {
  if (!ts) return { date: '', time: '' };
  const d = new Date(new Date(ts).getTime() + 7 * 3600e3).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
};
// โซนของงาน — หลายแถวในเว็บไม่ได้กรอกโซน → เดาจากจังหวัด · เดาไม่ได้ = '' (ขึ้นในกลุ่ม "ยังไม่ระบุโซน" ไม่ให้หายเงียบ)
const zoneOf = (r) => {
  if (ZONES.includes(r.install_zone)) return r.install_zone;
  const p = String(r.province || '');
  if (/กรุงเทพ|กทม|นนทบุรี|ปทุมธานี|สมุทรปราการ|สมุทรสาคร|นครปฐม/.test(p)) return 'กทม';
  if (/เชียงใหม่|ลำพูน/.test(p)) return 'เชียงใหม่';
  if (/เชียงราย|พะเยา|ลำปาง|น่าน|แพร่/.test(p)) return 'เชียงราย';
  return '';
};
const digits = (s) => String(s || '').replace(/\D/g, '');
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// ── ให้ AI อ่านข้อความเป็น JSON ──
async function askJson(anthropic, system, text) {
  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system,
    messages: [{ role: 'user', content: text }],
  });
  const raw = res.content.map(c => c.text || '').join('');
  const m = raw.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

// ── แปลงรายการสินค้าด้วยตัวเดียวกับเว็บ ── (donnaweb /api/parse-items · กติกาอยู่ที่ lib/itemPrompt.ts ของเว็บที่เดียว)
// เข้าเว็บด้วยกุญแจบอท: header x-bot-key = env BOT_API_KEY (ตั้งค่าเดียวกันทั้ง Railway + Vercel · proxy.ts ของเว็บเปิดให้เฉพาะ /api/parse-items)
// สำรอง: cookie donna_auth จาก SITE_PASS (+SITE_USER) แบบเดียวกับ lib/auth.ts ของเว็บ
const webCookie = () => {
  const pass = process.env.SITE_PASS;
  if (!pass) return '';
  const tok = crypto.createHash('sha256').update(`${process.env.SITE_USER || 'donna'}:${pass}:donna-erp-v1`).digest('hex');
  return `donna_auth=${tok}`;
};
// ข้อความมีรายการสินค้าไหม — มีขนาด ก*ส (1.84*2.78) หรือ "= 2 ผืน/ชุด/เส้น/ชิ้น"
const hasItems = (text) => /\d\s*[*xX×]\s*[ส]?\s*\d|=\s*\d+\s*(ผืน|ชุด|เส้น|ชิ้น|ตัว|ม้วน|อัน)/.test(noUrl(text));
async function parseItems(text) {
  const res = await fetch(`${WEB_URL}/api/parse-items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bot-key': process.env.BOT_API_KEY || '', Cookie: webCookie() },
    body: JSON.stringify({ text }),
  });
  if (res.status === 401) throw new Error('บอทเข้าเว็บไม่ได้ — ต้องตั้ง BOT_API_KEY ค่าเดียวกันทั้งใน Railway และ Vercel (แล้ว Redeploy เว็บ)');
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(j.items)) throw new Error(j.error || `แปลงรายการไม่สำเร็จ (${res.status})`);
  return j.items;
}
// รายการ 1 ชิ้น → บรรทัดสั้นในการ์ด เช่น "ม่านลอนเทป S581 ขาวครีม 1.84*2.78 = 2 ผืน ฿3,681"
const itemLine = (it) => {
  const head = [it.fabric_type && /โปร่ง/.test(it.fabric_type) ? 'ผ้าโปร่ง' + (it.type || '') : it.type, it.color_code, it.color_name].filter(Boolean).join(' ');
  const size = [it.width, it.height && Number(it.height) ? it.height : ''].filter(v => v !== '' && v != null && Number(v) !== 0).join('*');
  const tail = [size, `= ${it.quantity ?? ''} ${it.unit || ''}`.trim(), it.pull_side, it.price ? `฿${Number(it.price).toLocaleString('en-US')}` : ''].filter(Boolean).join(' ');
  return `${it.room ? '📍' + it.room + ' ' : ''}${head} ${tail}`.trim();
};
const itemsText = (items) => items.map(it => '• ' + itemLine(it)).join('\n');

const NEW_SYSTEM = () => `คุณอ่านข้อความนัดงานติดตั้งผ้าม่านที่แอดมินร้าน Donna Design พิมพ์ แล้วตอบเป็น JSON อย่างเดียว ห้ามมีคำอื่น
วันนี้คือ ${bkkToday()} (ปี ค.ศ. · ถ้าเขียนปี พ.ศ. เช่น 2569 ให้ลบ 543 · ถ้าไม่ระบุปีให้ใช้วันที่ที่ใกล้วันนี้ที่สุดที่ยังไม่ผ่านไป)
รูปแบบ:
{"work_type":"งานติดตั้ง"|"งานวัดหน้างาน"|"งานแก้","date":"YYYY-MM-DD หรือ ''","time":"HH:MM หรือ ''",
 "platform":"LineOA"|"Facebook"|"Tiktok-Chat"|"Shopee-Chat"|"หน้าร้าน"|"" (ช่องทางที่ลูกค้าติดต่อมา ถ้าข้อความบอก เช่น "Line OA : Att" = LineOA),
 "customer_id":"ชื่อไลน์/ชื่อเฟซ/ชื่อร้านค้าออนไลน์ของลูกค้า (ไม่รวมคำว่า LineOA/Facebook)","customer_real_name":"ชื่อจริงลูกค้า","phone":"เบอร์ตัวเลขล้วน",
 "address":"ที่อยู่/ชื่อคอนโด/ห้อง","location_link":"ลิงก์แผนที่ถ้ามี","install_zone":"กทม"|"เชียงราย"|"เชียงใหม่"|"",
 "notes":"รายละเอียดอื่นที่สำคัญ เช่น ให้ช่างเอาอะไรไป ค่าติดตั้ง หมายเหตุ","missing":["ช่องสำคัญที่ไม่มีในข้อความ: วัน, เวลา, ลูกค้า, เบอร์, ที่อยู่"]}
กติกา: วัดหน้างาน/วัดขนาด = งานวัดหน้างาน · แก้งาน/รีเช็ค/ซ่อม = งานแก้ · นอกนั้น = งานติดตั้ง
‼️ ทุกช่อง: ใส่เฉพาะสิ่งที่มีในข้อความจริง ไม่มี = '' ห้ามเดา ห้ามแต่งเติม
‼️ phone = เบอร์โทรเท่านั้น ต้องขึ้นต้นด้วย 0 และมี 9–10 หลัก (เช่น 0900381117 หรือ 090-038-1117) · บ้านเลขที่ เลขห้อง หมู่ ซอย รหัสไปรษณีย์ (เช่น "219 98", "1/123", "57000") ไม่ใช่เบอร์ ให้อยู่ใน address · ไม่มีเบอร์ = ''
‼️ address = ที่อยู่ตามที่พิมพ์ ตั้งแต่บ้านเลขที่ถึงรหัสไปรษณีย์ ไม่ตัดเลขหน้าออก ไม่สลับลำดับ
‼️ customer_real_name ใส่เฉพาะเมื่อข้อความมีชื่อจริงแยกต่างหากจากชื่อไลน์ ห้ามคัดลอกจาก customer_id
‼️ notes = สิ่งที่ต้องไปทำ/วัด/ติดตั้ง ตามที่พิมพ์ (เช่น "วัดมุ้งจีบ") และรายละเอียดอื่น · ห้ามใส่วัน เวลา ชื่อ เบอร์ ที่อยู่ซ้ำลงใน notes
‼️ รายการสินค้าที่มีขนาด/จำนวน (เช่น "ม่านลอนเทป S581 1.84*2.78 = 2ผืน ฿3,681") ไม่ต้องใส่ใน notes — ระบบแปลงรายการแยกเอง
‼️ ถ้าข้อความไม่ได้บอกวัน (ไม่มีวันที่ ไม่มีชื่อวัน ไม่มีคำว่า วันนี้/พรุ่งนี้) ให้ date เป็น '' และใส่ "วัน" ใน missing — ห้ามเดาเป็นวันนี้ แม้จะมีเวลาบอกมาก็ตาม
install_zone: กรุงเทพ/ปริมณฑล/นนทบุรี/สมุทรปราการ = กทม · เชียงราย = เชียงราย · เชียงใหม่ = เชียงใหม่ · จังหวัดอื่นในภาคเหนือ (ลำปาง พะเยา ฯลฯ) = เชียงราย · ไม่รู้ = ''`;

// #แก้ (และ #เลื่อน แบบเดิม) — แก้ได้ทุกช่องในคำสั่งเดียว รวมวัน/เวลา (user สั่ง 8ต.ค.69 ไม่อยากพิมพ์ 2 คำสั่ง)
const EDIT_SYSTEM = () => `คุณอ่านคำสั่งแก้ไขงานนัดติดตั้งของร้านผ้าม่าน แล้วตอบเป็น JSON อย่างเดียว ห้ามมีคำอื่น
วันนี้คือ ${bkkToday()} (ปี พ.ศ. ให้ลบ 543 · ไม่ระบุปีให้ใช้วันที่ที่ใกล้วันนี้ที่สุดที่ยังไม่ผ่านไป)
{"query":"คำที่ใช้หางาน = ชื่อลูกค้า/ชื่อไลน์/เบอร์เดิม/เลข IN (ไม่ใช่ค่าใหม่)",
 "changes":{ ใส่เฉพาะช่องที่สั่งให้เปลี่ยน:
   "date":"YYYY-MM-DD","time":"HH:MM","work_type":"งานติดตั้ง"|"งานวัดหน้างาน"|"งานแก้","platform":"LineOA"|"Facebook"|"Tiktok-Chat"|"Shopee-Chat"|"หน้าร้าน",
   "customer_real_name":"","phone":"ตัวเลขล้วน","province":"ที่อยู่/จังหวัด","location_link":"","install_zone":"กทม"|"เชียงราย"|"เชียงใหม่","notes":"" },
 "notes_mode":"append" (เพิ่มต่อท้ายหมายเหตุเดิม = ค่าตั้งต้น) | "replace" (เมื่อสั่งชัดว่าเปลี่ยน/ลบหมายเหตุเดิม)}
ตัวอย่าง: "#แก้ Yothaka เป็น 11/10 10.00 เบอร์ 0922836430" → query "Yothaka", changes {date, time, phone}
"เลื่อนเป็นบ่ายโมง" = time 13:00 · "วัดหน้างาน" = work_type งานวัดหน้างาน
‼️ changes ใส่เฉพาะช่องที่คำสั่งสั่งให้เปลี่ยนจริง ห้ามเดา ห้ามเติมช่องอื่น · phone ต้องขึ้นต้นด้วย 0 มี 9–10 หลัก (บ้านเลขที่/รหัสไปรษณีย์ไม่ใช่เบอร์)
‼️ ใส่ date เฉพาะเมื่อคำสั่งบอกวันใหม่ชัดเจน — สั่งแก้แค่เวลา (เช่น "14:00") ห้ามใส่ date ห้ามเดาเป็นวันนี้ · คำว่า LineOA/Facebook ที่นำหน้าชื่อลูกค้าเป็นแค่ตัวบอกว่าลูกค้าคนไหน ไม่ใช่การสั่งแก้ช่องทาง`;

// ช่องที่แก้ได้ → ชื่อไทยในการ์ด (เรียงตามลำดับที่โชว์)
const EDIT_FIELDS = [['work_type', 'งาน'], ['platform', 'ช่องทาง'], ['customer_real_name', 'ชื่อจริง'], ['phone', 'เบอร์'], ['province', 'ที่อยู่'],
  ['location_link', 'แผนที่'], ['install_zone', 'โซน'], ['notes', 'หมายเหตุ']];

// ── การ์ดยืนยัน (Flex) ── โทนสีเดียวกับเว็บ donnaweb (globals.css) · ไม่ใช้อีโมจิ ของที่ต้องเตือนใช้ตัวหนังสือสีแดงอิฐแทน
// done = เขียวชุดเดียวกับป้าย "จัดส่งสำเร็จ" ในเว็บ (DONE_GREEN_BG / DONE_GREEN_INK ใน OrderDetailModal.tsx)
const C = { brand: '#9E6A49', dark: '#5C4534', done: { bg: '#E3F3E0', ink: '#1F8A3B' }, mute: '#8B7460', ink: '#3D2B1F', warn: '#C0563F', surface: '#FBF7F1', cream: '#F0E0D0', line: '#E4D6C6' };
// data ขึ้นต้นด้วย http = ปุ่มเปิดลิงก์ · นอกนั้น = ปุ่ม postback
const btn = (label, data, style, displayText) => ({
  type: 'button', style: style || 'secondary', height: 'sm', color: style === 'primary' ? C.brand : C.cream,
  action: /^https?:/.test(data) ? { type: 'uri', label, uri: data } : { type: 'postback', label, data, displayText: displayText || label } });
// ลิงก์ไปปฏิทินงานติดตั้งในเว็บ ผ่านหน้า /go (เบา เลือกหน้าคอม/มือถือให้เอง) — หน้าเว็บเลื่อนไปที่งานนั้นแล้วกระพริบ (?focus=) · openExternalBrowser = เปิดเบราว์เซอร์ของเครื่อง (ที่ล็อกอินเว็บไว้) แทนเบราว์เซอร์ในไลน์
const WEB_URL = (process.env.APPT_WEB_URL || 'https://donna-erp.vercel.app').replace(/\/+$/, '');
const webBtn = (id) => id ? [['เปิดในเว็บ', `${WEB_URL}/go?focus=${encodeURIComponent(id)}&openExternalBrowser=1`, 'primary']] : [];
// rows = [หัวข้อ, ค่า, 'warn'?] — ใส่ 'warn' = ค่านั้นเป็นสีเตือน
// color = สีพื้นหัวการ์ด (ตัวหนังสือขาว) หรือ { bg, ink }
function card(title, rows, buttons, color = C.brand) {
  const head = typeof color === 'string' ? { bg: color, ink: '#FFFFFF' } : color;
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: head.bg, paddingAll: '16px',
        contents: [{ type: 'text', text: title, color: head.ink, weight: 'bold', size: 'md', wrap: true }] },
      body: { type: 'box', layout: 'vertical', spacing: 'md', backgroundColor: C.surface, paddingAll: '16px',
        contents: rows.filter(([, v]) => v).map(([k, v, tone]) => ({
          type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: k, color: C.mute, size: 'sm', flex: 3 },
            { type: 'text', text: String(v), color: tone === 'warn' ? C.warn : C.ink, weight: tone === 'warn' ? 'bold' : 'regular', size: 'sm', flex: 7, wrap: true },
          ] })) },
      footer: buttons.length ? { type: 'box', layout: 'horizontal', spacing: 'sm', backgroundColor: C.surface, paddingAll: '12px',
        contents: buttons.map(([label, data, style]) => btn(label, data, style)) } : undefined,
      styles: buttons.length ? { footer: { separator: true, separatorColor: C.line } } : undefined,
    },
  };
}

// ใช้ในการ์ด/คำตอบยืนยัน · วันอาทิตย์เตือนไว้ (ปฏิทินในเว็บถือว่าร้านปิดวันอาทิตย์)
const isSunday = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0; };
const whenText = (date, time) => date
  ? `${thaiDayLabel(date)}${time ? ' เวลา ' + time + ' น.' : ' (ยังไม่มีเวลา)'}${isSunday(date) ? ' · วันอาทิตย์ร้านปิด' : ''}`
  : 'ยังไม่มีวัน';
const whenTone = (date) => (!date || isSunday(date) ? 'warn' : '');

// ข้อความมีอะไรบอกวันไหม — 9/10, วันที่ 9, ชื่อวัน, ชื่อเดือน, วันนี้/พรุ่งนี้ (ตัดลิงก์ออกก่อน · 13.00 กับ 13:00 = เวลา ไม่นับ)
const hasDateHint = (text) => /(?<!\d)\d{1,2}\s*\/\s*\d{1,2}(?!\d)|วันที่\s*\d|วันนี้|พรุ่งนี้|มะรืน|จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์|สัปดาห์หน้า|ม\.ค|ก\.พ|มี\.ค|เม\.ย|พ\.ค|มิ\.ย|ก\.ค|ส\.ค|ก\.ย|ต\.ค|พ\.ย|ธ\.ค|มกรา|กุมภา|มีนา|เมษา|พฤษภา|มิถุนา|กรกฎา|สิงหา|กันยา|ตุลา|พฤศจิ|ธันวา/
  .test(String(text).replace(/https?:\/\/\S+/g, ' '));

// ── ตัวกันค่าที่ AI เดาเอง ── (12ต.ค.69: #นัด ไม่บอกวันแต่ได้วันนี้ · #แก้ สั่งแค่เวลาแต่วันเปลี่ยนเป็นวันนี้)
// หลัก: ค่าที่ AI ตอบมาจะถูกใช้ก็ต่อเมื่อ "ข้อความที่พิมพ์" มีหลักฐานของค่านั้น · ไม่มีหลักฐาน = ทิ้ง แล้วให้คนเห็นว่ายังขาด
const noUrl = (t) => String(t || '').replace(/https?:\/\/\S+/g, ' ');
const hasTimeHint = (text) => /(?<!\d)\d{1,2}\s*[:.]\s*\d{2}(?!\d)|\d\s*(โมง|ทุ่ม|น\.)|เที่ยง|บ่าย|โมงเช้า|ตอนเช้า|ตอนเย็น|ตีห้า/.test(noUrl(text));
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(Date.parse(d + 'T00:00:00Z'));
const normTime = (t) => { const m = String(t || '').match(/^(\d{1,2})[:.](\d{2})$/); return m && +m[1] < 24 && +m[2] < 60 ? m[1].padStart(2, '0') + ':' + m[2] : ''; };
// คู่ วัน/เดือน ที่พิมพ์มาในข้อความ เช่น 13/10 · 13/10/69 · 13/10/2569 (บ้านเลขที่ 12/5 ก็ติดมาด้วย จึงใช้แค่ "ยืนยัน" วันที่ AI ตอบ ไม่ใช้สร้างวันเอง)
const PAIR_RE = /(?<![\d\/])(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2}|\d{4}))?(?![\d\/])/g;
function datePairs(text) {
  const out = [];
  for (const m of noUrl(text).matchAll(PAIR_RE)) { const d = +m[1], mo = +m[2]; if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) out.push({ d, mo, y: m[3] ? +m[3] : 0 }); }
  return out;
}
// วันที่ AI ตอบเชื่อได้ไหม → คืนวันที่ใช้ได้ หรือ '' (ไม่มีหลักฐานในข้อความ)
//   · ตรงกับคู่ วัน/เดือน ในข้อความ = ใช้ได้ และคำนวณปีเอง (ไม่ระบุปี = ครั้งที่ใกล้สุดที่ยังไม่ผ่าน)
//   · ไม่ตรงคู่ไหน แต่ข้อความมีคำบอกวัน (ศุกร์นี้ / พรุ่งนี้ / วันที่ 15 / 20 ต.ค.) = เชื่อ AI
//   · นอกนั้น (เช่น ข้อความมีแต่เวลา) = ทิ้ง
function trustedDate(aiDate, text) {
  if (!validDate(aiDate)) return '';
  const [, am, ad] = aiDate.split('-').map(Number);
  const pair = datePairs(text).find(p => p.d === ad && p.mo === am);
  if (pair) {
    const today = bkkToday(), y0 = +today.slice(0, 4);
    let y = pair.y; if (y) { if (y < 100) y += 2500; if (y > 2400) y -= 543; }
    const mk = (yy) => `${yy}-${String(am).padStart(2, '0')}-${String(ad).padStart(2, '0')}`;
    const out = y ? mk(y) : (mk(y0) >= today ? mk(y0) : mk(y0 + 1));
    return validDate(out) && new Date(out + 'T00:00:00Z').getUTCDate() === ad ? out : '';
  }
  return hasDateHint(noUrl(text).replace(PAIR_RE, ' ')) ? aiDate : '';
}
// ช่องทางจากข้อความ — หาเองจากคำที่พิมพ์ (ต้องตรงกับตัวเลือก PLATFORMS ของหน้าปฏิทินในเว็บ)
const PLATFORM_OK = ['LineOA', 'Facebook', 'Tiktok-Chat', 'Shopee-Chat', 'หน้าร้าน', 'Tiktok', 'Shopee', 'Lazada'];
function platformFromText(text) {
  const t = noUrl(text);
  if (/line\s*-?\s*oa|ไลน์\s*โอเอ|ไลน์โอเอ/i.test(t)) return 'LineOA';
  if (/facebook|เฟซบุ๊ก|เฟสบุ๊ค|เฟสบุ๊ก|(?<![a-z])fb(?![a-z])|เพจ/i.test(t)) return 'Facebook';
  if (/tiktok|ติ๊กต็อก|ติ๊กตอก/i.test(t)) return 'Tiktok-Chat';
  if (/shopee|ช้อปปี้/i.test(t)) return 'Shopee-Chat';
  if (/หน้าร้าน|walk\s*-?\s*in/i.test(t)) return 'หน้าร้าน';
  return '';
}
// ล้างค่าที่ไม่มีหลักฐานในข้อความ · f = ก้อนค่าที่ AI ตอบ (ของ #นัด หรือ changes ของ #แก้) · คืนรายชื่อช่องที่ถูกทิ้ง
function sanitize(f, text, { edit = false } = {}) {
  const dropped = [];
  const drop = (k) => { if (f[k] != null && f[k] !== '') dropped.push(k); if (edit) delete f[k]; else f[k] = ''; };
  // วัน: ต้องมีหลักฐานในข้อความ (trustedDate) · ไกลจากวันนี้เกิน 1 ปี = ทิ้ง
  if (f.date) { const d = trustedDate(f.date, text); if (d) f.date = d; else drop('date'); }
  if (f.date && Math.abs(Date.parse(f.date + 'T00:00:00Z') - Date.parse(bkkToday() + 'T00:00:00Z')) > 366 * 86400e3) drop('date');
  // เวลา
  if (f.time) { const t = normTime(f.time); if (!t || !hasTimeHint(text)) drop('time'); else f.time = t; }
  // เบอร์: ต้องเป็นเลข 9–10 หลักที่มีอยู่ในข้อความจริง
  // (บ้านเลขที่ "219 98" / รหัสไปรษณีย์ ไม่ผ่าน: ต้องขึ้นต้น 0 และยาว 9–10 หลัก)
  if (f.phone) { const d = digits(f.phone); if (!/^0\d{8,9}$/.test(d) || !digits(noUrl(text)).includes(d)) drop('phone'); else f.phone = d; }
  // ชื่อลูกค้า: ต้องเป็นคำที่อยู่ในข้อความ (กัน AI แต่งชื่อ/หยิบคำอื่นมาใส่) · ชื่อจริงซ้ำกับชื่อไลน์ = ไม่ใช่ชื่อจริง
  const inText = (v) => norm(v).length >= 1 && norm(noUrl(text)).includes(norm(v));
  if (f.customer_id && !inText(f.customer_id)) drop('customer_id');
  if (f.customer_real_name) {
    const real = String(f.customer_real_name).replace(/^คุณ\s*/, '');
    if (!inText(real) || (!edit && f.customer_id && norm(real) === norm(f.customer_id))) drop('customer_real_name');
  }
  // ลิงก์แผนที่: ต้องเป็นลิงก์ที่อยู่ในข้อความ (AI พิมพ์ลิงก์เพี้ยน = ใช้ลิงก์จากข้อความแทน)
  const url = (String(text).match(/https?:\/\/\S+/) || [''])[0];
  if (f.location_link && !String(text).includes(f.location_link)) { if (url) f.location_link = url; else drop('location_link'); }
  // โซน / ชนิดงาน / ช่องทาง: ต้องเป็นค่าที่เว็บรู้จัก
  if (f.install_zone && !ZONES.includes(f.install_zone)) drop('install_zone');
  if (f.work_type && !STATUS_BY_TYPE[f.work_type]) drop('work_type');
  const pf = platformFromText(text);
  if (pf && !edit) f.platform = pf; else if (f.platform && !PLATFORM_OK.includes(f.platform)) drop('platform');
  if (edit) {
    // "#แก้ lineoa: test 14:00" — คำว่า lineoa แค่บอกว่าลูกค้าคนไหน ไม่ใช่สั่งแก้ช่องทาง → แก้ช่องทางเฉพาะเมื่อพิมพ์คำว่า ช่องทาง/แพลตฟอร์ม
    if (f.platform && !/ช่องทาง|แพลตฟอร์ม|platform/i.test(text)) drop('platform');
    // #แก้: ช่องที่ไม่ได้สั่งชัดในข้อความ ไม่แตะ
    if (f.install_zone && !/โซน|กทม|กรุงเทพ|เชียงราย|เชียงใหม่/.test(text)) drop('install_zone');
    if (f.work_type && !/ติดตั้ง|วัด|งานแก้|แก้งาน|รีเช็ค|ซ่อม/.test(text)) drop('work_type');
  }
  return dropped;
}

// ── #นัด ──
async function handleNew(ctx, replyToken, text) {
  const { client, anthropic, profile } = ctx;
  if (!text) return reply(client, replyToken, 'พิมพ์ #นัด ตามด้วยรายละเอียดนัด เช่น\n#นัด ติดตั้ง ศุกร์ 9/10 10.00\nLineOA: Att 0900381117\nคอนโด notting hill ห้อง 1/123\nhttps://maps.app.goo.gl/...');
  // มีรายการสินค้าในข้อความ → แปลงด้วยตัวเดียวกับเว็บไปพร้อมกัน (ไม่มี = ไม่เรียก ประหยัดค่า AI)
  const itemsP = hasItems(text) ? parseItems(text).catch(err => ({ error: err.message || String(err) })) : Promise.resolve([]);
  const [a, parsed] = await Promise.all([askJson(anthropic, NEW_SYSTEM(), text), itemsP]);
  if (!a) return reply(client, replyToken, 'อ่านข้อความไม่ออก ลองพิมพ์ใหม่อีกทีนะคะ');
  a.items = Array.isArray(parsed) ? parsed : [];
  const itemErr = Array.isArray(parsed) ? '' : parsed.error;
  // AI ชอบเดาวันเป็น "วันนี้" ตอนข้อความมีแต่เวลา (12ต.ค.69 user ลองแล้วเจอ) → ข้อความไม่มีอะไรบอกวันเลย = ล้างวันทิ้ง ให้ขึ้น "ยังไม่มีวัน"
  const dropped = sanitize(a, text);
  a.missing = [...(a.missing || []), ...dropped, ...(a.date ? [] : ['date']), ...(a.time ? [] : ['time'])];
  let zoneNote = '';
  if (!ZONES.includes(a.install_zone) && profile) {
    a.install_zone = profile.defaultZone; zoneNote = ' (ตามกลุ่ม)';
    a.missing = (a.missing || []).filter(x => !/zone|โซน/.test(x));
  }
  const t = keep({ kind: 'new', data: a });
  // ช่องที่ขาด — AI บางทีตอบเป็นชื่อฟิลด์อังกฤษ แปลงเป็นไทยให้อ่านง่าย
  const TH = { date: 'วัน', time: 'เวลา', customer_id: 'ชื่อไลน์ลูกค้า', customer_real_name: 'ชื่อจริง', phone: 'เบอร์', address: 'ที่อยู่', location_link: 'แผนที่', install_zone: 'โซน', platform: 'ช่องทาง', work_type: 'ชนิดงาน' };
  const missing = [...new Set((a.missing || []).filter(Boolean).map(x => TH[x] || x))];
  const past = a.date && a.date < bkkToday();
  // ลูกค้าคนนี้มีงานค้างในเว็บอยู่แล้ว (เช่น ลงไว้แต่ยังไม่มีวัน) → เตือน กันลงซ้ำเป็น 2 แถว
  let dup = '';
  try {
    const q = digits(a.phone).length >= 6 ? a.phone : a.customer_id || a.customer_real_name;
    const same = q ? await findJobs(ctx.supabase, q, profile) : [];
    if (same.length) dup = same.slice(0, 3).map(jobLabel).join('\n') + '\nถ้าเป็นงานเดียวกัน กด "แก้" แล้วใช้ #แก้ แทน';
  } catch (err) { console.error('appt dup check:', err.message || err); }
  const rows = [
    ['งาน', a.work_type], ['ช่องทาง', a.platform], ['วันนัด', whenText(a.date, a.time) + (past ? ' · วันนี้ผ่านไปแล้ว' : ''), past ? 'warn' : whenTone(a.date)], ['ลูกค้า', a.customer_id], ['ชื่อจริง', a.customer_real_name],
    ['เบอร์', a.phone], ['ที่อยู่', a.address], ['แผนที่', a.location_link], a.install_zone ? ['โซน', a.install_zone + zoneNote] : ['โซน', 'ไม่รู้โซน', 'warn'],
    ['หมายเหตุ', a.notes], ['รายการ', a.items.length ? itemsText(a.items) : ''],
    ['รายการ', itemErr ? 'แปลงรายการไม่สำเร็จ: ' + itemErr : '', 'warn'],
    ['รายการ', a.items.length && a.work_type !== 'งานติดตั้ง' ? 'รายการจะบันทึกเฉพาะงานติดตั้ง (ลงในใบออเดอร์คู่)' : '', 'warn'],
    ['ยังขาด', missing.length ? missing.join(', ') : '', 'warn'], ['มีงานเดิม', dup, 'warn'],
  ];
  await client.replyMessage({ replyToken, messages: [card('ลงนัดใหม่' + TAG, rows,
    [['ยืนยัน', `appt:ok:${t}`, 'primary'], ['แก้', `appt:edit:${t}`]])] });
}

// หางานจากคำค้น (อ่านอย่างเดียว) — งานที่ยังไม่เสร็จ นัดตั้งแต่ 30 วันก่อน หรือยังไม่มีวัน
// done: true = หาเฉพาะงานที่ปิดแล้ว (ใช้บอกเหตุผลตอน #แก้ หาไม่เจอ)
async function findJobs(supabase, query, profile, { done = false } = {}) {
  const since = new Date(Date.now() - 30 * 86400e3).toISOString();
  const { data, error } = await supabase.from('installations')
    .select('id, serial_no, appointment_datetime, work_type, customer_id, customer_real_name, phone, province, location_link, notes, install_zone, installation_status, source_order_id, platform, price, entered_by')
    .or(`appointment_datetime.gte.${since},appointment_datetime.is.null`)
    .order('appointment_datetime', { ascending: true, nullsFirst: false })
    .limit(800);
  if (error) throw error;
  const q = String(query || '').trim();
  const qd = digits(q), qn = norm(q);
  const serial = (q.match(/^IN\s*0*(\d+)$/i) || [])[1];
  return (data || []).filter(r => DONE.includes(r.installation_status) === done)
    .filter(r => !profile || ['', ...profile.zones].includes(zoneOf(r)))   // เฉพาะโซนของกลุ่มนี้ (+งานที่ยังไม่ระบุโซน)
    .filter(r => {
    if (serial) return String(Number(r.serial_no)) === serial;
    if (qd.length >= 6 && digits(r.phone).includes(qd)) return true;
    if (qn.length >= 2 && (norm(r.customer_id).includes(qn) || norm(r.customer_real_name).includes(qn))) return true;
    return false;
  });
}
const jobLabel = (r) => {
  const { date, time } = toBkk(r.appointment_datetime);
  return `${r.serial_no ? 'IN' + String(r.serial_no).padStart(4, '0') + ' ' : ''}${r.customer_id || r.customer_real_name || '-'} · ${r.work_type || ''} · ${date ? date.slice(8, 10) + '/' + date.slice(5, 7) + (time ? ' ' + time : '') : 'ยังไม่มีวัน'}`;
};

const shortLabel = (r) => {
  const { date, time } = toBkk(r.appointment_datetime);
  const when = date ? `${Number(date.slice(8, 10))}/${Number(date.slice(5, 7))}${time ? ' ' + time : ''}` : 'ไม่มีวัน';
  const sn = r.serial_no ? 'IN' + String(r.serial_no).padStart(4, '0') + ' ' : '';
  return `${sn}${when} ${r.customer_id || r.customer_real_name || ''}`.slice(0, 40);
};

// ค่าใหม่ของงานหลังแก้ (ยังไม่บันทึก) — วัน/เวลาที่ไม่ได้สั่งเปลี่ยนใช้ของเดิม · หมายเหตุต่อท้ายของเดิมเว้นแต่สั่งให้แทน
function applyEdit(job, a) {
  const c = a.changes || {};
  const old = toBkk(job.appointment_datetime);
  const after = { date: c.date || old.date, time: c.time || old.time };
  for (const [f] of EDIT_FIELDS) {
    if (c[f] == null || c[f] === '') continue;
    if (String(c[f]).trim() === String(job[f] || '').trim()) continue;   // เหมือนของเดิม = ไม่ต้องแก้
    after[f] = f === 'notes' && a.notes_mode !== 'replace' && job.notes ? `${job.notes}\n${c.notes}` : c[f];
  }
  return after;
}

// มีอะไรเปลี่ยนจริงไหม (ค่าที่สั่งอาจเหมือนของเดิมทั้งหมด)
function hasChange(job, a) {
  const c = a.changes || {}, old = toBkk(job.appointment_datetime), after = applyEdit(job, a);
  return (c.date && c.date !== old.date) || (c.time && c.time !== old.time) || EDIT_FIELDS.some(([f]) => after[f] !== undefined);
}
const sameReply = (job) => `ข้อมูลของ ${jobLabel(job)} ตรงกับที่พิมพ์อยู่แล้ว ไม่ต้องแก้อะไรค่ะ`;

function editCard(job, a, t) {
  const c = a.changes || {};
  const old = toBkk(job.appointment_datetime);
  const after = applyEdit(job, a);
  const rows = [['ใบงาน', jobLabel(job)]];
  if ((c.date && c.date !== old.date) || (c.time && c.time !== old.time)) rows.push(['วันนัด', `${old.date ? whenText(old.date, old.time) : 'ยังไม่มีวัน'}\n→ ${whenText(after.date, after.time)}`]);
  for (const [f, label] of EDIT_FIELDS) {
    if (after[f] === undefined) continue;
    const was = String(job[f] || '-');
    rows.push([label, f === 'notes' && a.notes_mode !== 'replace' && job.notes ? `เพิ่มต่อท้าย: ${c.notes}` : `${was.length > 60 ? was.slice(0, 60) + '…' : was}\n→ ${after[f]}`]);
  }
  return card('แก้ไขงาน' + TAG, rows, [['ยืนยัน', `appt:ok:${t}`, 'primary'], ['ยกเลิก', `appt:edit:${t}`]], C.dark);
}

// ── #แก้ (และ #เลื่อน) ──
async function handleEdit(ctx, replyToken, text) {
  const { client, anthropic, supabase, profile } = ctx;
  if (!text) return reply(client, replyToken, 'พิมพ์ #แก้ ตามด้วยลูกค้าและสิ่งที่จะแก้ เช่น\n#แก้ Yothaka เป็น 11/10 10.00\n#แก้ IN0131 เบอร์ 0922836430 หมายเหตุ เอาน้องอ๋องไปด้วย\n(อ้างงานด้วยชื่อไลน์ ชื่อจริง เบอร์ หรือเลข IN ก็ได้)');
  const a = await askJson(anthropic, EDIT_SYSTEM(), text);
  if (!a || !a.query) return reply(client, replyToken, 'ไม่รู้ว่าจะแก้งานของใคร ลองพิมพ์ชื่อลูกค้า เบอร์ หรือเลข IN ด้วยนะคะ');
  a.changes = Object.fromEntries(Object.entries(a.changes || {}).filter(([, v]) => v != null && v !== ''));
  sanitize(a.changes, text, { edit: true });   // สั่งแก้แค่เวลา → ไม่ให้วัน (ที่ AI เดาเป็นวันนี้) หลุดเข้ามา
  if (!Object.keys(a.changes).length) return reply(client, replyToken, `เจอคำว่า "${a.query}" แต่ไม่รู้ว่าจะแก้อะไร ลองพิมพ์ใหม่ เช่น "#แก้ ${a.query} เป็น 15/10 13.00" หรือ "#แก้ ${a.query} เบอร์ 08xxxxxxxx"`);
  const jobs = await findJobs(supabase, a.query, profile);
  if (!jobs.length) {
    // 13ต.ค.69 user ค้น IN0170 ไม่เจอเพราะงานถูกกดเป็น "วัดหน้างานแล้ว" ในเว็บ → บอกเหตุผลตรงๆ ไม่ให้เข้าใจว่าหาชื่อไม่เจอ
    const closed = await findJobs(supabase, a.query, profile, { done: true });
    if (closed.length) return reply(client, replyToken, `เจอ ${jobLabel(closed[0])}${closed.length > 1 ? ` และอีก ${closed.length - 1} งาน` : ''} แต่งานนี้ปิดแล้ว (สถานะ "${closed[0].installation_status}")
บอทแก้ได้เฉพาะงานที่ยังไม่เสร็จ ถ้าจะแก้ให้เปลี่ยนสถานะในเว็บกลับก่อน หรือแก้ในเว็บได้เลยค่ะ`);
  }
  if (!jobs.length) return reply(client, replyToken, `ไม่เจองานที่ยังไม่เสร็จของ "${a.query}" ในปฏิทินงานติดตั้ง${profile ? ' (ค้นเฉพาะโซน ' + profile.zones.join('/') + ' + งานที่ยังไม่ระบุโซน)' : ''}\nลองค้นด้วยเบอร์ หรือเลข IN แทนได้ค่ะ`);
  if (jobs.length === 1) {
    if (!hasChange(jobs[0], a)) return reply(client, replyToken, sameReply(jobs[0]));
    const t = keep({ kind: 'edit', job: jobs[0], data: a });
    return client.replyMessage({ replyToken, messages: [editCard(jobs[0], a, t)] });
  }
  // เจอหลายงาน → ให้เลือก (ปุ่มละงาน สูงสุด 4)
  const t = keep({ kind: 'pick', jobs: jobs.slice(0, 4), data: a });
  const msg = card(`เจอ ${jobs.length} งาน — เลือกงานที่จะแก้`, [['ค้นด้วย', a.query]], [], C.dark);
  // ป้ายปุ่ม LINE ยาวได้ 40 ตัว → ใส่แค่เลข IN + วันเวลา + ชื่อ (ชื่อยาวโดนตัดท้ายแทนเวลา)
  msg.contents.footer = { type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: C.surface, paddingAll: '12px',
    contents: jobs.slice(0, 4).map((j, i) => btn(shortLabel(j), `appt:pick:${t}:${i}`, '', jobLabel(j))) };
  return client.replyMessage({ replyToken, messages: [msg] });
}

// ── #เพิ่มรายการ ── บรรทัดแรก = ลูกค้า (ชื่อไลน์/ชื่อจริง/เบอร์/เลข IN) · บรรทัดถัดไป = รายการสินค้า (แปลงด้วยตัวเดียวกับเว็บ)
// ต่อท้ายรายการในใบออเดอร์คู่ของงานติดตั้งนั้น (ไม่ทับรายการเดิม)
function addItemsCard(job, items, t) {
  return card('เพิ่มรายการ' + TAG, [['ใบงาน', jobLabel(job)], ['เพิ่ม', itemsText(items)],
    ['ต้องดู', job.work_type !== 'งานติดตั้ง' ? `งานนี้เป็น${job.work_type || 'งานอื่น'} ไม่มีใบออเดอร์ — เพิ่มรายการได้เฉพาะงานติดตั้ง` : '', 'warn']],
    job.work_type === 'งานติดตั้ง' ? [['ยืนยัน', `appt:ok:${t}`, 'primary'], ['ยกเลิก', `appt:edit:${t}`]] : [['ยกเลิก', `appt:edit:${t}`]], C.dark);
}
async function handleAddItems(ctx, replyToken, text) {
  const { client, supabase, profile } = ctx;
  const [first, ...rest] = text.split('\n');
  const body = rest.join('\n').trim();
  // "Line OA : Test" → "Test" (คำบอกช่องทางไม่ใช่ชื่อ)
  const query = first.replace(/^\s*(line\s*-?\s*oa|ไลน์\s*โอเอ|facebook|fb|เฟส\S*|tiktok\S*|shopee\S*|ช้อปปี้)\s*[:：]?\s*/i, '').trim();
  if (!query || !body) return reply(client, replyToken, 'พิมพ์ #เพิ่มรายการ ตามด้วยชื่อลูกค้าในบรรทัดแรก แล้วขึ้นบรรทัดใหม่ใส่รายการ เช่น\n#เพิ่มรายการ Line OA : Test\nม่านลอนเทป\nS581 ขาวครีม\n1.84*2.78 = 2ผืน ฿3,681');
  const [jobs, items] = await Promise.all([findJobs(supabase, query, profile), parseItems(body)]);
  if (!items.length) return reply(client, replyToken, 'อ่านรายการสินค้าไม่ออก ลองพิมพ์ใหม่อีกทีนะคะ');
  if (!jobs.length) return reply(client, replyToken, `ไม่เจองานที่ยังไม่เสร็จของ "${query}" ในปฏิทินงานติดตั้ง\nลองค้นด้วยเบอร์ หรือเลข IN แทนได้ค่ะ`);
  if (jobs.length === 1) {
    const t = keep({ kind: 'items', job: jobs[0], items });
    return client.replyMessage({ replyToken, messages: [addItemsCard(jobs[0], items, t)] });
  }
  const t = keep({ kind: 'pickitems', jobs: jobs.slice(0, 4), items });
  const msg = card(`เจอ ${jobs.length} งาน — เลือกงานที่จะเพิ่มรายการ`, [['ค้นด้วย', query], ['เพิ่ม', itemsText(items)]], [], C.dark);
  msg.contents.footer = { type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: C.surface, paddingAll: '12px',
    contents: jobs.slice(0, 4).map((j, i) => btn(shortLabel(j), `appt:pick:${t}:${i}`, '', jobLabel(j))) };
  return client.replyMessage({ replyToken, messages: [msg] });
}
// บันทึก: ต่อท้าย items ของใบออเดอร์คู่ (อ่านล่าสุดก่อน เผื่อเว็บแก้ไประหว่างรอกดยืนยัน) · ยังไม่มีใบคู่ = สร้างให้พร้อมรายการ
async function saveItems(supabase, job, items) {
  const { data: cur, error } = await supabase.from('installations').select('*').eq('id', job.id).maybeSingle();
  if (error) throw error;
  if (!cur) throw new Error('งานนี้ถูกลบออกจากเว็บไปแล้ว');
  if (!cur.source_order_id) {
    const warn = await linkOrder(supabase, cur, items);
    if (warn) throw new Error(warn);
    return '';
  }
  const { data: o, error: e1 } = await supabase.from('order_entries').select('items').eq('id', cur.source_order_id).maybeSingle();
  if (e1) throw e1;
  if (!o) throw new Error('ไม่เจอใบออเดอร์ที่ผูกกับงานนี้');
  const now = new Date().toISOString();
  const next = [...(Array.isArray(o.items) ? o.items : []), ...items];
  const { error: e2 } = await supabase.from('order_entries').update({ items: next, updated_at: now, last_content_at: now, ...BOT }).eq('id', cur.source_order_id);
  if (e2) throw e2;
  return '';
}

// ── #สรุป ── (อ่านอย่างเดียว · หน้าตาเหมือนโพสต์ "🔥อัพเดตงานติดตั้ง" ของทีม)
async function handleSummary(ctx, replyToken, text) {
  const { client, supabase, profile } = ctx;
  const zone = ZONES.find(z => text.includes(z)) || '';
  const from = new Date(`${bkkToday()}T00:00:00+07:00`).toISOString();
  const cols = 'serial_no, appointment_datetime, work_type, customer_id, customer_real_name, phone, province, install_zone, work_details, location_link, notes, installation_status, created_at';
  let q1 = supabase.from('installations').select(cols).gte('appointment_datetime', from).order('appointment_datetime', { ascending: true }).limit(80);
  let q2 = supabase.from('installations').select(cols).is('appointment_datetime', null)
    .gte('created_at', new Date(Date.now() - 120 * 86400e3).toISOString()).order('created_at', { ascending: false }).limit(40);
  const [{ data: up, error: e1 }, { data: wait, error: e2 }] = await Promise.all([q1, q2]);
  if (e1 || e2) throw e1 || e2;

  // ส่วนที่จะโชว์: #สรุปกทม / #สรุปเชียงใหม่ / #สรุปเชียงราย = โซนนั้น · #สรุป เฉยๆ = ทุกโซน แยกหัวข้อโซนละส่วน (user สั่ง 17ต.ค.69 ไม่ยึดโซนของกลุ่มแล้ว)
  // ต่อท้ายงานที่ยังไม่ระบุโซนเสมอ
  const UNKNOWN = { title: '❓ยังไม่ระบุโซนในเว็บ (ไปใส่โซนในปฏิทินงานติดตั้งด้วย)', zones: [''] };
  const sections = zone ? [{ title: '#' + zone, zones: [zone] }, UNKNOWN]
    : [...ZONES.map(z => ({ title: '#' + z, zones: [z] })), UNKNOWN];
  const parts = [];
  for (const sec of sections) {
    const rows = (up || []).filter(r => !DONE.includes(r.installation_status) && sec.zones.includes(zoneOf(r)));
    const pend = (wait || []).filter(r => !DONE.includes(r.installation_status) && sec.zones.includes(zoneOf(r)));
    if (!rows.length && !pend.length) continue;
    let s = `${sec.title}\n`;
    let lastDate = '';
    for (const r of rows) {
      const { date, time } = toBkk(r.appointment_datetime);
      if (date !== lastDate) { s += `______________________\n📍${thaiDayLabel(date)}\n`; lastDate = date; }
      const kind = r.work_type === 'งานวัดหน้างาน' ? 'วัดหน้างาน' : r.work_type === 'งานแก้' ? 'แก้งาน' : 'ติดตั้ง';
      s += `- ${time} น. ${kind}\n`;
      if (r.customer_id) s += `LineOA : ${r.customer_id}\n`;
      if (r.customer_real_name || r.phone) s += `${r.customer_real_name ? 'คุณ ' + r.customer_real_name + ' ' : ''}${r.phone ? 'โทร ' + r.phone : ''}\n`;
      if (r.province) s += `${r.province}\n`;
      if (r.location_link) s += `${r.location_link}\n`;
      if (r.notes) s += `*${r.notes}*\n`;
    }
    if (pend.length) {
      s += `______________________\n❗❗งานติดตั้งรอยืนยัน❗❗\n`;
      for (const r of pend) s += `- Line Oa : ${r.customer_id || r.customer_real_name || '-'}${r.notes ? ' **' + r.notes.split('\n')[0] : ''}\n`;
    }
    parts.push(s.trim());
  }
  if (!parts.length) return reply(client, replyToken, `ไม่มีงานที่ยังไม่เสร็จ${zone ? 'ในโซน' + zone : ''}ในปฏิทินงานติดตั้ง`);
  // รวมทุกโซนเป็นข้อความเดียว (เดิมแยกโซนละก้อน user บอกว่าขึ้นหลายก้อน) — แยกก้อนใหม่เฉพาะตอนยาวเกินที่ LINE รับได้
  // ข้อความ LINE ยาวได้ 5,000 ตัว และตอบได้ทีละไม่เกิน 5 ข้อความ · ตัดตรงรอยต่อโซน/บรรทัด ไม่ตัดกลางงาน
  const head = `🔥อัพเดตงานติดตั้ง+วัดหน้างาน🔥\n(ดึงจากเว็บ · ${bkkToday().split('-').reverse().join('/')} ${new Date(Date.now() + 7 * 3600e3).toISOString().slice(11, 16)} น.)`;
  const SEP = '\n\n══════════\n';
  const msgs = [];
  let cur = head;
  for (const p of parts) {
    for (const line of (SEP + p).split(/(?=\n)/)) {
      if (cur.length + line.length > 4900) { msgs.push(cur); cur = line.replace(/^\n+/, ''); }
      else cur += line;
    }
  }
  msgs.push(cur);
  // รูปปฏิทินไม่แนบแล้ว (user สั่ง 8ต.ค.69) — อยากได้รูปให้พิมพ์ #ปฏิทิน
  await client.replyMessage({ replyToken, messages: msgs.slice(0, 5).map(text => ({ type: 'text', text })) });
}

// รูปปฏิทินของเดือน (offset 0 = เดือนนี้, 1 = เดือนหน้า) ตามโซนที่พิมพ์ / โซนของกลุ่ม
async function monthImage(ctx, zone, offset) {
  const { supabase, profile } = ctx;
  const [y, m] = bkkToday().split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  const zones = zone ? [zone] : profile ? profile.zones : null;
  const title = zone ? '#' + zone : profile ? profile.label : 'ทุกโซน';
  return calendarMessage({ supabase, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, zones, title, zoneOf, today: bkkToday() });
}

// ── #ปฏิทิน [โซน] [เดือนหน้า | ชื่อเดือน/เลขเดือน] ── ส่งรูปอย่างเดียว
async function handleCalendar(ctx, replyToken, text) {
  const zone = ZONES.find(z => text.includes(z)) || '';
  const [, m] = bkkToday().split('-').map(Number);
  let offset = /เดือนหน้า|ถัดไป/.test(text) ? 1 : 0;
  const TH = ['ม.ค', 'ก.พ', 'มี.ค', 'เม.ย', 'พ.ค', 'มิ.ย', 'ก.ค', 'ส.ค', 'ก.ย', 'ต.ค', 'พ.ย', 'ธ.ค'];
  const FULL = ['มกรา', 'กุมภา', 'มีนา', 'เมษา', 'พฤษภา', 'มิถุนา', 'กรกฎา', 'สิงหา', 'กันยา', 'ตุลา', 'พฤศจิกา', 'ธันวา'];
  let want = FULL.findIndex(f => text.includes(f)); if (want < 0) want = TH.findIndex(t => text.includes(t));
  const num = (text.match(/(?:^|\s)(1[0-2]|[1-9])(?:\s|$)/) || [])[1];
  if (want < 0 && num) want = Number(num) - 1;
  if (want >= 0) { offset = (want - (m - 1) + 12) % 12; if (offset > 6) offset -= 12; }   // ย้อนได้ 5 เดือน ล่วงหน้าได้ 6 เดือน
  const img = await monthImage(ctx, zone, offset);
  await ctx.client.replyMessage({ replyToken, messages: [img] });
}

// ── บันทึกลงเว็บจริง ── (ตามแบบหน้าปฏิทินงานติดตั้งของ donnaweb: save() + lib/installOrderSync.ts — แก้ที่นั่นต้องแก้ที่นี่คู่กัน)
const BOT = { actor_code: null, actor_name: 'บอทไลน์' };   // ชื่อคนทำในประวัติของเว็บ
const STATUS_BY_TYPE = { 'งานติดตั้ง': 'รอนัดหมาย', 'งานวัดหน้างาน': 'รอนัดหมาย', 'งานแก้': 'รอแก้' };
const TECH_BY_ZONE = { 'กทม': 'ช่างนอก' };
const apptTs = (date, time) => date ? `${date}T${String(time || '9:00').padStart(5, '0')}:00+07:00` : null;
const serialLabel = (s) => s ? 'IN' + String(Number(s)).padStart(4, '0') : '';
const orderNotes = (r) => [r.work_details, r.notes].map(v => String(v ?? '').trim()).filter(Boolean).join(' · ') || null;
// วัน/เวลาของใบออเดอร์จากวันนัด (install_time ฝั่งออเดอร์เก็บแบบ 9:00 ไม่เติม 0)
const orderWhen = (ts) => {
  const { date, time } = toBkk(ts);
  return { deadline: date || null, installation_date: date || null, install_time: date ? `${Number(time.slice(0, 2))}:${time.slice(3, 5)}` : '9:00' };
};

// เลข IN ถัดไปจากตัวนับกลาง (rpc take_serial) — ใบที่ลบแล้วเลขไม่ถูกใช้ซ้ำ · rpc พังใช้เลขมากสุด+1
async function nextSerial(supabase) {
  const { data, error } = await supabase.from('installations').select('serial_no');
  if (error) throw error;
  const floor = (data || []).reduce((mx, r) => Math.max(mx, parseInt(String(r.serial_no || '').replace(/\D/g, ''), 10) || 0), 0);
  let n = floor + 1;
  try {
    const res = await supabase.rpc('take_serial', { p_kind: 'install', p_floor: floor });
    if (!res.error && typeof res.data === 'number' && res.data > floor) n = res.data;
  } catch { /* ใช้ floor + 1 */ }
  return String(n).padStart(4, '0');
}

// งานติดตั้งต้องมีใบออเดอร์คู่ ฝ่ายผลิตถึงจะเห็นในหมวดออเดอร์ → สร้างแล้วผูกด้วย source_order_id (คืนข้อความเตือนถ้าไม่สำเร็จ)
async function linkOrder(supabase, ins, items = []) {
  if (ins.work_type !== 'งานติดตั้ง' || ins.source_order_id) return '';
  const now = new Date().toISOString();
  const { data, error } = await supabase.from('order_entries').insert({
    entry_date: bkkToday(),
    customer_name: ins.customer_real_name || ins.customer_id || null,
    platform: ins.platform || null,
    is_installation: true,
    ...orderWhen(ins.appointment_datetime),
    province: ins.province || null,
    phone: ins.phone || null,
    location_link: ins.location_link || null,
    notes: orderNotes(ins),
    items: items && items.length ? items : null,   // รายการที่แปลงมาจาก #นัด / #เพิ่มรายการ
    price: ins.price ?? null,
    payment_status: 'ยังไม่ชำระ',
    order_status: 'รอดำเนินการ',
    status: 'อยู่ในกำหนด',
    order_assigned: 'รออัพเดท',
    admin_name: ins.entered_by || null,
    updated_at: now,
    ...BOT,
  }).select('id').single();
  if (error) return `สร้างใบออเดอร์คู่ไม่สำเร็จ (${error.message}) — เปิดงานนี้ในเว็บแล้วกดบันทึกอีกทีนะคะ`;
  const { error: e2 } = await supabase.from('installations').update({ source_order_id: data.id, ...BOT }).eq('id', ins.id);
  return e2 ? `ผูกใบออเดอร์กับงานนี้ไม่สำเร็จ (${e2.message})` : '';
}

// #นัด → เพิ่มแถวในปฏิทินงานติดตั้ง
async function saveNew(supabase, a) {
  const zone = ZONES.includes(a.install_zone) ? a.install_zone : '';
  const workType = STATUS_BY_TYPE[a.work_type] ? a.work_type : 'งานติดตั้ง';
  const { data: row, error } = await supabase.from('installations').insert({
    serial_no: await nextSerial(supabase),
    appointment_datetime: apptTs(a.date, a.time),
    work_type: workType,
    platform: a.platform || '',
    customer_id: a.customer_id || '',
    customer_real_name: a.customer_real_name || '',
    province: a.address || '',
    install_zone: zone,
    technician_type: TECH_BY_ZONE[zone] || '',
    phone: digits(a.phone),
    work_details: '',
    location_link: a.location_link || '',
    price: 0,
    notes: [!a.date && a.time ? `เวลาที่นัด ${a.time} น. (ยังไม่มีวัน)` : '', a.notes || ''].filter(Boolean).join('\n'),
    payment_status: 'รอมัดจำ',
    appointment_status: 'นัดหมายแล้ว',
    production_status: 'กำลังผลิต',
    send_to_technician: 'หน้าร้าน',
    installation_status: STATUS_BY_TYPE[workType],
    entered_by: '',
    updated_at: new Date().toISOString(),
    ...BOT,
  }).select().single();
  if (error) throw error;
  return { row, warn: await linkOrder(supabase, row, a.items) };
}

// #แก้ → แก้เฉพาะช่องที่สั่ง (อ่านแถวล่าสุดก่อน เผื่อเว็บแก้ไประหว่างรอกดยืนยัน) แล้ว sync ช่องเดียวกันไปใบออเดอร์ที่ผูกไว้
async function saveEdit(supabase, job, a) {
  const { data: cur, error } = await supabase.from('installations').select('*').eq('id', job.id).maybeSingle();
  if (error) throw error;
  if (!cur) throw new Error('งานนี้ถูกลบออกจากเว็บไปแล้ว');
  const c = a.changes || {}, old = toBkk(cur.appointment_datetime), after = applyEdit(cur, a);
  const patch = {};
  if ((c.date && c.date !== old.date) || (c.time && c.time !== old.time)) {
    if (!after.date) throw new Error(`งานนี้ยังไม่มีวันนัด พิมพ์วันมาด้วยนะคะ เช่น "#แก้ ${a.query} เป็น 15/10 13.00"`);
    patch.appointment_datetime = apptTs(after.date, after.time);
  }
  for (const [f] of EDIT_FIELDS) if (after[f] !== undefined) patch[f] = f === 'phone' ? digits(after[f]) : after[f];
  if (!Object.keys(patch).length) return { row: cur, same: true, warn: '' };
  if (TECH_BY_ZONE[patch.install_zone] && !cur.technician_type) patch.technician_type = TECH_BY_ZONE[patch.install_zone];
  const now = new Date().toISOString();
  const { error: e1 } = await supabase.from('installations').update({ ...patch, updated_at: now, ...BOT }).eq('id', cur.id);
  if (e1) throw e1;

  const row = { ...cur, ...patch };
  if (!row.source_order_id) return { row, same: false, warn: await linkOrder(supabase, row) };   // เพิ่งเปลี่ยนเป็นงานติดตั้ง → สร้างใบออเดอร์คู่
  const op = {};
  if ('appointment_datetime' in patch) Object.assign(op, orderWhen(row.appointment_datetime));
  for (const f of ['phone', 'province', 'location_link', 'platform']) if (f in patch) op[f] = row[f] || null;
  if ('customer_real_name' in patch) op.customer_name = row.customer_real_name || row.customer_id || null;
  if ('notes' in patch) op.notes = orderNotes(row);
  let warn = '';
  if (Object.keys(op).length) {
    const { error: e2 } = await supabase.from('order_entries').update({ ...op, updated_at: now, last_content_at: now, ...BOT }).eq('id', row.source_order_id);
    if (e2) warn = `แก้ในปฏิทินแล้ว แต่ใบออเดอร์ที่ผูกไว้แก้ไม่สำเร็จ (${e2.message})`;
  }
  return { row, same: false, warn };
}

// ── ปุ่มในการ์ด ──
async function handlePostback(ctx, replyToken, data) {
  const { client, supabase } = ctx;
  const [, act, t, idx] = data.split(':');
  const send = (msg) => client.replyMessage({ replyToken, messages: [msg] });
  const p = pending.get(t);
  if (!p) return reply(client, replyToken, 'การ์ดนี้หมดอายุแล้ว');
  if (act === 'edit') {
    pending.delete(t);
    return reply(client, replyToken, p.kind === 'new'
      ? 'ยกเลิกการ์ดนี้แล้ว พิมพ์ #นัด ใหม่พร้อมข้อมูลที่ถูกต้องได้เลยค่ะ'
      : /items/.test(p.kind) ? 'ยกเลิกการ์ดนี้แล้ว พิมพ์ #เพิ่มรายการ ใหม่ได้เลยค่ะ'
      : 'ยกเลิกการ์ดนี้แล้ว พิมพ์ #แก้ ใหม่ได้เลยค่ะ');
  }
  if (act === 'pick') {
    const job = p.jobs[Number(idx)];
    if (!job) return reply(client, replyToken, 'ไม่เจองานที่เลือก ลองพิมพ์ #แก้ ใหม่นะคะ');
    pending.delete(t);
    if (p.kind === 'pickitems') {
      const t2 = keep({ kind: 'items', job, items: p.items });
      return client.replyMessage({ replyToken, messages: [addItemsCard(job, p.items, t2)] });
    }
    if (!hasChange(job, p.data)) return reply(client, replyToken, sameReply(job));
    const t2 = keep({ kind: 'edit', job, data: p.data });
    return client.replyMessage({ replyToken, messages: [editCard(job, p.data, t2)] });
  }
  if (act === 'ok') {
    pending.delete(t);   // ลบก่อนบันทึก — กดยืนยันซ้ำสองทีไม่ได้แถวซ้ำ
    if (p.kind === 'items') {
      const what = [['ใบงาน', jobLabel(p.job)], ['เพิ่ม', itemsText(p.items)]];
      if (DRY_RUN) return send(card('ทดสอบ · ยังไม่เพิ่มในเว็บ', [['ถ้าใช้จริง', 'จะต่อท้ายรายการในใบออเดอร์'], ...what], webBtn(p.job.id), C.mute));
      await saveItems(supabase, p.job, p.items);
      return send(card('เพิ่มรายการในเว็บแล้ว', what, webBtn(p.job.id), C.done));
    }
    if (p.kind === 'new') {
      const a = p.data;
      const what = [['งาน', a.work_type], ['ช่องทาง', a.platform], ['วันนัด', whenText(a.date, a.time), whenTone(a.date)], ['ลูกค้า', a.customer_id || a.customer_real_name], ['โซน', a.install_zone],
        ['รายการ', a.items && a.items.length && a.work_type === 'งานติดตั้ง' ? `${a.items.length} รายการ` : '']];
      if (DRY_RUN) return send(card('ทดสอบ · ยังไม่บันทึกลงเว็บ', [['ถ้าใช้จริง', 'จะเพิ่มในปฏิทินงานติดตั้ง'], ...what], [], C.mute));
      const { row, warn } = await saveNew(supabase, a);
      return send(card('ลงปฏิทินงานติดตั้งแล้ว', [['ใบงาน', serialLabel(row.serial_no)], ...what, ['ต้องดู', warn, 'warn']], webBtn(row.id), C.done));
    }
    const c = p.data.changes || {}, after = applyEdit(p.job, p.data);
    const what = [['ใบงาน', jobLabel(p.job)]];
    const old = toBkk(p.job.appointment_datetime);
    if ((c.date && c.date !== old.date) || (c.time && c.time !== old.time)) what.push(['วันนัด', whenText(after.date, after.time), whenTone(after.date)]);
    for (const [f, label] of EDIT_FIELDS) if (after[f] !== undefined) what.push([label, f === 'notes' && p.data.notes_mode !== 'replace' && p.job.notes ? '(ต่อท้าย) ' + c.notes : after[f]]);
    if (DRY_RUN) return send(card('ทดสอบ · ยังไม่แก้ในเว็บ', [['ถ้าใช้จริง', 'จะแก้เป็นค่าตามนี้'], ...what], webBtn(p.job.id), C.mute));
    const { same, warn } = await saveEdit(supabase, p.job, p.data);
    if (same) return reply(client, replyToken, sameReply(p.job));
    return send(card('แก้ในเว็บแล้ว', [...what, ['ต้องดู', warn, 'warn']], webBtn(p.job.id), C.done));
  }
}

async function reply(client, replyToken, text) {
  await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
}

// ข้อความขึ้นต้นด้วยคำสั่งไหม → จัดการแล้วคืน true
async function handleApptText(ctx, replyToken, text, profileKey) {
  ctx = { ...ctx, profile: PROFILES[profileKey] || null };
  const m = text.match(/^#\s*(เพิ่มรายการ|นัด|แก้|เลื่อน|สรุป|ปฏิทิน)\s*([\s\S]*)$/);
  if (!m) return false;
  try {
    if (m[1] === 'นัด') await handleNew(ctx, replyToken, m[2].trim());
    else if (m[1] === 'เพิ่มรายการ') await handleAddItems(ctx, replyToken, m[2].trim());
    else if (m[1] === 'แก้' || m[1] === 'เลื่อน') await handleEdit(ctx, replyToken, m[2].trim());   // #เลื่อน = ชื่อเดิม ทำงานเหมือน #แก้
    else if (m[1] === 'ปฏิทิน') await handleCalendar(ctx, replyToken, m[2].trim());
    else await handleSummary(ctx, replyToken, m[2].trim());
  } catch (err) {
    console.error('appt error:', err);
    await reply(ctx.client, replyToken, 'ขออภัยค่ะ เกิดข้อผิดพลาด: ' + (err.message || err)).catch(() => {});
  }
  return true;
}

async function handleApptPostback(ctx, replyToken, data) {
  if (!String(data).startsWith('appt:')) return false;
  try { await handlePostback(ctx, replyToken, data); }
  catch (err) {
    console.error('appt postback error:', err);
    await reply(ctx.client, replyToken, 'ขออภัยค่ะ เกิดข้อผิดพลาด: ' + (err.message || err)).catch(() => {});
  }
  return true;
}

module.exports = { handleApptText, handleApptPostback, saveNew, saveEdit };
