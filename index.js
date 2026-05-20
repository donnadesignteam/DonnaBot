require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const sharp = require('sharp');
const app = express();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// Config
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const lastImagePerGroup = {};

// Webhook route
app.post('/webhook',
  line.middleware(lineConfig),
  async (req, res) => {
    res.sendStatus(200);
    const events = req.body.events;
    for (const event of events) {
      await handleEvent(event);
    }
  }
);

async function handleEvent(event) {
  if (event.type === 'unsend') {
    await handleUnsend(event);
    return;
  }
  if (event.type !== 'message') return;
  const { replyToken, message } = event;
  const groupId = event.source.groupId;
  console.log('incoming groupId:', groupId, 'type:', message.type);

  const GROUP_ORDER = process.env.GROUP_ORDER;
  const GROUP_CUT = process.env.GROUP_CUT;
  const GROUP_SEW = process.env.GROUP_SEW;
  const GROUP_IRON = process.env.GROUP_IRON;
  const GROUP_ADMIN = process.env.GROUP_ADMIN;
  const GROUP_PACK = process.env.GROUP_PACK;
  const GROUP_SUPPLIER = process.env.GROUP_SUPPLIER;

  // กลุ่มแอดมิน — ตอบคำถาม @บอท
  if (groupId === GROUP_ADMIN) {
    if (message.type === 'text' && message.text.startsWith('@บอท')) {
      const question = message.text.replace('@บอท', '').trim();
      await handleAdminQuestion(replyToken, question);
    }
    return;
  }

  // กลุ่มแผนกออเดอร์ — อ่าน text บันทึกออเดอร์
  if (groupId === GROUP_ORDER) {
    if (message.type === 'text') {
      const text = message.text.trim();
      const orderMatch = text.match(/[A-Z0-9]{10,}/);
      if (orderMatch && (text.includes('ยกเลิก') || text.includes('แก้') || text.includes('เปลี่ยน'))) {
        await handleOrderAction(replyToken, text);
        return;
      }
      await handleOrderText(replyToken, text, event.message.id);
    }
    return;
  }

  if (groupId === GROUP_SUPPLIER) {
    if (message.type === 'text') {
      const text = message.text.trim();
      if (text.includes('ของเข้า') || text.includes('ได้รับแล้ว') || text.includes('เข้าแล้ว') || text === 'เข้า') {
        await handleSupplierUpdate(replyToken, text);
      } else {
        await handleSupplierOrder(replyToken, text, event.message.id);
      }
    }
    return;
  }

  if (!groupId && event.source.type === 'user') {
    if (message.type === 'text') {
      await handleDirectChat(replyToken, event.source.userId, message.text.trim());
    }
    return;
  }

  // กลุ่มช่าง 4 กลุ่ม — อ่านภาพดูเลขออเดอร์
  if ([GROUP_CUT, GROUP_SEW, GROUP_IRON, GROUP_PACK].includes(groupId)) {
    if (message.type === 'image') {
      await handleWorkImage(replyToken, message.id, groupId);
      return;
    }
    if (message.type === 'text') {
      const text = message.text.trim();
      if (text === 'ถูก') {
        await handleFeedbackCorrect(replyToken, groupId);
        return;
      }
      if (text.startsWith('แก้ ')) {
        const correctNum = text.replace('แก้ ', '').trim();
        await handleFeedbackCorrect(replyToken, groupId, correctNum);
        return;
      }
    }
    return;
  }
}

