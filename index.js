require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const sharp = require('sharp');
const app = express();

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
  if (event.type !== 'message') return;
  const { replyToken, message } = event;
  const groupId = event.source.groupId;
  console.log('incoming groupId:', groupId, 'type:', message.type);

  const GROUP_ORDER = process.env.GROUP_ORDER;
  const GROUP_CUT = process.env.GROUP_CUT;
  const GROUP_SEW = process.env.GROUP_SEW;
  const GROUP_IRON = process.env.GROUP_IRON;
  const GROUP_ADMIN = process.env.GROUP_ADMIN;

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
      await handleOrderText(replyToken, message.text);
    }
    return;
  }

  // กลุ่มช่าง 3 กลุ่ม — อ่านภาพดูเลขออเดอร์
  if ([GROUP_CUT, GROUP_SEW, GROUP_IRON].includes(groupId)) {
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
            text: 'อ่านข้อมูลจากใบงานแล้วตอบเป็น JSON เท่านั้น ห้ามมี markdown หรือข้อความอื่น ใช้รูปแบบ {"order_number":"","customer_name":"","platform":"","order_date":"","technician":"","note":"","items":[{"curtain_type":"","rail_floors":"","rail_head":"","color_code":"","color_name":"","eye_color":"","width":0,"height":0,"quantity":0,"unit":"ผืน"}]} โดย order_number=เลข ID ลูกค้าหลัง platform, customer_name=เลขออเดอร์ยาวๆ, platform=Tiktok/Shopee/Facebook/LineOA/Lazada, order_date=วันที่ในใบ ถ้าปีไม่ชัดใช้ 2026 เดือนภาษาไทยให้แปลงให้ถูกต้องเช่น ม.ค.=1 ก.พ.=2 มี.ค.=3 เม.ย.=4 พ.ค.=5 มิ.ย.=6 ก.ค.=7 ส.ค.=8 ก.ย.=9 ต.ค.=10 พ.ย.=11 ธ.ค.=12, technician=ชื่อช่างถ้าไม่มีใส่ว่าง, note=หมายเหตุที่ลูกค้าระบุมาชัดเจนเท่านั้น ถ้าไม่มีใส่ว่าง, items=แยกทุกรายการแต่ละสีหรือประเภทเป็น 1 item, curtain_type=ประเภทเช่นรางตาไก่/ม่านตาไก่/ม่านซ่อนหู/ผ้าโปร่ง, rail_floors=จำนวนชั้นของรางถ้าไม่ใช่รางใส่ว่าง, rail_head=หัวรางถ้าไม่ใช่รางใส่ว่าง, color_name=ชื่อสีอ่านให้ถูกต้อง, eye_color=สีตาไก่ถ้าไม่มีใส่ว่าง, ถ้าเป็นรางใส่ width=ความยาว height=0, ถ้าเป็นม่านใส่ width=กว้าง height=สูง อ่านเป็นเมตร, unit=ผืนหรือชุด',
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
        text: '✅ บันทึกแล้วครับ\nวันที่: ' + data.order_date +
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
      messages: [{ type: 'text', text: '❌ อ่านใบงานไม่ได้ กรุณาส่งใหม่อีกครั้งครับ' }],
    });
  }
}

