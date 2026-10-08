// ── รูปปฏิทินงานติดตั้ง (ส่งพร้อม #สรุป / คำสั่ง #ปฏิทิน) ─────────────────────
// วาดเองจากตาราง installations (อ่านอย่างเดียว) เป็น SVG → sharp แปลงเป็น JPEG → เก็บในหน่วยความจำ
// แล้วเปิดให้ LINE ดึงทาง GET /cal/<id>.jpg (LINE ต้องการลิงก์ https ของรูป ส่งไฟล์ตรงๆ ไม่ได้)
// สีชุดเดียวกับหน้าปฏิทินงานติดตั้งในเว็บ: วัดหน้างาน ฟ้า · ติดตั้ง ทอง · รอแก้ แดง · อาทิตย์ (ร้านปิด) เทา
// ฟอนต์ไทย Prompt อยู่ใน fonts/ (วาดตัวหนังสือด้วยไฟล์ฟอนต์ตรงๆ — เซิร์ฟเวอร์ไม่มีฟอนต์ไทย)

const sharp = require('sharp');

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TH_WD = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const COLOR = { 'วัดหน้างาน': '#5AC8FA', 'ติดตั้ง': '#C79A4B', 'รอแก้': '#C0564A' };
const DONE = ['ติดตั้งเสร็จ', 'วัดหน้างานแล้ว'];

// รูปที่วาดแล้ว — เก็บ 1 วัน (LINE ดึงรูปตอนส่ง + ตอนคนกดดู)
const store = new Map();
const keepImage = (buf) => {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.at > 86400e3) store.delete(k);
  const id = Math.random().toString(36).slice(2, 12);
  store.set(id, { buf, at: now });
  return id;
};
function registerCalendarRoute(app) {
  app.get('/cal/:id.jpg', (req, res) => {
    const v = store.get(req.params.id);
    if (!v) return res.sendStatus(404);
    res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'public, max-age=86400').send(v.buf);
  });
}

const path = require('path');
const FONT = { regular: path.join(__dirname, 'fonts', 'Prompt-Regular.ttf'), bold: path.join(__dirname, 'fonts', 'Prompt-SemiBold.ttf') };
// วาดตัวหนังสือ 1 ชิ้นเป็นรูปโปร่งใส ด้วยไฟล์ฟอนต์ตรงๆ (ไม่พึ่งฟอนต์ที่ติดตั้งในเครื่อง) · dpi 72 = ขนาดเป็นพิกเซล
async function textImage(s, t) {
  const markup = `<span foreground="${t.color || '#3A2A1E'}"${t.strike ? ' strikethrough="true"' : ''}>${esc(s)}</span>`;
  const { data, info } = await sharp({ text: { text: markup, font: `${t.bold ? 'Prompt SemiBold' : 'Prompt'} ${t.size}`,
    fontfile: t.bold ? FONT.bold : FONT.regular, rgba: true, dpi: 72 } }).png().toBuffer({ resolveWithObject: true });
  return { buf: data, width: info.width };
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// ฟอนต์ไม่มีอีโมจิ → ตัดทิ้ง (ชื่อไลน์ลูกค้ามีเยอะ เช่น 🐾🦁MIL🦁🐾) ไม่งั้นขึ้นเป็นสี่เหลี่ยม
const clean = (s) => String(s || '').replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '').replace(/\s+/g, ' ').trim();
const kindOf = (r) => r.installation_status === 'รอแก้' || r.work_type === 'งานแก้' ? 'รอแก้'
  : r.work_type === 'งานวัดหน้างาน' ? 'วัดหน้างาน' : 'ติดตั้ง';

