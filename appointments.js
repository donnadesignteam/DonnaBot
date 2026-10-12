// ── ลงนัดติดตั้ง/วัดหน้างานผ่านแชท LINE ─────────────────────────────
// คำสั่ง: #นัด <ข้อความนัดแบบที่ทีมโพสต์ในกลุ่ม> · #แก้ <ลูกค้า> <วันเวลาใหม่/ช่องที่แก้> (#เลื่อน ใช้แทนกันได้) · #สรุป [โซน] · #ปฏิทิน [โซน] [เดือน]
// ระยะทดสอบ: ใช้ในกลุ่มทดสอบ (GROUP_TEST ใน index.js — 12ต.ค.69 ย้ายจากแชทส่วนตัว) และ **ไม่เขียนตาราง installations** (DRY_RUN)
//   · #นัด / #เลื่อน → AI อ่านข้อความ → การ์ดยืนยัน → กด ✅ แค่ตอบว่า "ถ้าใช้จริงจะบันทึกอะไร"
//   · #สรุป / การหางานของ #เลื่อน = อ่านตาราง installations จริง (อ่านอย่างเดียว)
// ใช้จริง (ปิด DRY_RUN): กด ✅ → saveNew / saveEdit เขียนลงเว็บแบบเดียวกับหน้าปฏิทินงานติดตั้งของ donnaweb
//   (เลข IN จากตัวนับกลาง · งานติดตั้งสร้างใบออเดอร์คู่ให้ · แก้แล้ว sync ไปใบออเดอร์ที่ผูกไว้)
// ตอบด้วย reply ทั้งหมด (ฟรี ไม่กินโควตาข้อความ LINE)

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

const NEW_SYSTEM = () => `คุณอ่านข้อความนัดงานติดตั้งผ้าม่านที่แอดมินร้าน Donna Design พิมพ์ แล้วตอบเป็น JSON อย่างเดียว ห้ามมีคำอื่น
วันนี้คือ ${bkkToday()} (ปี ค.ศ. · ถ้าเขียนปี พ.ศ. เช่น 2569 ให้ลบ 543 · ถ้าไม่ระบุปีให้ใช้วันที่ที่ใกล้วันนี้ที่สุดที่ยังไม่ผ่านไป)
รูปแบบ:
{"work_type":"งานติดตั้ง"|"งานวัดหน้างาน"|"งานแก้","date":"YYYY-MM-DD หรือ ''","time":"HH:MM หรือ ''",
 "customer_id":"ชื่อไลน์/LineOA/Facebook/ชื่อร้านค้าออนไลน์ของลูกค้า","customer_real_name":"ชื่อจริงลูกค้า","phone":"เบอร์ตัวเลขล้วน",
 "address":"ที่อยู่/ชื่อคอนโด/ห้อง","location_link":"ลิงก์แผนที่ถ้ามี","install_zone":"กทม"|"เชียงราย"|"เชียงใหม่"|"",
 "notes":"รายละเอียดอื่นที่สำคัญ เช่น ให้ช่างเอาอะไรไป ค่าติดตั้ง หมายเหตุ","missing":["ช่องสำคัญที่ไม่มีในข้อความ: วัน, เวลา, ลูกค้า, เบอร์, ที่อยู่"]}
กติกา: วัดหน้างาน/วัดขนาด = งานวัดหน้างาน · แก้งาน/รีเช็ค/ซ่อม = งานแก้ · นอกนั้น = งานติดตั้ง
install_zone: กรุงเทพ/ปริมณฑล/นนทบุรี/สมุทรปราการ = กทม · เชียงราย = เชียงราย · เชียงใหม่ = เชียงใหม่ · จังหวัดอื่นในภาคเหนือ (ลำปาง พะเยา ฯลฯ) = เชียงราย · ไม่รู้ = ''`;

