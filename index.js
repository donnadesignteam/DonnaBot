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

  const GROUP_ORDER = process.env.GROUP_ORDER;
  const GROUP_CUT = process.env.GROUP_CUT;
  const GROUP_SEW = process.env.GROUP_SEW;
  const GROUP_IRON = process.env.GROUP_IRON;

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
    }
    return;
  }
}


// อ่านภาพใบงาน
async function handleImage(replyToken, messageId) {
  try {
    // ดึงภาพจาก LINE
    const lineResponse = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
  headers: {
    Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
  }
});
    const arrayBuffer = await lineResponse.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);
    const workCompressedBuffer = await sharp(imageBuffer)
  .resize(600, 600, { fit: 'inside' })
  .jpeg({ quality: 60 })
  .toBuffer();
const base64Image = workCompressedBuffer.toString('base64');

    // ส่งให้ Claude อ่าน
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
            text: 'อ่านข้อมูลจากใบงานแล้วตอบเป็น JSON เท่านั้น ห้ามมี markdown หรือข้อความอื่น ใช้รูปแบบ {"order_number":"","customer_name":"","platform":"","order_date":"","technician":"","note":"","items":[{"curtain_type":"","rail_floors":"","rail_head":"","color_code":"","color_name":"","eye_color":"","width":0,"height":0,"quantity":0,"unit":"ผืน"}]} โดย order_number=เลข ID ลูกค้าหลัง platform, customer_name=เลขออเดอร์ยาวๆ, platform=Tiktok/Shopee/Facebook/LineOA/Lazada, order_date=วันที่ในใบ ถ้าปีไม่ชัดใช้ 2026 เดือนภาษาไทยให้แปลงให้ถูกต้องเช่น ม.ค.=1 ก.พ.=2 มี.ค.=3 เม.ย.=4 พ.ค.=5 มิ.ย.=6 ก.ค.=7 ส.ค.=8 ก.ย.=9 ต.ค.=10 พ.ย.=11 ธ.ค.=12, technician=ชื่อช่างถ้าไม่มีใส่ว่าง, note=หมายเหตุที่ลูกค้าระบุมาชัดเจนเท่านั้น เช่น ขอสีเข้มขึ้น ขอเย็บพิเศษ ถ้าไม่มีหมายเหตุชัดเจนให้ใส่ว่าง ห้ามใส่ชื่อช่างหรือตัวเขียนที่ไม่ชัดเจน, items=แยกทุกรายการแต่ละสีหรือประเภทเป็น 1 item, curtain_type=ประเภทเช่นรางตาไก่/ม่านตาไก่/ม่านซ่อนหู/ผ้าโปร่ง, rail_floors=จำนวนชั้นของรางเช่น1ชั้นหรือ2ชั้นถ้าไม่ใช่รางใส่ว่าง, rail_head=หัวรางเช่นหัวกระดูมหัวเรียบถ้าไม่ใช่รางใส่ว่าง, color_name=ชื่อสีอ่านให้ถูกต้องเช่นเทาเบจเทาเมฆขาวครีม, eye_color=สีตาไก่เช่นสีขาวสีดำถ้าไม่มีใส่ว่าง, ถ้าเป็นรางให้ใส่ width=ความยาวรางเป็นเมตรเช่น0.70=0.70 height=0, ถ้าเป็นม่านให้ใส่ width=กว้าง height=สูง อ่านเป็นเมตรเช่นก1.30=1.30, unit=ผืนหรือชุด',
          },
        ],
      }],
    });

    const raw = response.content[0].text;
console.log('Claude raw response:', raw);
const cleaned = raw.replace(/```json|```/g, '').trim();
const data = JSON.parse(cleaned);

    // อัปโหลดรูปไป Supabase Storage
    const compressedBuffer = await sharp(imageBuffer)
  .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 70 })
  .toBuffer();

const fileName = `${Date.now()}.jpg`;
const { data: uploadData, error: uploadError } = await supabase.storage
  .from('order-images')
  .upload(fileName, compressedBuffer, {
    contentType: 'image/jpeg',
  });
console.log('upload data:', uploadData);
console.log('upload error:', uploadError);
    const { data: urlData } = supabase.storage.from('order-images').getPublicUrl(fileName);
    data.image_url = urlData.publicUrl;

    // บันทึกลง Database
    await supabase.from('orders').insert([data]);

    // ตอบกลับ LINE
    const itemsText = data.items.map(i => {
  const isRang = i.curtain_type.includes('ราง');
  const size = isRang ? `ยาว ${i.width} ม.` : `${i.width}*${i.height}`;
  const eye = i.eye_color ? `${i.eye_color} ` : '';
  const railInfo = isRang ? ` ${i.rail_floors || ''} ${i.rail_head || ''}`.trim() : '';
  return `  ${i.curtain_type}${railInfo} ${eye}${i.color_code || ''} ${i.color_name} ${size} = ${i.quantity} ${i.unit}`;
}).join('\n');

