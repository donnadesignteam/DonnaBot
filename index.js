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
รูปแบบ: {"order_number":"","customer_name":"","color_code":"","width":0,"height":0,"quantity":0,"order_date":"","technician":""}
หมายเหตุสำคัญ:
- order_number ให้เก็บทุกเลขออเดอร์ที่เห็นในใบงาน คั่นด้วย comma
- customer_name ให้อ่านชื่อลูกค้าหรือชื่อร้านที่เห็นในใบงาน
- width และ height ให้อ่านเป็นเมตรจริงๆ เช่น ก1.30 แปลว่า width = 1.30 ไม่ใช่ 30
- quantity คือจำนวนผืน เช่น 2 ผืน ให้ใส่ 2
- order_date คือวันที่ในใบงาน เช่น 30 เม.ย. 2026
- ถ้าไม่มีชื่อช่าง ให้ใส่ technician เป็นค่าว่าง`,
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
    await client.replyMessage({
      replyToken,
      messages: [{
        type: 'text',
        text: `✅ บันทึกแล้วครับ\nวันที่: ${data.order_date}\nลูกค้า: ${data.customer_name}\nออเดอร์: ${data.order_number}\nสี: ${data.color_code}\nขนาด: ${data.width} x ${data.height} ม.\nจำนวน: ${data.quantity} ผืน`,
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
      model: 'claude-haiku-4-5',
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