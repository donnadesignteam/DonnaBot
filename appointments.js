// ── ลงนัดติดตั้ง/วัดหน้างานผ่านแชท LINE ─────────────────────────────
// คำสั่ง: #นัด <ข้อความนัดแบบที่ทีมโพสต์ในกลุ่ม> · #เลื่อน <ลูกค้า> เป็น <วัน เวลา> · #สรุป [กทม|เชียงราย|เชียงใหม่]
// ระยะทดสอบ (8 ต.ค. 69): ใช้ในแชทส่วนตัวกับบอทเท่านั้น และ **ไม่เขียนตาราง installations**
//   · #นัด / #เลื่อน → AI อ่านข้อความ → การ์ดยืนยัน → กด ✅ แค่ตอบว่า "ถ้าใช้จริงจะบันทึกอะไร"
//   · #สรุป / การหางานของ #เลื่อน = อ่านตาราง installations จริง (อ่านอย่างเดียว)
// ตอบด้วย reply ทั้งหมด (ฟรี ไม่กินโควตาข้อความ LINE)

const DRY_RUN = true;   // ‼️ เปลี่ยนเป็น false เมื่อพร้อมให้บันทึกลงเว็บจริง (ยังไม่ได้เขียนส่วนบันทึก)

const ZONES = ['กทม', 'เชียงราย', 'เชียงใหม่'];
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

const MOVE_SYSTEM = () => `คุณอ่านคำสั่งเลื่อนนัดงานติดตั้งของร้านผ้าม่าน แล้วตอบเป็น JSON อย่างเดียว
วันนี้คือ ${bkkToday()} (ปี พ.ศ. ให้ลบ 543 · ไม่ระบุปีให้ใช้วันที่ที่ใกล้วันนี้ที่สุดที่ยังไม่ผ่านไป)
{"query":"คำที่ใช้หางาน เช่น ชื่อลูกค้า/ชื่อไลน์/เบอร์/เลข IN","new_date":"YYYY-MM-DD หรือ ''","new_time":"HH:MM หรือ ''","note":"เหตุผล/หมายเหตุถ้ามี"}`;

// ── การ์ดยืนยัน (Flex) ──
function card(title, rows, buttons, color = '#8B5E3C') {
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: color, paddingAll: '14px',
        contents: [{ type: 'text', text: title, color: '#FFFFFF', weight: 'bold', size: 'md', wrap: true }] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm',
        contents: rows.filter(([, v]) => v).map(([k, v]) => ({
          type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: k, color: '#8A8A8A', size: 'sm', flex: 3 },
            { type: 'text', text: String(v), color: '#222222', size: 'sm', flex: 7, wrap: true },
          ] })) },
      footer: buttons.length ? { type: 'box', layout: 'horizontal', spacing: 'sm',
        contents: buttons.map(([label, data, style]) => ({
          type: 'button', style: style || 'secondary', height: 'sm', color: style === 'primary' ? '#8B5E3C' : undefined,
          action: { type: 'postback', label, data, displayText: label } })) } : undefined,
    },
  };
}

const whenText = (date, time) => date ? `${thaiDayLabel(date)}${time ? ' เวลา ' + time + ' น.' : ' (ยังไม่มีเวลา)'}` : '❗ยังไม่มีวัน';

// ── #นัด ──
async function handleNew(ctx, replyToken, text) {
  const { client, anthropic } = ctx;
  if (!text) return reply(client, replyToken, 'พิมพ์ #นัด ตามด้วยรายละเอียดนัด เช่น\n#นัด ติดตั้ง ศุกร์ 9/10 10.00\nLineOA: Att 0900381117\nคอนโด notting hill ห้อง 1/123\nhttps://maps.app.goo.gl/...');
  const a = await askJson(anthropic, NEW_SYSTEM(), text);
  if (!a) return reply(client, replyToken, 'อ่านข้อความไม่ออก ลองพิมพ์ใหม่อีกทีนะคะ');
  const t = keep({ kind: 'new', data: a });
  // ช่องที่ขาด — AI บางทีตอบเป็นชื่อฟิลด์อังกฤษ แปลงเป็นไทยให้อ่านง่าย
  const TH = { date: 'วัน', time: 'เวลา', customer_id: 'ชื่อไลน์ลูกค้า', customer_real_name: 'ชื่อจริง', phone: 'เบอร์', address: 'ที่อยู่', location_link: 'แผนที่', install_zone: 'โซน' };
  const missing = [...new Set((a.missing || []).filter(Boolean).map(x => TH[x] || x))];
  const past = a.date && a.date < bkkToday();
  const rows = [
    ['งาน', a.work_type], ['วันนัด', whenText(a.date, a.time) + (past ? ' ⚠️ วันนี้ผ่านไปแล้ว' : '')], ['ลูกค้า', a.customer_id], ['ชื่อจริง', a.customer_real_name],
    ['เบอร์', a.phone], ['ที่อยู่', a.address], ['แผนที่', a.location_link], ['โซน', a.install_zone || '❗ไม่รู้โซน'],
    ['หมายเหตุ', a.notes], ['ยังขาด', missing.length ? missing.join(', ') : ''],
  ];
  await client.replyMessage({ replyToken, messages: [card('📍 ลงนัดใหม่ (ทดสอบ)', rows,
    [['✅ ยืนยัน', `appt:ok:${t}`, 'primary'], ['✏️ แก้', `appt:edit:${t}`]])] });
}