// อ่านภาพใบงาน (กลุ่มออเดอร์เดิม ถ้าต้องการใช้)
async function handleImage(replyToken, messageId) {
  try {
    const lineResponse = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    const arrayBuffer = await lineResponse.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

    const compressedBuffer = await sharp(imageBuffer)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    const base64Image = compressedBuffer.toString('base64');

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Image },
          },
          {
            type: 'text',
            text: 'อ่านข้อมูลจากใบงานแล้วตอบเป็น JSON เท่านั้น ห้ามมี markdown หรือข้อความอื่น ใช้รูปแบบ {"order_number":"","customer_name":"","platform":"","order_date":"","technician":"","note":"","items":[{"curtain_type":"","rail_floors":"","rail_head":"","color_code":"","color_name":"","eye_color":"","width":0,"height":0,"quantity":0,"unit":"ผืน"}]} โดย order_number=ให้หาข้อความที่เป็น username หรือชื่อบัญชีลูกค้า ซึ่งมักจะเป็นตัวอักษรผสมตัวเลขสั้นๆ อยู่หลังชื่อ platform เช่น "tiktok: 256316fon" username คือ 256316fon , customer_name=ให้หาเลขออเดอร์ซึ่งเป็นรหัสยาวๆ ที่ดูเหมือนรหัสสินค้า มักเป็นตัวเลขล้วนยาว 15-19 หลัก เช่น 583894051762898157 หรือตัวอักษรผสมตัวเลขยาว 13-15 ตัว เช่น 260427VHSUSA6K ถ้ามีหลายเลขคั่นด้วย comma, platform=Tiktok/Shopee/Facebook/LineOA/Lazada, order_date=วันที่ในใบ ถ้าปีไม่ชัดใช้ 2026 เดือนภาษาไทยให้แปลงให้ถูกต้องเช่น ม.ค.=1 ก.พ.=2 มี.ค.=3 เม.ย.=4 พ.ค.=5 มิ.ย.=6 ก.ค.=7 ส.ค.=8 ก.ย.=9 ต.ค.=10 พ.ย.=11 ธ.ค.=12, technician=ชื่อช่างถ้าไม่มีใส่ว่าง, note=หมายเหตุที่ลูกค้าระบุมาชัดเจนเท่านั้น ถ้าไม่มีใส่ว่าง, items=แยกทุกรายการแต่ละสีหรือประเภทเป็น 1 item, curtain_type=ประเภทเช่นรางตาไก่/ม่านตาไก่/ม่านซ่อนหู/ผ้าโปร่ง, rail_floors=จำนวนชั้นของรางถ้าไม่ใช่รางใส่ว่าง, rail_head=หัวรางถ้าไม่ใช่รางใส่ว่าง, color_name=ชื่อสีอ่านให้ถูกต้อง, eye_color=สีตาไก่ถ้าไม่มีใส่ว่าง, ถ้าเป็นรางใส่ width=ความยาว height=0, ถ้าเป็นม่านใส่ width=กว้าง height=สูง อ่านเป็นเมตร, unit=ผืนหรือชุด',
          },
        ],
      }],
    });

    const raw = response.content[0].text;
    console.log('Claude raw response:', raw);
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(cleaned);

    // อัปโหลดรูปไป Supabase Storage
    const fileName = `${Date.now()}.jpg`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('order-images')
      .upload(fileName, compressedBuffer, { contentType: 'image/jpeg' });
    console.log('upload data:', uploadData);
    console.log('upload error:', uploadError);

    const { data: urlData } = supabase.storage.from('order-images').getPublicUrl(fileName);
    data.image_url = urlData.publicUrl;

    await supabase.from('orders').insert([data]);

    const itemsText = data.items.map(i => {
      const isRang = i.curtain_type.includes('ราง');
      const size = isRang ? 'ยาว ' + i.width + ' ม.' : i.width + '*' + i.height;
      const eye = i.eye_color ? i.eye_color + ' ' : '';
      const railInfo = isRang ? (' ' + (i.rail_floors || '') + ' ' + (i.rail_head || '')).trim() : '';
      return '  ' + i.curtain_type + railInfo + ' ' + eye + (i.color_code || '') + ' ' + i.color_name + ' ' + size + ' = ' + i.quantity + ' ' + i.unit;
    }).join('\n');

    await client.replyMessage({
      replyToken,
      messages: [{
        type: 'text',
        text: '✅ บันทึกแล้วค่ะ\nวันที่: ' + data.order_date +
          '\nช่องทาง: ' + data.platform +
          '\nลูกค้า: ' + data.order_number +
          '\nออเดอร์: ' + data.customer_name +
          '\nรายการ:\n' + itemsText +
          '\nหมายเหตุ: ' + (data.note || '-') +
          '\nช่าง: ' + (data.technician || '-'),
      }],
    });

  } catch (err) {
    console.error(err);
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: '❌ อ่านใบงานไม่ได้ กรุณาส่งใหม่อีกครั้งค่ะ' }],
    });
  }
}

// อ่าน text ออเดอร์จากกลุ่มแผนกออเดอร์
async function handleOrderText(replyToken, text, messageId = '') {
  try {
    const platforms = ['shopee', 'tiktok', 'lineoa', 'lazada', 'facebook'];
    const hasPlatform = platforms.some(p => text.toLowerCase().includes(p));
    console.log('hasPlatform:', hasPlatform, 'text:', text.substring(0, 50));
    if (!hasPlatform) return;

    const lines = text.split('\n').map(l => l.trim()).filter(l => l);

    // หา platform และ order_number จาก regex
    let platform = '';
    let order_number = '';
    let order_date = '';
    let customer_name = '';

    for (const line of lines) {
      // หาวันที่
      if (
        /\d{1,2}[\s\/\-]*(ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)[\s\S]*\d{4}/.test(line) ||
        /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(line)
      ) {
        order_date = line;
        continue;
      }
      // หา platform และชื่อลูกค้า
      const platformMatch = line.match(/^(shopee|tiktok|lazada|facebook|lineoa)\s*:\s*(.+)/i);
      if (platformMatch) {
        platform = platformMatch[1].charAt(0).toUpperCase() + platformMatch[1].slice(1).toLowerCase();
        order_number = platformMatch[2].trim();
        continue;
      }
      // หาเลขออเดอร์ (ตัวอักษรใหญ่+ตัวเลข หรือตัวเลขยาว)
      const cleanLine = line.split(/[\s📍✅🔥]/)[0].trim();
      if (cleanLine.length >= 10 && (/^[A-Z0-9]{10,}$/.test(cleanLine) || /^\d{10,}$/.test(cleanLine))) {
        customer_name = customer_name ? customer_name + ',' + cleanLine : cleanLine;
        continue;
      }
    }

    // ให้ Claude อ่านแค่ items
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8096,
      messages: [{ role: 'user', content: 'อ่านรายการสินค้าและวันส่งจากข้อความนี้แล้วตอบเป็น JSON เท่านั้น ห้ามมี markdown {"deadline":"","items":[{"curtain_type":"","color_code":"","color_name":"","eye_color":"","rail_floors":"","rail_head":"","width":0,"height":0,"quantity":0,"unit":"ผืน"}]} deadline=วันส่งก่อนที่ระบุด้วยคำว่า "ส่งก่อน" หรือ "ส่งภายใน" หรือ "ขอเร่งภายใน" ถ้ามีเวลาด้วยให้ใส่เป็น YYYY-MM-DD HH:MM ถ้าไม่มีเวลาใส่แค่ YYYY-MM-DD ถ้าไม่มีใส่ว่าง, curtain_type=ประเภท rail_floors=จำนวนชั้นถ้าเป็นราง rail_head=หัวรางถ้ามี width/height อ่านเป็นเมตรให้ครบทุกหลัก เช่น ก1.617=1.617 ส2.53.5=2.535 ถ้ามีจุดสองตัวให้รวมเป็นทศนิยมเดียว ถ้าเป็นรางใส่แค่ width height=0 unit=ผืนหรือชุด\n\nข้อความ:\n' + text }]
    });

    const raw = response.content[0].text.replace(/```json|```/g, '').trim();
    console.log('order items raw:', raw);
    const parsed = JSON.parse(raw);

    const data = {
      order_number: customer_name,
      customer_name: order_number,
      line_message_id: messageId,
      platform,
      order_date,
      deadline: parsed.deadline || null,
      status: 'รอคิว',
      note: '',
      items: parsed.items
    };

    const { data: inserted, error: insertError } = await supabase.from('orders').insert([data]);
    console.log('insert result:', inserted);
    console.log('insert error:', insertError);
    console.log('order saved:', order_number, customer_name);

  } catch (err) {
    console.error('handleOrderText error:', err);
  }
}