// jobs: [{ date:'YYYY-MM-DD', time:'HH:MM', name, kind, done, unknownZone }]
async function renderMonth({ year, month, jobs, title, today }) {
  const W = 1400, PAD = 28, HEAD = 120, WDH = 44;
  const first = new Date(Date.UTC(year, month - 1, 1));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = first.getUTCDay();
  const weeks = Math.ceil((lead + days) / 7);
  const cw = (W - PAD * 2) / 7;
  const byDay = {};
  for (const j of jobs) (byDay[j.date] = byDay[j.date] || []).push(j);
  for (const k in byDay) byDay[k].sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  const maxRows = Math.max(3, ...Object.values(byDay).map(a => a.length));
  const LINE_H = 30;
  const ch = Math.max(150, 46 + Math.min(maxRows, 7) * LINE_H + 10);
  const H = HEAD + WDH + weeks * ch + PAD + 56;

  // พื้น/กล่อง/แถบสี วาดด้วย SVG (ไม่มีตัวหนังสือ) · ตัวหนังสือวาดแยกด้วย sharp text + ไฟล์ฟอนต์ Prompt แล้ววางทับ
  // (ใส่ตัวหนังสือใน SVG ตรงๆ ฟอนต์ไทยขึ้นไม่แน่นอนแล้วแต่เครื่อง — Windows ไม่อ่านไฟล์ฟอนต์ที่ให้ไว้เลย)
  const texts = [];
  const T = (text, x, y, size, o = {}) => texts.push({ text, x, y, size, ...o });
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;
  svg += `<rect width="${W}" height="${H}" fill="#FBF8F3"/>`;
  T(`ปฏิทินงานติดตั้ง ${TH_MONTHS[month - 1]} ${year + 543}`, PAD, 22, 40, { bold: true, color: '#5A3A22' });
  T(title, PAD, 78, 22, { color: '#8A7A6A' });
  // คำอธิบายสี (ชิดขวา)
  let lx = W - PAD;
  for (const label of ['รอแก้', 'ติดตั้ง', 'วัดหน้างาน']) {
    const tw = label.length * 12 + 44;
    lx -= tw;
    svg += `<rect x="${lx}" y="44" width="18" height="18" rx="4" fill="${COLOR[label]}"/>`;
    T(label, lx + 26, 40, 20, { color: '#5A4A3A' });
  }
  // หัววัน
  const top = HEAD;
  for (let i = 0; i < 7; i++) T(TH_WD[i], PAD + i * cw + cw / 2, top + 6, 22, { bold: true, anchor: 'middle', color: i === 0 ? '#9A9AA6' : '#6B4326' });
  // ช่องวัน
  for (let w = 0; w < weeks; w++) for (let i = 0; i < 7; i++) {
    const n = w * 7 + i - lead + 1;
    const x = PAD + i * cw, y = top + WDH + w * ch;
    const inMonth = n >= 1 && n <= days;
    const iso = inMonth ? `${year}-${String(month).padStart(2, '0')}-${String(n).padStart(2, '0')}` : '';
    const isToday = iso === today;
    const fill = !inMonth ? '#F3EEE7' : i === 0 ? '#ECEBEF' : '#FFFFFF';
    svg += `<rect x="${x + 3}" y="${y + 3}" width="${cw - 6}" height="${ch - 6}" rx="12" fill="${fill}" stroke="${isToday ? '#C79A4B' : '#E6DCCF'}" stroke-width="${isToday ? 3 : 1}"/>`;
    if (!inMonth) continue;
    T(String(n), x + 16, y + 10, 24, { bold: true, color: i === 0 ? '#9A9AA6' : isToday ? '#C79A4B' : '#5A3A22' });
    if (i === 0) T('ร้านปิด', x + cw - 16, y + 14, 16, { anchor: 'end', color: '#9A9AA6' });
    const list = byDay[iso] || [];
    const show = list.length > 7 ? list.slice(0, 6) : list;
    show.forEach((j, k) => {
      const yy = y + 46 + k * LINE_H;
      const col = COLOR[j.kind] || COLOR['ติดตั้ง'];
      svg += `<rect x="${x + 12}" y="${yy}" width="${cw - 24}" height="${LINE_H - 4}" rx="6" fill="${col}" fill-opacity="${j.done ? 0.10 : 0.20}"/>`;
      svg += `<rect x="${x + 12}" y="${yy}" width="5" height="${LINE_H - 4}" rx="2" fill="${col}"/>`;
      const label = `${j.time ? j.time + ' ' : ''}${j.unknownZone ? '? ' : ''}${j.name}`;
      T(label, x + 24, yy + 2, 17, { color: j.done ? '#9A8F84' : '#3A2A1E', strike: j.done, maxW: cw - 44 });
    });
    if (list.length > 7) T(`+ อีก ${list.length - 6} งาน`, x + 24, y + 46 + 6 * LINE_H + 1, 17, { color: '#8A7A6A' });
  }
  T('? = ในเว็บยังไม่ได้ใส่โซน · ขีดฆ่า = เสร็จแล้ว · ดึงจากปฏิทินงานติดตั้งในเว็บ', PAD, top + WDH + weeks * ch + 16, 18, { color: '#8A7A6A' });
  svg += `</svg>`;

  const layers = [];
  for (const t of texts) {
    let s = t.text, img = await textImage(s, t);
    // ยาวเกินช่อง → ตัดท้ายใส่ … จนพอดี
    while (t.maxW && img.width > t.maxW && s.length > 2) { s = [...s].slice(0, -2).join(''); img = await textImage(s + '…', t); }
    const left = Math.round(t.anchor === 'middle' ? t.x - img.width / 2 : t.anchor === 'end' ? t.x - img.width : t.x);
    layers.push({ input: img.buf, left: Math.max(0, left), top: Math.max(0, Math.round(t.y)) });
  }
  const img = sharp(await sharp(Buffer.from(svg)).composite(layers).png().toBuffer());
  const full = await img.clone().jpeg({ quality: 88 }).toBuffer();
  const preview = await img.clone().resize({ width: 700 }).jpeg({ quality: 80 }).toBuffer();
  return { full, preview };
}

// สร้างรูปของเดือน → คืน image message ของ LINE (null ถ้าไม่มีลิงก์สาธารณะของบอท)
async function calendarMessage({ supabase, year, month, zones, title, zoneOf, today }) {
  const base = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');
  if (!base) throw new Error('ไม่รู้ลิงก์สาธารณะของบอท (ตั้ง PUBLIC_BASE_URL ใน Railway)');
  const from = new Date(`${year}-${String(month).padStart(2, '0')}-01T00:00:00+07:00`);
  const to = new Date(Date.UTC(year, month, 1) - 7 * 3600e3);
  const { data, error } = await supabase.from('installations')
    .select('appointment_datetime, work_type, customer_id, customer_real_name, province, install_zone, installation_status')
    .gte('appointment_datetime', from.toISOString()).lt('appointment_datetime', to.toISOString())
    .order('appointment_datetime', { ascending: true }).limit(500);
  if (error) throw error;
  const jobs = [];
  for (const r of data || []) {
    const z = zoneOf(r);
    if (zones && z && !zones.includes(z)) continue;
    const d = new Date(new Date(r.appointment_datetime).getTime() + 7 * 3600e3).toISOString();
    jobs.push({ date: d.slice(0, 10), time: d.slice(11, 16), name: clean(r.customer_id || r.customer_real_name) || '-',
      kind: kindOf(r), done: DONE.includes(r.installation_status), unknownZone: zones && !z });
  }
  const { full, preview } = await renderMonth({ year, month, jobs, title, today });
  const a = keepImage(full), b = keepImage(preview);
  return { type: 'image', originalContentUrl: `${base}/cal/${a}.jpg`, previewImageUrl: `${base}/cal/${b}.jpg` };
}

module.exports = { registerCalendarRoute, calendarMessage, renderMonth };