// หางานจากคำค้น (อ่านอย่างเดียว) — งานที่ยังไม่เสร็จ นัดตั้งแต่ 30 วันก่อน หรือยังไม่มีวัน
async function findJobs(supabase, query) {
  const since = new Date(Date.now() - 30 * 86400e3).toISOString();
  const { data, error } = await supabase.from('installations')
    .select('id, serial_no, appointment_datetime, work_type, customer_id, customer_real_name, phone, install_zone, installation_status')
    .or(`appointment_datetime.gte.${since},appointment_datetime.is.null`)
    .order('appointment_datetime', { ascending: true, nullsFirst: false })
    .limit(800);
  if (error) throw error;
  const q = String(query || '').trim();
  const qd = digits(q), qn = norm(q);
  const serial = (q.match(/^IN\s*0*(\d+)$/i) || [])[1];
  return (data || []).filter(r => !DONE.includes(r.installation_status)).filter(r => {
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

function moveCard(job, a, t) {
  const { date, time } = toBkk(job.appointment_datetime);
  return card('🔁 เลื่อนนัด (ทดสอบ)', [
    ['งาน', jobLabel(job)], ['เดิม', date ? whenText(date, time) : 'ยังไม่มีวัน'],
    ['ใหม่', whenText(a.new_date, a.new_time || time)], ['หมายเหตุ', a.note],
  ], [['✅ ยืนยัน', `appt:ok:${t}`, 'primary'], ['✏️ แก้', `appt:edit:${t}`]], '#4F6D7A');
}

// ── #เลื่อน ──
async function handleMove(ctx, replyToken, text) {
  const { client, anthropic, supabase } = ctx;
  if (!text) return reply(client, replyToken, 'พิมพ์ #เลื่อน ตามด้วยลูกค้าและวันใหม่ เช่น\n#เลื่อน Att เป็น 9/10 13.00\n(อ้างงานด้วยชื่อไลน์ ชื่อจริง เบอร์ หรือเลข IN ก็ได้)');
  const a = await askJson(anthropic, MOVE_SYSTEM(), text);
  if (!a || !a.query) return reply(client, replyToken, 'ไม่รู้ว่าจะเลื่อนงานของใคร ลองพิมพ์ชื่อลูกค้าหรือเบอร์ด้วยนะคะ');
  if (!a.new_date && !a.new_time) return reply(client, replyToken, `เจองานของ "${a.query}" แต่ไม่รู้ว่าจะเลื่อนเป็นวันไหน ลองพิมพ์ใหม่พร้อมวัน/เวลาใหม่นะคะ`);
  const jobs = await findJobs(supabase, a.query);
  if (!jobs.length) return reply(client, replyToken, `ไม่เจองานที่ยังไม่เสร็จของ "${a.query}" ในปฏิทินงานติดตั้ง\nลองค้นด้วยเบอร์ หรือเลข IN แทนได้ค่ะ`);
  if (jobs.length === 1) {
    const t = keep({ kind: 'move', job: jobs[0], data: a });
    return client.replyMessage({ replyToken, messages: [moveCard(jobs[0], a, t)] });
  }
  // เจอหลายงาน → ให้เลือก (ปุ่มละงาน สูงสุด 4)
  const t = keep({ kind: 'pick', jobs: jobs.slice(0, 4), data: a });
  const msg = card(`เจอ ${jobs.length} งาน — เลือกงานที่จะเลื่อน`, [['ค้นด้วย', a.query]], [], '#4F6D7A');
  msg.contents.footer = { type: 'box', layout: 'vertical', spacing: 'sm', contents: jobs.slice(0, 4).map((j, i) => ({
    type: 'button', style: 'secondary', height: 'sm',
    action: { type: 'postback', label: jobLabel(j).slice(0, 40), data: `appt:pick:${t}:${i}`, displayText: jobLabel(j) } })) };
  return client.replyMessage({ replyToken, messages: [msg] });
}

// ── #สรุป ── (อ่านอย่างเดียว · หน้าตาเหมือนโพสต์ "🔥อัพเดตงานติดตั้ง" ของทีม)
async function handleSummary(ctx, replyToken, text) {
  const { client, supabase } = ctx;
  const zone = ZONES.find(z => text.includes(z)) || '';
  const from = new Date(`${bkkToday()}T00:00:00+07:00`).toISOString();
  const cols = 'serial_no, appointment_datetime, work_type, customer_id, customer_real_name, phone, province, install_zone, work_details, location_link, notes, installation_status, created_at';
  let q1 = supabase.from('installations').select(cols).gte('appointment_datetime', from).order('appointment_datetime', { ascending: true }).limit(80);
  let q2 = supabase.from('installations').select(cols).is('appointment_datetime', null)
    .gte('created_at', new Date(Date.now() - 120 * 86400e3).toISOString()).order('created_at', { ascending: false }).limit(40);
  const [{ data: up, error: e1 }, { data: wait, error: e2 }] = await Promise.all([q1, q2]);
  if (e1 || e2) throw e1 || e2;

  const zonesToShow = zone ? [zone, ''] : [...ZONES, ''];
  const parts = [];
  for (const z of zonesToShow) {
    const rows = (up || []).filter(r => !DONE.includes(r.installation_status) && zoneOf(r) === z);
    const pend = (wait || []).filter(r => !DONE.includes(r.installation_status) && zoneOf(r) === z);
    if (!rows.length && !pend.length) continue;
    let s = `${z ? '#' + z : '❓ยังไม่ระบุโซนในเว็บ (ไปใส่โซนในปฏิทินงานติดตั้งด้วย)'}\n`;
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
      s += `______________________\n❗❗งานรอยืนยันวัน❗❗\n`;
      for (const r of pend) s += `- ${r.customer_id || r.customer_real_name || '-'}${r.notes ? ' **' + r.notes : ''}\n`;
    }
    parts.push(s.trim());
  }
  if (!parts.length) return reply(client, replyToken, `ไม่มีงานที่ยังไม่เสร็จ${zone ? 'ในโซน' + zone : ''}ในปฏิทินงานติดตั้ง`);
  // รวมทุกโซนเป็นข้อความเดียว (เดิมแยกโซนละก้อน user บอกว่าขึ้นหลายก้อน) — แยกก้อนใหม่เฉพาะตอนยาวเกินที่ LINE รับได้
  // ข้อความ LINE ยาวได้ 5,000 ตัว และตอบได้ทีละไม่เกิน 5 ข้อความ · ตัดตรงรอยต่อโซน/บรรทัด ไม่ตัดกลางงาน
  const head = `🔥อัพเดตงานติดตั้ง+วัดหน้างาน🔥\n(ดึงจากเว็บ · ${bkkToday().split('-').reverse().join('/')})`;
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
  await client.replyMessage({ replyToken, messages: msgs.slice(0, 5).map(text => ({ type: 'text', text })) });
}

// ── ปุ่มในการ์ด ──
async function handlePostback(ctx, replyToken, data) {
  const { client } = ctx;
  const [, act, t, idx] = data.split(':');
  const p = pending.get(t);
  if (!p) return reply(client, replyToken, 'การ์ดนี้หมดอายุแล้ว (เกิน 2 ชม. หรือบอทเพิ่งรีสตาร์ท) พิมพ์คำสั่งใหม่อีกทีนะคะ');
  if (act === 'edit') {
    pending.delete(t);
    return reply(client, replyToken, p.kind === 'new'
      ? 'ยกเลิกการ์ดนี้แล้ว พิมพ์ #นัด ใหม่พร้อมข้อมูลที่ถูกต้องได้เลยค่ะ'
      : 'ยกเลิกการ์ดนี้แล้ว พิมพ์ #เลื่อน ใหม่ได้เลยค่ะ');
  }
  if (act === 'pick') {
    const job = p.jobs[Number(idx)];
    if (!job) return reply(client, replyToken, 'ไม่เจองานที่เลือก ลองพิมพ์ #เลื่อน ใหม่นะคะ');
    pending.delete(t);
    const t2 = keep({ kind: 'move', job, data: p.data });
    return client.replyMessage({ replyToken, messages: [moveCard(job, p.data, t2)] });
  }
  if (act === 'ok') {
    pending.delete(t);
    if (DRY_RUN) {
      if (p.kind === 'new') {
        const a = p.data;
        return reply(client, replyToken, `🧪 ทดสอบ — ยังไม่บันทึกลงเว็บ\nถ้าใช้จริง จะเพิ่มในปฏิทินงานติดตั้ง:\n${a.work_type} · ${whenText(a.date, a.time)}\n${a.customer_id || a.customer_real_name || ''}${a.install_zone ? ' · โซน' + a.install_zone : ''}`);
      }
      const { time } = toBkk(p.job.appointment_datetime);
      return reply(client, replyToken, `🧪 ทดสอบ — ยังไม่แก้ในเว็บ\nถ้าใช้จริง จะเลื่อน ${jobLabel(p.job)}\nเป็น ${whenText(p.data.new_date || toBkk(p.job.appointment_datetime).date, p.data.new_time || time)}`);
    }
  }
}

async function reply(client, replyToken, text) {
  await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
}

// ข้อความขึ้นต้นด้วยคำสั่งไหม → จัดการแล้วคืน true
async function handleApptText(ctx, replyToken, text) {
  const m = text.match(/^#\s*(นัด|เลื่อน|สรุป)\s*([\s\S]*)$/);
  if (!m) return false;
  try {
    if (m[1] === 'นัด') await handleNew(ctx, replyToken, m[2].trim());
    else if (m[1] === 'เลื่อน') await handleMove(ctx, replyToken, m[2].trim());
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

module.exports = { handleApptText, handleApptPostback };