// อ่านภาพจากกลุ่มช่าง ดูแค่เลขออเดอร์
async function handleWorkImage(replyToken, messageId, groupId) {
  try {
    const lineResponse = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    const arrayBuffer = await lineResponse.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

const metadata = await sharp(imageBuffer).metadata();
    const isLandscape = metadata.width > metadata.height;
    const resizedBuffer = await sharp(imageBuffer)
  .resize(800, 800, { fit: 'inside' })
  .jpeg({ quality: 60 })
  .toBuffer();
const base64Image = resizedBuffer.toString('base64');

const { data: examples } = await supabase
      .from('order_examples')
      .select('correct_order_number')
      .order('created_at', { ascending: false })
      .limit(5);

    const exampleText = examples && examples.length > 0
      ? 'ตัวอย่างเลขออเดอร์จากร้านนี้: ' + examples.map(e => e.correct_order_number).join(', ') + ' '
      : '';

    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
    ];

    
    console.log('isLandscape:', isLandscape, 'width:', metadata.width, 'height:', metadata.height);
    if (isLandscape) {
      const rotated = (await sharp(imageBuffer).rotate(270).toBuffer()).toString('base64');
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: rotated } });
    }

    content.push({ type: 'text', text: exampleText + 'ส่งภาพ 2 เวอร์ชั่น ต้นฉบับและหมุน 270 องศา ให้เลือกเวอร์ชั่นที่อ่านเลขออเดอร์ได้ชัดที่สุด เลขออเดอร์อยู่บรรทัดที่ 3 ถัดจากวันที่และชื่อ platform+ลูกค้า รูปแบบเช่น 260417ZXA1VJVQ (Shopee ขึ้นต้นด้วย 26) หรือ 583866734348764827 (Tiktok เป็นตัวเลขล้วนยาว 18-19 หลักถัดจากชื่อลูกค้า) หรือ (Lazada เป็นตัวเลขยาว 1082651067631474) ตอบเป็น JSON เท่านั้น {"order_numbers":["เลข1"],"unclear":false,"use_customer_name":false} กฎ: 1) ไม่ใช่วันที่ 2) ไม่ใช่ชื่อลูกค้า 3) ถ้ามีสิ่งปิดทับบนตัวเลขออเดอร์โดยตรงจนอ่านไม่ออกให้ unclear:true แต่ถ้าเทปหรือสติ๊กเกอร์อยู่คนละบรรทัดกับเลขออเดอร์ให้อ่านได้ปกติ 4) ถ้าไม่มั่นใจให้ unclear:true 5) ห้ามเดา 6) ถ้าเลขออเดอร์โดนปิดหรือไม่มีเลยให้ใส่ platform_ชื่อลูกค้า แทนใน order_numbers เช่น "tiktok: AAA","Shopee: BBB","FB: CCC","Facebook: DDD","LineOA: EEE","Lazada: FFF" และ unclear:false ในกรณีนี้' });

    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 100,
          messages: [{ role: 'user', content: content }]
        });
        break;
      } catch (err) {
        if ((err.status === 429 || err.status === 529) && attempt < 3) {
          console.log('rate limit retry attempt', attempt, 'of 3, waiting', attempt * 3, 'seconds');
          await new Promise(r => setTimeout(r, attempt * 3000));
        } else {
          throw err;
        }
      }
    }
    const raw = response.content[0].text.replace(/```json|```/g, '').trim();
    console.log('work image raw:', raw);

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: '⚠️ อ่านเลขออเดอร์ไม่ชัดค่ะ กรุณาถ่ายภาพใหม่ให้เห็นตัวเลขชัดขึ้นค่ะ' }]
      });
      return;
    }

   const hasCustomerName = data.order_numbers.length > 0 && data.order_numbers[0].includes(':');

