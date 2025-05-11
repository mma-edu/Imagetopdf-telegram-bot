const { Telegraf } = require('telegraf');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const fetch = require('node-fetch');

// Initialize bot with environment variable
const bot = new Telegraf(process.env.BOT_TOKEN);

// Verify bot token
if (!process.env.BOT_TOKEN) {
  console.error("Missing BOT_TOKEN environment variable");
  process.exit(1);
}

// Session storage
const userSessions = {};
const MAX_IMAGES_PER_USER = 50; // Set to 50 as requested

// Middleware to handle user sessions
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  
  const userId = ctx.from.id;
  if (!userSessions[userId]) {
    userSessions[userId] = { 
      images: []
    };
  }
  
  ctx.session = userSessions[userId];
  await next();
});

// Start command
bot.command('start', (ctx) => {
  ctx.reply(
        "📸➡️📄 *Image to PDF Bot*\n\n" +
    "Send me images (JPEG/PNG) to convert to PDF!\n\n" +
    "• Max 50 images\n• Need to convert more? Visit:\n  👉 imagestopdf.vercel.app\n• /convert when ready\n• /cancel to clear\n• /help for instructions",
    { parse_mode: 'Markdown' }
  );
});

// Help command
bot.command('help', (ctx) => {
  ctx.reply(
    "🆘 *How to use:*\n\n" +
  "1. Send me images (as photos or files)\n" +
  "2. When ready, type /convert\n" +
  "• Max 50 images per PDF\n" +
  "• For unlimited conversions: imagestopdf.vercel.app",
    { parse_mode: 'Markdown' }
  );
});

// Cancel command
bot.command('cancel', (ctx) => {
  ctx.session.images = [];
  ctx.reply("🗑️ All cleared! Send new images to start over.");
});

// Handle image messages
bot.on('photo', async (ctx) => {
  try {
    const photo = ctx.message.photo.pop();
    await processImage(ctx, photo);
  } catch (error) {
    console.error("Photo error:", error);
    ctx.reply("❌ Error processing photo. Please try again.");
  }
});

// Handle document messages
bot.on('document', async (ctx) => {
  try {
    const doc = ctx.message.document;
    const validTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    const fileExt = doc.file_name?.split('.').pop()?.toLowerCase();
    
    if (validTypes.includes(doc.mime_type) || 
        (fileExt && ['jpg', 'jpeg', 'png'].includes(fileExt))) {
      await processImage(ctx, doc);
    } else {
      ctx.reply("⚠️ Please send JPEG or PNG images only.");
    }
  } catch (error) {
    console.error("Document error:", error);
    ctx.reply("❌ Error processing file. Please try again.");
  }
});

// Process image attachment
async function processImage(ctx, file) {
  if (ctx.session.images.length >= MAX_IMAGES_PER_USER) {
    return ctx.reply(`⚠️ Maximum ${MAX_IMAGES_PER_USER} images per PDF reached. Type /convert to generate your PDF.`);
  }

  ctx.reply("⏳ Processing image...");
  
  try {
    const fileUrl = await ctx.telegram.getFileLink(file.file_id);
    const response = await fetch(fileUrl);
    const imageBuffer = await response.buffer();
    
    const processedImage = await sharp(imageBuffer)
      .rotate()
      .jpeg({ quality: 90 })
      .toBuffer()
      .catch(err => {
        throw new Error("Failed to process image");
      });
    
    ctx.session.images.push(processedImage);
    ctx.reply(`✅ Image added (${ctx.session.images.length}/${MAX_IMAGES_PER_USER}). Send more or /convert.`);
  } catch (error) {
    console.error("Processing error:", error);
    ctx.reply("❌ Failed to process image. Please try another file.");
  }
}

// Convert to PDF command
bot.command('convert', async (ctx) => {
  if (!ctx.session.images || ctx.session.images.length === 0) {
    return ctx.reply("⚠️ No images to convert. Send images first.");
  }

  ctx.reply("🛠️ Creating PDF... This may take a moment for 50 images.");
  
  try {
    const pdfDoc = new PDFDocument();
    const buffers = [];
    let totalSize = 0;
    const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50MB Telegram limit
    
    pdfDoc.on('data', (chunk) => {
      buffers.push(chunk);
      totalSize += chunk.length;
      if (totalSize > MAX_PDF_SIZE) {
        throw new Error("PDF would exceed Telegram's 50MB limit - try with fewer images");
      }
    });

    for (const [index, imgBuffer] of ctx.session.images.entries()) {
      const image = await sharp(imgBuffer).toBuffer();
      pdfDoc.image(image, {
        fit: [500, 700], // Standard PDF page size
        align: 'center',
        valign: 'center'
      });
      
      if (index < ctx.session.images.length - 1) {
        pdfDoc.addPage();
      }
    }
    
    pdfDoc.end();
    await new Promise(resolve => pdfDoc.on('end', resolve));
    
    const pdfBuffer = Buffer.concat(buffers);
    await ctx.replyWithDocument({
      source: pdfBuffer,
      filename: 'images.pdf'
    }, {
      caption: `📄 Your PDF (${ctx.session.images.length} images)`
    });
    
    // Clear session after successful conversion
    ctx.session.images = [];
  } catch (error) {
    console.error("PDF error:", error);
    ctx.reply(`❌ Failed to create PDF: ${error.message}\nTry with fewer images or visit imagestopdf.vercel.app`);
  }
});

// Error handling
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.update.update_id}:`, err);
  ctx.reply("❌ An error occurred. Please try again later.");
});

// Start the bot
bot.launch()
  .then(() => {
    console.log('Bot is running with 50-image limit');
  })
  .catch(err => {
    console.error('Bot failed to start:', err);
  });

// For serverless environments
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);
      res.status(200).end();
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).end();
    }
  } else {
    res.status(200).send('Use POST requests only');
  }
};