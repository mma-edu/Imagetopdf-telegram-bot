const { Telegraf } = require('telegraf');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const axios = require('axios');
const express = require('express');

const app = express();
app.use(express.json());
const bot = new Telegraf(process.env.BOT_TOKEN);

// 1. INITIALIZATION CHECKS
if (!process.env.BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN");
  process.exit(1);
}

// 2. SESSION MANAGEMENT
const userSessions = {};
const MAX_IMAGES = 50;

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  
  const userId = ctx.from.id;
  if (!userSessions[userId]) {
    userSessions[userId] = { images: [] };
  }
  
  // Auto-clean old sessions (24h)
  if (userSessions[userId].timestamp && Date.now() - userSessions[userId].timestamp > 86400000) {
    delete userSessions[userId];
    return ctx.reply("⌛ Session expired. Send /start");
  }

  ctx.session = userSessions[userId];
  ctx.session.timestamp = Date.now();
  await next();
});

// 3. BOT COMMANDS
bot.command('start', (ctx) => {
  ctx.reply(
    "📸➡️📄 *Image to PDF Bot*\n\n" +
    "Send me images (JPEG/PNG) to convert to PDF!\n\n" +
    "• Max 50 images\n• Need to convert more? Visit:\n  👉 imagestopdf.vercel.app\n• /convert when ready\n• /cancel to clear\n• /help for instructions",
    { parse_mode: 'Markdown' }
  );
});

bot.command('help', (ctx) => ctx.reply(
  "🆘 *How to use:*\n\n" +
  "1. Send me images (as photos or files)\n" +
  "2. When ready, type /convert\n" +
  "• Max 50 images per PDF\n" +
  "• For unlimited conversions: imagestopdf.vercel.app",
  { parse_mode: 'Markdown' }
));

bot.command('cancel', (ctx) => {
  ctx.session.images = [];
  ctx.reply("🗑️ Cleared all images!");
});

// 4. IMAGE PROCESSING
async function downloadImage(url) {
  try {
    const response = await axios.get(url, { 
      responseType: 'arraybuffer',
      timeout: 10000
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error('Download error:', error);
    throw new Error('Failed to download image');
  }
}

async function processImage(ctx, file) {
  try {
    if (ctx.session.images.length >= MAX_IMAGES) {
      return ctx.reply(`⚠️ Max ${MAX_IMAGES} images reached. Use /convert now or visit imagestopdf.vercel.app for more.`);
    }

    const fileUrl = await ctx.telegram.getFileLink(file.file_id);
    const imageBuffer = await downloadImage(fileUrl.href);
    
    // Verify and process image
    const processedImage = await sharp(imageBuffer)
      .rotate()
      .jpeg({ quality: 90 })
      .toBuffer();

    const metadata = await sharp(processedImage).metadata();
    
    ctx.session.images.push({
      buffer: processedImage,
      width: metadata.width,
      height: metadata.height
    });

    ctx.reply(`✅ Added image (${ctx.session.images.length}/${MAX_IMAGES})\nType /convert when ready`);
  } catch (error) {
    console.error("Image processing error:", error);
    ctx.reply("❌ Failed to process image. Please send a valid JPEG/PNG file.");
  }
}

// 5. MESSAGE HANDLERS
bot.on('photo', async (ctx) => {
  await processImage(ctx, ctx.message.photo.pop());
});

bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  const validTypes = ['image/jpeg', 'image/png'];
  const fileExt = doc.file_name?.split('.').pop()?.toLowerCase();
  
  if (validTypes.includes(doc.mime_type) || (fileExt && ['jpg', 'jpeg', 'png'].includes(fileExt))) {
    await processImage(ctx, doc);
  } else {
    ctx.reply("⚠️ Only JPEG/PNG images supported");
  }
});

// 6. PDF GENERATION
bot.command('convert', async (ctx) => {
  if (!ctx.session.images?.length) {
    return ctx.reply("⚠️ No images to convert");
  }

  try {
    await ctx.reply("⏳ Creating PDF...");
    
    const pdfDoc = new PDFDocument({ autoFirstPage: false });
    const buffers = [];
    let pdfSize = 0;

    pdfDoc.on('data', (chunk) => {
      buffers.push(chunk);
      pdfSize += chunk.length;
      if (pdfSize > 45 * 1024 * 1024) {
        throw new Error("PDF reached 45MB limit");
      }
    });

    for (const img of ctx.session.images) {
      const pageWidth = img.width * 72 / 96;
      const pageHeight = img.height * 72 / 96;
      
      pdfDoc.addPage({ size: [pageWidth, pageHeight] });
      pdfDoc.image(img.buffer, 0, 0, {
        width: pageWidth,
        height: pageHeight
      });
    }

    const pdfBuffer = await new Promise((resolve, reject) => {
      pdfDoc.on('end', () => resolve(Buffer.concat(buffers)));
      pdfDoc.on('error', reject);
      pdfDoc.end();
    });

    await ctx.replyWithDocument({
      source: pdfBuffer,
      filename: `images_${Date.now()}.pdf`
    });

    ctx.session.images = [];
  } catch (error) {
    console.error("PDF error:", error);
    ctx.reply(`❌ PDF creation failed: ${error.message}`);
  }
});

// 7. ERROR HANDLING
bot.catch((err, ctx) => {
  console.error(`Bot error:`, err);
  ctx.reply("❌ Bot encountered an error. Please try again later.");
});

// 8. SERVER CONFIGURATION
module.exports = app;

app.post('/api', async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.status(200).end();
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}