await client.replyMessage({
  replyToken,
  messages: [{
    type: 'text',
    text: `✅ บันทึกแล้วครับ
วันที่: ${data.order_date}
ช่องทาง: ${data.platform}
ลูกค้า: ${data.order_number}
ออเดอร์: ${data.customer_name}
รายการ:
${itemsText}
หมายเหตุ: ${data.note || '-'}
ช่าง: ${data.technician || '-'}`,
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

// ตอบคำถาม
async function handleQuestion(replyToken, question) {
  try {
    // ดึงข้อมูลสต็อกทั้งหมด
    const { data: stock, error } = await supabase.from('stock').select('*');
console.log('stock data:', stock);
console.log('stock error:', error);
    const stockText = (stock || []).map(s =>
      `รหัส ${s.color_code} (${s.color_name}): เหลือ ${s.quantity_remaining} ม้วน`
    ).join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `ข้อมูลสต็อกผ้าม่านปัจจุบัน:\n${stockText}\n\nคำถาม: ${question}\n\nตอบเป็นภาษาไทยสั้นๆ กระชับ`,
      }],
    });

    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: response.content[0].text }],
    });

  } catch (err) {
    console.error(err);
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: '❌ เกิดข้อผิดพลาด กรุณาลองใหม่ครับ' }],
    });
  }
}

// อ่าน text ออเดอร์จากกลุ่มแผนกออเดอร์
async function handleOrderText(replyToken, text) {
  try {
    const platforms = ['shopee', 'tiktok', 'lineoa', 'lazada', 'facebook'];
    const hasPlatform = platforms.some(p => text.toLowerCase().includes(p));
    if (!hasPlatform) return; // ไม่ใช่ออเดอร์ เงียบ

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: 'อ่านข้อความออเดอร์นี้แล้วตอบเป็น JSON เท่านั้น ห้ามมี markdown {"order_number":"","customer_name":"","platform":"","order_date":"","note":"","items":[{"curtain_type":"","color_code":"","color_name":"","eye_color":"","rail_floors":"","rail_head":"","width":0,"height":0,"quantity":0,"unit":"ผืน"}]} order_number=เลข ID ลูกค้าหลัง platform, customer_name=เลขออเดอร์ยาวๆ, platform=Tiktok/Shopee/Facebook/LineOA/Lazada, order_date=วันที่ถ้าปีไม่ชัดใช้ 2026, items แยกทุกรายการ curtain_type=ประเภท rail_floors=จำนวนชั้นถ้าเป็นราง rail_head=หัวรางถ้ามี width/height อ่านเป็นเมตร ถ้าเป็นรางใส่แค่ width height=0\n\nข้อความ:\n' + text }]
    });

    const raw = response.content[0].text;
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(cleaned);
    data.status = 'รอคิว';

    await supabase.from('orders').insert([data]);

    await client.replyMessageWithHttpInfo({
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
    const base64Image = imageBuffer.toString('base64');

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
        { type: 'text', text: 'อ่านเลขออเดอร์จากภาพนี้ ตอบเป็น JSON เท่านั้น {"order_numbers":["เลข1","เลข2"]} เลขออเดอร์คือเลขยาวๆที่อยู่ใต้ชื่อ platform เช่น 583776830874748554 ไม่ใช่ ID ลูกค้าสั้นๆหลัง Tiktok:/Shopee: เช่น 2145696020' }
      ]}]
    });

    const raw = response.content[0].text.replace(/```json|```/g, '').trim();
    const data = JSON.parse(raw);

    const statusMap = {
      [process.env.GROUP_CUT]: 'กำลังตัด',
      [process.env.GROUP_SEW]: 'กำลังเย็บ',
      [process.env.GROUP_IRON]: 'กำลังรีด'
    };
    const status = statusMap[groupId];

    for (const orderNum of data.order_numbers) {
  await supabase.from('orders')
    .update({ status, status_updated_at: new Date().toISOString() })
    .eq('customer_name', orderNum);
}

const orderList = data.order_numbers.join('\n');
await client.replyMessage({
  replyToken,
  messages: [{ type: 'text', text: `✅ บันทึกแล้วครับ\nออเดอร์:\n${orderList}\nสถานะ: ${status}` }]
});
  } catch (err) {
    console.error(err);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));