if ((data.unclear && !hasCustomerName) || data.order_numbers.length === 0) {
  await client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text: '⚠️ อ่านเลขออเดอร์ไม่ชัดค่ะ กรุณาถ่ายภาพใหม่ให้เห็นตัวเลขชัดขึ้นค่ะ' }]
  });
  return;
}

    const statusMap = {
      [process.env.GROUP_CUT]: 'กำลังตัด',
      [process.env.GROUP_SEW]: 'กำลังเย็บ',
      [process.env.GROUP_IRON]: 'กำลังรีด',
      [process.env.GROUP_PACK]: 'กำลังแพ็ค'
    };
    const status = statusMap[groupId];

    for (const orderNum of data.order_numbers) {
      const { data: existing } = await supabase
        .from('work_status')
        .select('id')
        .eq('order_number', orderNum)
        .limit(1);

      if (existing && existing.length > 0) {
        await supabase.from('work_status')
          .update({ status, status_updated_at: new Date().toISOString() })
          .eq('order_number', orderNum);
      } else {
        await supabase.from('work_status')
          .insert([{ order_number: orderNum, status }]);
      }
    }

    lastImagePerGroup[groupId] = {
      order_numbers: data.order_numbers,
      status: status
    };

    const orderList = data.order_numbers.join('\n');
    const bangkokTime = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
    const dateStr = bangkokTime.getDate() + '/' + (bangkokTime.getMonth() + 1) + '/' + bangkokTime.getFullYear();
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: '✅ บันทึกแล้วค่ะ\nวันที่: ' + dateStr + '\nออเดอร์:\n' + orderList + '\nสถานะ: ' + status }]
    });
  } catch (err) {
    console.error(err);
  }
}

// ตอบคำถามแอดมิน
async function handleAdminQuestion(replyToken, question) {
  try {
    const { data: orders } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    const { data: stock } = await supabase.from('stock').select('*');
    const { data: knowledge } = await supabase.from('knowledge').select('*');
    const { data: pricing } = await supabase.from('pricing').select('*');

    const stockText = (stock || []).map(s =>
      s.color_code + ' ' + s.color_name + ': ' + s.quantity_remaining + ' ม้วน'
    ).join('\n');

    const knowledgeText = (knowledge || []).map(k =>
      '[' + k.category + '] ' + k.question + ': ' + k.answer
    ).join('\n');

    const pricingText = (pricing || []).map(p =>
      '[' + p.category + '] ' + p.product_name + ': ' + p.price_per_unit + ' บาท/' + p.unit + ' ' + (p.note || '')
    ).join('\n');

    const context = 'ข้อมูลออเดอร์ล่าสุด 50 รายการ:\n' + JSON.stringify(orders) +
      '\n\nข้อมูลสต็อกผ้า:\n' + stockText +
      '\n\nข้อมูลความรู้ร้าน:\n' + knowledgeText +
      '\n\nข้อมูลราคาสินค้า:\n' + pricingText;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: context + '\n\nคำถาม: ' + question + '\n\nตอบเป็นภาษาไทยแบบเป็นกันเอง กระชับ ใช้หางเสียงว่า "ค่ะ" ห้ามใช้ markdown หรือ **ตัวหนา** ถ้ามีวันที่ส่งให้แสดงเป็น "ส่งก่อนวันที่ D/M/YYYY" ห้ามใช้คำว่า "ลูกค้าขอ"' }]
    });

    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: response.content[0].text }]
    });
  } catch (err) {
    console.error(err);
  }
}

// บันทึก feedback จากช่าง
async function handleFeedbackCorrect(replyToken, groupId, correctNum = null) {
  try {
    const last = lastImagePerGroup[groupId];
    if (!last) {
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: '⚠️ ไม่พบภาพล่าสุดค่ะ' }]
      });
      return;
    }

    const orderNum = correctNum || last.order_numbers[0];
    await supabase.from('order_examples').insert([{
      correct_order_number: orderNum,
      note: correctNum ? 'แก้ไขจากที่บอทอ่านผิด' : 'บอทอ่านถูก'
    }]);

    if (correctNum) {
      await supabase.from('orders')
        .update({ status: last.status, status_updated_at: new Date().toISOString() })
        .eq('order_number', correctNum);
    }

    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: '✅ บันทึกตัวอย่างแล้วค่ะ ออเดอร์: ' + orderNum }]
    });
  } catch (err) {
    console.error(err);
  }
}

const cron = require('node-cron');