// อ่าน text ออเดอร์จากกลุ่มแผนกออเดอร์
async function handleOrderText(replyToken, text) {
  try {
    const platforms = ['shopee', 'tiktok', 'lineoa', 'lazada', 'facebook'];
    const hasPlatform = platforms.some(p => text.toLowerCase().includes(p));
    if (!hasPlatform) return;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: 'อ่านข้อความออเดอร์นี้แล้วตอบเป็น JSON เท่านั้น ห้ามมี markdown {"order_number":"","customer_name":"","platform":"","order_date":"","note":"","items":[{"curtain_type":"","color_code":"","color_name":"","eye_color":"","rail_floors":"","rail_head":"","width":0,"height":0,"quantity":0,"unit":"ผืน"}]} order_number=เลข ID ลูกค้าหลัง platform ถ้าไม่มีให้ใช้ชื่อลูกค้าแทน, customer_name=เลขออเดอร์ยาวๆถ้าไม่มีให้ใช้ชื่อลูกค้าแทน, platform=Tiktok/Shopee/Facebook/LineOA/Lazada, order_date=วันที่ถ้าปีไม่ชัดใช้ 2026, items แยกทุกรายการ curtain_type=ประเภท rail_floors=จำนวนชั้นถ้าเป็นราง rail_head=หัวรางถ้ามี width/height อ่านเป็นเมตร ถ้าเป็นรางใส่แค่ width height=0\n\nข้อความ:\n' + text }]
    });

    const raw = response.content[0].text;
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(cleaned);
    data.status = 'รอคิว';

    await supabase.from('orders').insert([data]);

    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: '✅' }]
    });
  } catch (err) {
    console.error(err);
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
    const base64Image = imageBuffer.toString('base64');

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

    content.push({ type: 'text', text: exampleText + 'ส่งภาพ 2 เวอร์ชั่น ต้นฉบับและหมุน 270 องศา ให้เลือกเวอร์ชั่นที่อ่านเลขออเดอร์ได้ชัดที่สุด เลขออเดอร์อยู่บรรทัดที่ 3 ถัดจากวันที่และชื่อ platform+ลูกค้า รูปแบบเช่น 260417ZXA1VJVQ หรือ 583776830874748554 หรือ 1082651067631474 ตอบเป็น JSON เท่านั้น {"order_numbers":["เลข1"],"unclear":false,"use_customer_name":false} กฎ: 1) ไม่ใช่วันที่ 2) ไม่ใช่ชื่อลูกค้า 3) ถ้ามีสติ๊กเกอร์ปิดทับเลขออเดอร์ให้ unclear:true 4) ถ้าไม่มั่นใจให้ unclear:true 5) ห้ามเดา 6) ถ้าเลขออเดอร์โดนปิดหรือไม่มีเลยให้ใส่ platform_ชื่อลูกค้า แทนใน order_numbers เช่น "tiktok: AAA","Shopee: BBB","FB: CCC","Facebook: DDD","LineOA: EEE","Lazada: FFF"และ unclear:false ในกรณีนี้' });

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: content }]
    });

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

    if (data.unclear || data.order_numbers.length === 0) {
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: '⚠️ อ่านเลขออเดอร์ไม่ชัดค่ะ กรุณาถ่ายภาพใหม่ให้เห็นตัวเลขชัดขึ้นค่ะ' }]
      });
      return;
    }

    const statusMap = {
      [process.env.GROUP_CUT]: 'กำลังตัด',
      [process.env.GROUP_SEW]: 'กำลังเย็บ',
      [process.env.GROUP_IRON]: 'กำลังรีด'
    };
    const status = statusMap[groupId];

    for (const orderNum of data.order_numbers) {
      const { data: found } = await supabase
        .from('orders')
        .select('id')
        .eq('order_number', orderNum)
        .limit(1);

      if (found && found.length > 0) {
        await supabase.from('orders')
          .update({ status, status_updated_at: new Date().toISOString() })
          .eq('order_number', orderNum);
      } else {
        await supabase.from('orders')
          .update({ status, status_updated_at: new Date().toISOString() })
          .eq('customer_name', orderNum);
      }
    }

    lastImagePerGroup[groupId] = {
      order_numbers: data.order_numbers,
      status: status
    };

    const orderList = data.order_numbers.join('\n');
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: '✅ บันทึกแล้วครับ\nออเดอร์:\n' + orderList + '\nสถานะ: ' + status }]
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
      messages: [{ role: 'user', content: context + '\n\nคำถาม: ' + question + '\n\nตอบเป็นภาษาไทยแบบเป็นกันเอง กระชับ ใช้หางเสียงว่า "ค่ะ" ห้ามใช้ markdown หรือ **ตัวหนา**' }]
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));