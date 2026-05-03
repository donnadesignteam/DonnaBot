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
  const { replyToken, message, source } = event;

  // ถ้าเป็นรูปภาพ → อ่านใบงาน
  if (message.type === 'image') {
    await handleImage(replyToken, message.id);
    return;
  }

  // ถ้าเป็นข้อความขึ้นต้นด้วย @บอท → ตอบคำถาม
  if (message.type === 'text' && message.text.startsWith('@บอท')) {
    const question = message.text.replace('@บอท', '').trim();
    await handleQuestion(replyToken, question);
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
    const base64Image = imageBuffer.toString('base64');

    // ส่งให้ Claude อ่าน
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Image },
          },
          {
            type: 'text',
            text: `อ่านข้อมูลจากใบงานนี้แล้วตอบเป็น JSON เท่านั้น ไม่ต้องมีข้อความอื่น
รูปแบบ: {"order_number":"","customer_name":"","platform":"","color_code":"","items":[{"width":0,"height":0,"quantity":0}],"order_date":"","technician":""}
หมายเหตุสำคัญ:
- order_number คือเลข ID ลูกค้าที่อยู่หลังชื่อ platform เช่น Tiktok : 2145696020 ให้ใส่ 2145696020
- customer_name คือเลขออเดอร์ยาวๆ ที่อยู่บรรทัดถัดมา เช่น 583776830874748554
- platform คือช่องทางที่เห็นในใบงาน เช่น Tiktok, Shopee, Facebook, LineOA, Lazada
- color_code คือรหัสสีผ้า เช่น HB81
- items คือรายการขนาดทั้งหมด ให้เก็บทุกขนาดที่เห็น เช่น ก1.50*ส1.60 = 10 ผืน ให้ใส่ width:1.50, height:1.60, quantity:10
- order_date คือวันที่ในใบงาน
- ถ้าไม่มีชื่อช่างใส่ technician เป็นค่าว่าง`,
          },
        ],
      }],
    });

    const raw = response.content[0].text;
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
    const itemsText = data.items.map(i => 
  `  ${i.width}×${i.height} ม. = ${i.quantity} ผืน`
).join('\n');

await client.replyMessage({
  replyToken,
  messages: [{
    type: 'text',
    text: `✅ บันทึกแล้วครับ
วันที่: ${data.order_date}
ช่องทาง: ${data.platform}
ลูกค้า: ${data.order_number}
ออเดอร์: ${data.customer_name}
สี: ${data.color_code}
ขนาด:
${itemsText}
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
      max_tokens: 500,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));