console.log('cron registered');
cron.schedule('00 19 * * *', async () => {
  console.log('cron fired');
  try {
    const now = new Date();
const bangkokOffset = 7 * 60;
const bangkokTime = new Date(now.getTime() + bangkokOffset * 60 * 1000);
const todayStr = bangkokTime.toISOString().split('T')[0];
const today = bangkokTime.getDate() + '/' + (bangkokTime.getMonth() + 1) + '/' + bangkokTime.getFullYear();

const { data: orders } = await supabase
  .from('work_status')
  .select('order_number, status')
  .in('status', ['กำลังตัด', 'กำลังเย็บ', 'กำลังรีด', 'กำลังแพ็ค'])
  .gte('status_updated_at', todayStr);

    const cut = orders.filter(o => o.status === 'กำลังตัด').map(o => o.order_number).join('\n') || '-';
    const sew = orders.filter(o => o.status === 'กำลังเย็บ').map(o => o.order_number).join('\n') || '-';
    const iron = orders.filter(o => o.status === 'กำลังรีด').map(o => o.order_number).join('\n') || '-';

    const pack = (orders || []).filter(o => o.status === 'กำลังแพ็ค').map(o => o.order_number).join('\n') || '-';

    const msg = 'สรุปออเดอร์วันที่ ' + today + '\n\nออเดอร์ถึงช่างตัด\n' + cut + '\n\nออเดอร์ถึงงานเย็บ\n' + sew + '\n\nออเดอร์ถึงช่างรีด\n' + iron + '\n\nออเดอร์ถึงแพ็ค\n' + pack;

    await client.pushMessage({ to: process.env.GROUP_ADMIN, messages: [{ type: 'text', text: msg }] });
  } catch (err) { console.error(err); }
}, { timezone: 'Asia/Bangkok' });

async function handleOrderAction(replyToken, text) {
  try {
    const match = text.match(/[A-Z0-9]{10,}/);
    if (!match) return;
    const orderNum = match[0];

    if (text.includes('ยกเลิก')) {
      await supabase.from('orders')
        .update({ status: 'ยกเลิก' })
        .eq('order_number', orderNum);
      await supabase.from('work_status')
        .update({ status: 'ยกเลิก' })
        .eq('order_number', orderNum);
      console.log('cancelled:', orderNum);
      return;
    }

    const { data: order } = await supabase
      .from('orders')
      .select('items, note, color_code, order_date')
      .eq('order_number', orderNum)
      .single();

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'ข้อมูลออเดอร์ปัจจุบัน: ' + JSON.stringify(order) + '\n\nข้อความแก้ไข: ' + text + '\n\nแก้ไขข้อมูลตามที่ระบุแล้วตอบเป็น JSON เดียวกันที่แก้แล้ว ห้ามมี markdown' }]
    });

    console.log('tokens used - input:', response.usage.input_tokens, 'output:', response.usage.output_tokens);
    const raw = response.content[0].text.replace(/```json|```/g, '').trim();
    const updated = JSON.parse(raw);

    await supabase.from('orders')
      .update(updated)
      .eq('order_number', orderNum);

    console.log('updated order:', orderNum);
  } catch (err) {
    console.error(err);
  }
}

async function handleSupplierOrder(replyToken, text, messageId = '') {
  try {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    let customer_name = '';
    let order_number = '';

    for (const line of lines) {
      const cleanLine = line.split(/[\s📍✅🔥·]/)[0].trim();
      if (!order_number && cleanLine.length >= 10 && (/^[A-Z0-9]{10,}$/.test(cleanLine) || /^\d{12,}$/.test(cleanLine))) {
        order_number = cleanLine;
        continue;
      }
      if (!customer_name && cleanLine.length > 0 && cleanLine.length < 30 && !/^\d/.test(cleanLine)) {
        customer_name = cleanLine;
        continue;
      }
    }

    if (!order_number && !customer_name) return;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'อ่านรายการสินค้าจากข้อความนี้แล้วตอบเป็น JSON เท่านั้น ห้ามมี markdown {"supplier":"","note":"","items":[{"curtain_type":"","width":0,"height":0,"quantity":0,"unit":"ชุด"}]} supplier=ชื่อบริษัทหรือตัวย่อที่อยู่บรรทัดสุดท้ายหรือบรรทัดแรก เช่น VIVA, Kv, CK, KC ถ้าไม่มีใส่ว่าง note=หมายเหตุเช่นดึงขวาดึงซ้าย unit=หน่วยนับที่ระบุในข้อความ เช่น ชุด ถุง อัน ม้วน โหล กล่อง ถ้าไม่มีให้ใส่ ชิ้น\n\nข้อความ:\n' + text }]
    });

    const raw = response.content[0].text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);

    const hasItems = Array.isArray(parsed.items) && parsed.items.length > 0 &&
      parsed.items.some(item => item.curtain_type || item.quantity > 0);
    if (!hasItems) {
      console.log('no order items found, skipping save');
      return;
    }

    await supabase.from('supplier_orders').insert([{
      customer_name,
      order_number,
      supplier: parsed.supplier || '',
      line_message_id: messageId,
      items: parsed.items,
      note: parsed.note || '',
      status: 'รอของ'
    }]);

    console.log('supplier order saved:', customer_name, order_number);
  } catch (err) {
    console.error('handleSupplierOrder error:', err);
  }
}