// #แก้ (และ #เลื่อน แบบเดิม) — แก้ได้ทุกช่องในคำสั่งเดียว รวมวัน/เวลา (user สั่ง 8ต.ค.69 ไม่อยากพิมพ์ 2 คำสั่ง)
const EDIT_SYSTEM = () => `คุณอ่านคำสั่งแก้ไขงานนัดติดตั้งของร้านผ้าม่าน แล้วตอบเป็น JSON อย่างเดียว ห้ามมีคำอื่น
วันนี้คือ ${bkkToday()} (ปี พ.ศ. ให้ลบ 543 · ไม่ระบุปีให้ใช้วันที่ที่ใกล้วันนี้ที่สุดที่ยังไม่ผ่านไป)
{"query":"คำที่ใช้หางาน = ชื่อลูกค้า/ชื่อไลน์/เบอร์เดิม/เลข IN (ไม่ใช่ค่าใหม่)",
 "changes":{ ใส่เฉพาะช่องที่สั่งให้เปลี่ยน:
   "date":"YYYY-MM-DD","time":"HH:MM","work_type":"งานติดตั้ง"|"งานวัดหน้างาน"|"งานแก้",
   "customer_real_name":"","phone":"ตัวเลขล้วน","province":"ที่อยู่/จังหวัด","location_link":"","install_zone":"กทม"|"เชียงราย"|"เชียงใหม่","notes":"" },
 "notes_mode":"append" (เพิ่มต่อท้ายหมายเหตุเดิม = ค่าตั้งต้น) | "replace" (เมื่อสั่งชัดว่าเปลี่ยน/ลบหมายเหตุเดิม)}
ตัวอย่าง: "#แก้ Yothaka เป็น 11/10 10.00 เบอร์ 0922836430" → query "Yothaka", changes {date, time, phone}
"เลื่อนเป็นบ่ายโมง" = time 13:00 · "วัดหน้างาน" = work_type งานวัดหน้างาน`;

// ช่องที่แก้ได้ → ชื่อไทยในการ์ด (เรียงตามลำดับที่โชว์)
const EDIT_FIELDS = [['work_type', 'งาน'], ['customer_real_name', 'ชื่อจริง'], ['phone', 'เบอร์'], ['province', 'ที่อยู่'],
  ['location_link', 'แผนที่'], ['install_zone', 'โซน'], ['notes', 'หมายเหตุ']];

// ── การ์ดยืนยัน (Flex) ── โทนสีเดียวกับเว็บ donnaweb (globals.css) · ไม่ใช้อีโมจิ ของที่ต้องเตือนใช้ตัวหนังสือสีแดงอิฐแทน
const C = { brand: '#9E6A49', dark: '#5C4534', ok: '#6F8F6A', mute: '#8B7460', ink: '#3D2B1F', warn: '#C0563F', surface: '#FBF7F1', cream: '#F0E0D0', line: '#E4D6C6' };
// data ขึ้นต้นด้วย http = ปุ่มเปิดลิงก์ · นอกนั้น = ปุ่ม postback
const btn = (label, data, style, displayText) => ({
  type: 'button', style: style || 'secondary', height: 'sm', color: style === 'primary' ? C.brand : C.cream,
  action: /^https?:/.test(data) ? { type: 'uri', label, uri: data } : { type: 'postback', label, data, displayText: displayText || label } });
// ลิงก์ไปปฏิทินงานติดตั้งในเว็บ — หน้าเว็บเลื่อนไปที่งานนั้นแล้วกระพริบ (?focus=) · openExternalBrowser = เปิดเบราว์เซอร์ของเครื่อง (ที่ล็อกอินเว็บไว้) แทนเบราว์เซอร์ในไลน์
const WEB_URL = (process.env.APPT_WEB_URL || 'https://donna-erp.vercel.app').replace(/\/+$/, '');
const webBtn = (id) => id ? [['เปิดในเว็บ', `${WEB_URL}/installations?focus=${encodeURIComponent(id)}&openExternalBrowser=1`, 'primary']] : [];
// rows = [หัวข้อ, ค่า, 'warn'?] — ใส่ 'warn' = ค่านั้นเป็นสีเตือน
function card(title, rows, buttons, color = C.brand) {
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: color, paddingAll: '16px', spacing: 'xs',
        contents: [
          { type: 'text', text: 'DONNA DESIGN', color: C.cream, weight: 'bold', size: 'xxs' },
          { type: 'text', text: title, color: '#FFFFFF', weight: 'bold', size: 'md', wrap: true },
        ] },
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