async function handleSupplierUpdate(replyToken, text) {
  try {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    let order_number = '';
    let customer_name = '';

    for (const line of lines) {
      const cleanLine = line.split(/[\s📍✅🔥·]/)[0].trim();
      if (!order_number && cleanLine.length >= 10 && (/^[A-Z0-9]{10,}$/.test(cleanLine) || /^\d{12,}$/.test(cleanLine))) {
        order_number = cleanLine;
        continue;
      }
      if (!customer_name && cleanLine.length > 0 && cleanLine.length < 30 && !/^\d/.test(cleanLine) && !cleanLine.includes('ของเข้า')) {
        customer_name = cleanLine;
        continue;
      }
    }

    if (order_number) {
      await supabase.from('supplier_orders')
        .update({ status: 'ของเข้าแล้ว', updated_at: new Date().toISOString() })
        .eq('order_number', order_number);
    } else if (customer_name) {
      await supabase.from('supplier_orders')
        .update({ status: 'ของเข้าแล้ว', updated_at: new Date().toISOString() })
        .eq('customer_name', customer_name);
    }

    console.log('supplier updated:', order_number || customer_name);
  } catch (err) {
    console.error('handleSupplierUpdate error:', err);
  }
}

cron.schedule('0 8 * * *', async () => {
  try {
    const now = new Date();
    const bangkokTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);

    // แจ้งเตือนซัพพลายเออร์ค้างเกิน 3 วัน
    const threeDaysAgo = bangkokTime.toISOString().split('T')[0];
    const checkDate = new Date(threeDaysAgo);
    checkDate.setDate(checkDate.getDate() - 3);
    const threeDaysAgoStr = checkDate.toISOString().split('T')[0];

    const { data: pending } = await supabase
      .from('supplier_orders')
      .select('customer_name, order_number')
      .eq('status', 'รอของ')
      .lte('created_at', threeDaysAgoStr + 'T23:59:59+07:00');

    if (pending && pending.length > 0) {
      const list = pending.map(o => o.order_number || o.customer_name).join('\n');
      const msg = '‼️งานที่ยังไม่ได้อัพเดท‼️\n' + list;
      await client.pushMessage({ to: process.env.GROUP_SUPPLIER, messages: [{ type: 'text', text: msg }] });
    }

    // แจ้งเตือน deadline วันนี้
    const todayStr = bangkokTime.toISOString().split('T')[0];
    const { data: deadlineOrders } = await supabase
      .from('orders')
      .select('order_number, deadline')
      .like('deadline', todayStr + '%')
      .neq('status', 'ยกเลิก');

    if (deadlineOrders && deadlineOrders.length > 0) {
      const d = bangkokTime.getDate() + '/' + (bangkokTime.getMonth() + 1) + '/' + String(bangkokTime.getFullYear()).slice(2);
      const orderList = deadlineOrders.map(o => {
        const time = o.deadline && o.deadline.includes(' ') ? o.deadline.split(' ')[1] : '';
        return o.order_number + (time ? ' ' + time : '');
      }).join('\n');
      const msg = '🔥🔥ออเดอร์ส่งด่วนภายในวันนี้ ' + d + '🔥🔥\n' + orderList;
      await client.pushMessage({ to: process.env.GROUP_ORDER, messages: [{ type: 'text', text: msg }] });
    }

  } catch (err) { console.error('cron 8am error:', err); }
}, { timezone: 'Asia/Bangkok' });

async function handleUnsend(event) {
  try {
    const messageId = event.unsend.messageId;
    const groupId = event.source.groupId;

    if (groupId === process.env.GROUP_ORDER) {
      await supabase.from('orders')
        .delete()
        .eq('line_message_id', messageId);
      console.log('order deleted by unsend:', messageId);
    }

    if (groupId === process.env.GROUP_SUPPLIER) {
      await supabase.from('supplier_orders')
        .delete()
        .eq('line_message_id', messageId);
      console.log('supplier order deleted by unsend:', messageId);
    }
  } catch (err) {
    console.error('handleUnsend error:', err);
  }
}

// ── คำนวณขนาดม่านพร้อมเผื่อ ─────────────────────────────
function recommendDimensions({ curtainType, windowType, width, height, canAddBothSides }) {
  const isPleat   = /จีบ/.test(curtainType);
  const isWave    = /ลอนเทป/.test(curtainType);
  const isChain   = /ลอนโซ่/.test(curtainType);
  const isBlind   = /มู่ลี่|ม่านพับ|ม่านม้วน/.test(curtainType);
  let railW;
  if (isBlind) {
    railW = canAddBothSides ? width + 0.10 : width + 0.05;
  } else {
    railW = canAddBothSides ? width + 0.20 : width + 0.10;
  }
  railW = Math.round(railW * 100) / 100;
  let curtainW, qty;
  if (isPleat || isWave) {
    curtainW = Math.round((railW / 2) * 100) / 100;
    qty = 2;
  } else if (isChain) {
    curtainW = Math.round((railW * 1.15) * 100) / 100;
    qty = 2;
  } else {
    curtainW = railW;
    qty = 2;
  }
  let curtainH;
  if (isBlind && /ม่านม้วน|มู่ลี่/.test(curtainType)) {
    curtainH = height + 0.15;
  } else if (/ม่านพับ/.test(curtainType)) {
    curtainH = height + 0.50;
  } else {
    curtainH = windowType === 'door' ? height + 0.20 : height + 0.40;
  }
  curtainH = Math.round(curtainH * 100) / 100;
  return { railW, curtainW, curtainH, qty };
}

async function getSheerRow(curtainType) {
  const typeMap = {
    'ม่านตาไก่': 'ผ้าโปร่งตาไก่',
    'ม่านซ่อนหู': 'ผ้าโปร่งซ่อนหู',
    'ม่านลอนตะขอ': 'ผ้าโปร่งลอนตะขอ',
    'ม่านคอกระเช้า': 'ผ้าโปร่งคอกระเช้า',
    'ม่านจีบ': 'ผ้าโปร่งม่านจีบ',
    'ม่านลอนเทป': 'ผ้าโปร่งลอนเทป',
    'ม่านสอด': 'ผ้าโปร่งม่านสอด',
    'ม่านลอนโซ่': 'ผ้าโปร่งลอนโซ่',
  };
  const baseName = curtainType.replace(/\s*สูงพิเศษ/gi, '').trim();
  const sheerName = typeMap[baseName];
  if (!sheerName) return null;
  const { data } = await supabase
    .from('pricing')
    .select('name, sub_name, price, min_price, unit')
    .eq('category', 'sheer')
    .ilike('name', '%' + sheerName + '%')
    .ilike('sub_name', sheerName)
    .limit(1);
  return data && data.length > 0 ? data[0] : null;
}

// ── ดึงราคาจาก Supabase ──────────────────────────────────
async function getPricingRow(name, subName) {
  const mainKeyword = name.split(/\s+/)[0];
  let q = supabase.from('pricing')
    .select('name, sub_name, price, min_price, unit')
    .neq('unit', 'matrix')
    .ilike('name', '%' + mainKeyword + '%');
  if (subName) q = q.ilike('sub_name', '%' + subName + '%');
  const { data } = await q.limit(3);
  console.log('getPricingRow:', name, subName, '->', data?.[0]?.name, data?.[0]?.sub_name);
  return data && data.length > 0 ? data[0] : null;
}

// ── หาชื่อราง ────────────────────────────────────────────
function getRailName(curtainType, floors) {
  if (/จีบ|ลอนตะขอ/.test(curtainType)) return `รางจีบ${floors}ชั้น`;
  if (/ลอนโซ่/.test(curtainType)) return `รางลอนโซ่${floors}ชั้น`;
  if (/ลอนเทป/.test(curtainType)) return `รางsnake${floors}ชั้น`;
  return `ราง${floors}ชั้น`;
}

// ── helper ───────────────────────────────────────────────
async function replyText(replyToken, text) {
  await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
}

// ── ตอบคำถามออเดอร์ ─────────────────────────────────────
async function handleOrderQuery(replyToken, userId, userText) {
  const { data: rows } = await supabase
    .from('chat_history')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(4);
  const messages = (rows || []).reverse().map(r => ({ role: r.role, content: r.content }));
  messages.push({ role: 'user', content: userText });
  let currentMessages = [...messages];
  let finalText = '';
  let rounds = 0;
  while (rounds < 5) {
    rounds++;
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: 'คุณคือผู้ช่วยร้านผ้าม่าน ตอบภาษาไทยกระชับ ใช้หางเสียง "ค่ะ" ห้าม markdown',
      tools: ADMIN_TOOLS.filter(t => ['get_orders', 'get_work_status', 'get_supplier_orders', 'update_order'].includes(t.name)),
      messages: currentMessages,
    });
    if (response.stop_reason === 'end_turn') {
      finalText = response.content.find(b => b.type === 'text')?.text || '';
      break;
    }
    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const result = await executeTool(block.name, block.input, userId);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      currentMessages.push({ role: 'assistant', content: response.content });
      currentMessages.push({ role: 'user', content: toolResults });
    } else break;
  }
  await supabase.from('chat_history').insert({ user_id: userId, role: 'user', content: userText });
  await supabase.from('chat_history').insert({ user_id: userId, role: 'assistant', content: finalText });
  await client.replyMessage({ replyToken, messages: [{ type: 'text', text: finalText }] });
}

// ── ตอบคำถามทั่วไป ───────────────────────────────────────
async function handleOtherQuery(replyToken, userId, userText, memoryText) {
  const { data: rows } = await supabase
    .from('chat_history')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(4);
  const messages = (rows || []).reverse().map(r => ({ role: r.role, content: r.content }));
  messages.push({ role: 'user', content: userText });
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: 'คุณคือผู้ช่วยร้านผ้าม่าน ตอบภาษาไทยกระชับ ใช้หางเสียง "ค่ะ" ห้าม markdown' + memoryText,
    messages,
  });
  const finalText = response.content[0].text;
  await supabase.from('chat_history').insert({ user_id: userId, role: 'user', content: userText });
  await supabase.from('chat_history').insert({ user_id: userId, role: 'assistant', content: finalText });
  await client.replyMessage({ replyToken, messages: [{ type: 'text', text: finalText }] });
}