// ── #นัด ──
async function handleNew(ctx, replyToken, text) {
  const { client, anthropic, profile } = ctx;
  if (!text) return reply(client, replyToken, 'พิมพ์ #นัด ตามด้วยรายละเอียดนัด เช่น\n#นัด ติดตั้ง ศุกร์ 9/10 10.00\nLineOA: Att 0900381117\nคอนโด notting hill ห้อง 1/123\nhttps://maps.app.goo.gl/...');
  const a = await askJson(anthropic, NEW_SYSTEM(), text);
  if (!a) return reply(client, replyToken, 'อ่านข้อความไม่ออก ลองพิมพ์ใหม่อีกทีนะคะ');
  let zoneNote = '';
  if (!ZONES.includes(a.install_zone) && profile) {
    a.install_zone = profile.defaultZone; zoneNote = ' (ตามกลุ่ม)';
    a.missing = (a.missing || []).filter(x => !/zone|โซน/.test(x));
  }
  const t = keep({ kind: 'new', data: a });
  // ช่องที่ขาด — AI บางทีตอบเป็นชื่อฟิลด์อังกฤษ แปลงเป็นไทยให้อ่านง่าย
  const TH = { date: 'วัน', time: 'เวลา', customer_id: 'ชื่อไลน์ลูกค้า', customer_real_name: 'ชื่อจริง', phone: 'เบอร์', address: 'ที่อยู่', location_link: 'แผนที่', install_zone: 'โซน' };
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
    ['งาน', a.work_type], ['วันนัด', whenText(a.date, a.time) + (past ? ' · วันนี้ผ่านไปแล้ว' : ''), past ? 'warn' : whenTone(a.date)], ['ลูกค้า', a.customer_id], ['ชื่อจริง', a.customer_real_name],
    ['เบอร์', a.phone], ['ที่อยู่', a.address], ['แผนที่', a.location_link], a.install_zone ? ['โซน', a.install_zone + zoneNote] : ['โซน', 'ไม่รู้โซน', 'warn'],
    ['หมายเหตุ', a.notes], ['ยังขาด', missing.length ? missing.join(', ') : '', 'warn'], ['มีงานเดิม', dup, 'warn'],
  ];
  await client.replyMessage({ replyToken, messages: [card('ลงนัดใหม่' + TAG, rows,
    [['ยืนยัน', `appt:ok:${t}`, 'primary'], ['แก้', `appt:edit:${t}`]])] });
}