// ── handleDirectChat ──────────────────────────────────────
async function handleDirectChat(replyToken, userId, userText) {
  try {
    const { data: memRows } = await supabase
      .from('bot_memory')
      .select('content')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(10);
    const memoryText = (memRows || []).length > 0
      ? '\n\nสิ่งที่จำ:\n' + memRows.map(m => '- ' + m.content).join('\n')
      : '';
    const parseRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content:
        'อ่านข้อความแล้วตอบ JSON เท่านั้น ห้าม markdown\n' +
        '{"intent":"price|size|order|other","curtain_type":"","fabric":"Dimout|Blackout|โปร่ง|ลินิน","floors":2,"window_type":"window|door","width":null,"height":null,"already_sized":null,"both_sides":null}\n' +
        'intent: price=ถามราคา size=ถามขนาด order=ถามออเดอร์/สถานะ other=อื่นๆ\n' +
        'already_sized: true=เผื่อแล้ว false=ยังไม่เผื่อ null=ไม่ได้บอก\n' +
        'both_sides: true=เผื่อได้สองข้าง false=ข้างเดียว null=ไม่ได้บอก\n' +
        'ข้อความ: ' + userText
      }]
    });
    const raw = parseRes.content[0].text.replace(/```json|```/g, '').trim();
    console.log('parsed intent:', raw);
    const intent = JSON.parse(raw);

    if (intent.intent === 'order') return await handleOrderQuery(replyToken, userId, userText);
    if (intent.intent === 'other') return await handleOtherQuery(replyToken, userId, userText, memoryText);

    if (!intent.curtain_type) return await replyText(replyToken, 'กรุณาระบุชนิดม่านด้วยค่ะ เช่น ม่านตาไก่ ม่านพับ มู่ลี่อลูมิเนียม');
    if (!intent.width) return await replyText(replyToken, 'กรุณาระบุขนาดกว้างด้วยค่ะ');
    if (!intent.height) return await replyText(replyToken, 'กรุณาระบุขนาดสูงด้วยค่ะ');

    let { width, height } = intent;
    const curtainType = intent.curtain_type;
    const fabric = intent.fabric || 'Dimout';
    const floors = intent.floors || 2;
    const windowType = intent.window_type || 'window';

    if (intent.already_sized === false || intent.already_sized === null) {
      if (intent.both_sides === null) return await replyText(replyToken, 'เผื่อได้สองข้างหรือข้างเดียวคะ');
      const dims = recommendDimensions({
        curtainType, windowType, width, height,
        canAddBothSides: intent.both_sides !== false
      });
      width = dims.railW;
      height = dims.curtainH;
    }

    const isBlind = /มู่ลี่|ม่านพับ|ม่านม้วน/.test(curtainType);
    const railName = getRailName(curtainType, floors);
    const [railRow, curtainRow, sheerRow] = await Promise.all([
      isBlind ? null : getPricingRow(railName, null),
      getPricingRow(curtainType, fabric),
      floors === 2 && !isBlind ? getSheerRow(curtainType) : null,

    const isWaveOrPleat = /ลอนเทป|จีบ|ลอนตะขอ/.test(curtainType);
    const displayW = isWaveOrPleat ? (width / 2) : width;

    let reply = 'แนะนำใช้ขนาดนี้ได้ค่ะ\n';
    let total = 0;

    if (railRow) {
      const railPrice = Math.round(Math.max(railRow.price * width, railRow.min_price || 0));
      reply += `${railName} ${width.toFixed(2)} = 1 ชุด ${railPrice.toLocaleString()} บาท\n`;
      total += railPrice;
    }
    if (curtainRow) {
      let curtainPrice;
      if (/ม่านพับ/.test(curtainType)) {
        curtainPrice = Math.round(Math.max(curtainRow.price * width, curtainRow.min_price || 0));
        reply += `ม่านพับ ${fabric}\n${width.toFixed(2)} = 1 ชุด ${curtainPrice.toLocaleString()} บาท\n`;
      } else if (/ม่านม้วน/.test(curtainType)) {
        const area = Math.max(width * height * 1.2, 1.5);
        curtainPrice = Math.round(Math.max(curtainRow.price * area, curtainRow.min_price || 0));
        reply += `ม่านม้วน ${fabric}\n${width.toFixed(2)}*${height.toFixed(2)} = 1 ชุด ${curtainPrice.toLocaleString()} บาท\n`;
      } else {
        curtainPrice = Math.round(Math.max(curtainRow.price * width, curtainRow.min_price || 0)) * (isBlind ? 1 : 2);
        const qty = isBlind ? '1 ชุด' : '2 ผืน';
        reply += `${curtainType} ${fabric}\n${displayW.toFixed(2)}*${height.toFixed(2)} = ${qty} ${curtainPrice.toLocaleString()} บาท\n`;
      }
      total += curtainPrice;
    }
    if (sheerRow) {
      const sheerPrice = Math.round(Math.max(sheerRow.price * width, sheerRow.min_price || 0)) * 2;
      reply += `ผ้าโปร่ง\n${displayW.toFixed(2)}*${height.toFixed(2)} = 2 ผืน ${sheerPrice.toLocaleString()} บาท\n`;
      total += sheerPrice;
    }

    reply += `รวม ${total.toLocaleString()} บาทค่ะ`;
    await client.replyMessage({ replyToken, messages: [{ type: 'text', text: reply }] });

  } catch (err) {
    console.error('handleDirectChat error:', err);
    await client.replyMessage({ replyToken, messages: [{ type: 'text', text: 'ขออภัยค่ะ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งค่ะ' }] });
  }
}



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT + ' v2.2'));