// หางานจากคำค้น (อ่านอย่างเดียว) — งานที่ยังไม่เสร็จ นัดตั้งแต่ 30 วันก่อน หรือยังไม่มีวัน
async function findJobs(supabase, query, profile) {
  const since = new Date(Date.now() - 30 * 86400e3).toISOString();
  const { data, error } = await supabase.from('installations')
    .select('id, serial_no, appointment_datetime, work_type, customer_id, customer_real_name, phone, province, location_link, notes, install_zone, installation_status')
    .or(`appointment_datetime.gte.${since},appointment_datetime.is.null`)
    .order('appointment_datetime', { ascending: true, nullsFirst: false })
    .limit(800);
  if (error) throw error;
  const q = String(query || '').trim();
  const qd = digits(q), qn = norm(q);
  const serial = (q.match(/^IN\s*0*(\d+)$/i) || [])[1];
  return (data || []).filter(r => !DONE.includes(r.installation_status))
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
  if (!Object.keys(a.changes).length) return reply(client, replyToken, `เจอคำว่า "${a.query}" แต่ไม่รู้ว่าจะแก้อะไร ลองพิมพ์ใหม่ เช่น "#แก้ ${a.query} เป็น 15/10 13.00" หรือ "#แก้ ${a.query} เบอร์ 08xxxxxxxx"`);
  const jobs = await findJobs(supabase, a.query, profile);
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

  // ส่วนที่จะโชว์: พิมพ์โซนมาเอง = โซนนั้น · ไม่พิมพ์ = โซนของกลุ่มนี้รวมกัน (ไม่มีกลุ่ม = แยกทุกโซน) · ต่อท้ายงานที่ยังไม่ระบุโซนเสมอ
  const UNKNOWN = { title: '❓ยังไม่ระบุโซนในเว็บ (ไปใส่โซนในปฏิทินงานติดตั้งด้วย)', zones: [''] };
  const sections = zone ? [{ title: '#' + zone, zones: [zone] }, UNKNOWN]
    : profile ? [{ title: profile.label, zones: profile.zones }, UNKNOWN]
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
async function linkOrder(supabase, ins) {
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
    platform: '',
    customer_id: a.customer_id || '',
    customer_real_name: a.customer_real_name || '',
    province: a.address || '',
    install_zone: zone,
    technician_type: TECH_BY_ZONE[zone] || '',
    phone: digits(a.phone),
    work_details: '',
    location_link: a.location_link || '',
    price: 0,
    notes: a.notes || '',
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
  return { row, warn: await linkOrder(supabase, row) };
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
  for (const f of ['phone', 'province', 'location_link']) if (f in patch) op[f] = row[f] || null;
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
      : 'ยกเลิกการ์ดนี้แล้ว พิมพ์ #แก้ ใหม่ได้เลยค่ะ');
  }
  if (act === 'pick') {
    const job = p.jobs[Number(idx)];
    if (!job) return reply(client, replyToken, 'ไม่เจองานที่เลือก ลองพิมพ์ #แก้ ใหม่นะคะ');
    pending.delete(t);
    if (!hasChange(job, p.data)) return reply(client, replyToken, sameReply(job));
    const t2 = keep({ kind: 'edit', job, data: p.data });
    return client.replyMessage({ replyToken, messages: [editCard(job, p.data, t2)] });
  }
  if (act === 'ok') {
    pending.delete(t);   // ลบก่อนบันทึก — กดยืนยันซ้ำสองทีไม่ได้แถวซ้ำ
    if (p.kind === 'new') {
      const a = p.data;
      const what = [['งาน', a.work_type], ['วันนัด', whenText(a.date, a.time), whenTone(a.date)], ['ลูกค้า', a.customer_id || a.customer_real_name], ['โซน', a.install_zone]];
      if (DRY_RUN) return send(card('ทดสอบ · ยังไม่บันทึกลงเว็บ', [['ถ้าใช้จริง', 'จะเพิ่มในปฏิทินงานติดตั้ง'], ...what], [], C.mute));
      const { row, warn } = await saveNew(supabase, a);
      return send(card('ลงปฏิทินงานติดตั้งแล้ว', [['ใบงาน', serialLabel(row.serial_no)], ...what, ['ต้องดู', warn, 'warn']], webBtn(row.id), C.ok));
    }
    const c = p.data.changes || {}, after = applyEdit(p.job, p.data);
    const what = [['ใบงาน', jobLabel(p.job)]];
    const old = toBkk(p.job.appointment_datetime);
    if ((c.date && c.date !== old.date) || (c.time && c.time !== old.time)) what.push(['วันนัด', whenText(after.date, after.time), whenTone(after.date)]);
    for (const [f, label] of EDIT_FIELDS) if (after[f] !== undefined) what.push([label, f === 'notes' && p.data.notes_mode !== 'replace' && p.job.notes ? '(ต่อท้าย) ' + c.notes : after[f]]);
    if (DRY_RUN) return send(card('ทดสอบ · ยังไม่แก้ในเว็บ', [['ถ้าใช้จริง', 'จะแก้เป็นค่าตามนี้'], ...what], webBtn(p.job.id), C.mute));
    const { same, warn } = await saveEdit(supabase, p.job, p.data);
    if (same) return reply(client, replyToken, sameReply(p.job));
    return send(card('แก้ในเว็บแล้ว', [...what, ['ต้องดู', warn, 'warn']], webBtn(p.job.id), C.ok));
  }
}

async function reply(client, replyToken, text) {
  await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
}

// ข้อความขึ้นต้นด้วยคำสั่งไหม → จัดการแล้วคืน true
async function handleApptText(ctx, replyToken, text, profileKey) {
  ctx = { ...ctx, profile: PROFILES[profileKey] || null };
  const m = text.match(/^#\s*(นัด|แก้|เลื่อน|สรุป|ปฏิทิน)\s*([\s\S]*)$/);
  if (!m) return false;
  try {
    if (m[1] === 'นัด') await handleNew(ctx, replyToken, m[2].trim());
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
