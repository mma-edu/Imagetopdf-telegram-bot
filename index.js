const { Telegraf } = require('telegraf');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const fetch = require('node-fetch');

// Initialize bot with environment variable
const bot = new Telegraf(process.env.BOT_TOKEN);

// Temporary in-memory storage (replace with database in production)
const userSessions = {};

// Middleware to handle user sessions
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  
  const userId = ctx.from.id;
  if (!userSessions[userId]) {
    userSessions[userId] = { images: [] };
  }
  
  ctx.session = userSessions[userId];
  await next();
});

// Start command
bot.command('start', (ctx) => {
  ctx.reply(
    "📸➡️📄 *Image to PDF Bot*\n\n" +
    "Send me images (JPEG/PNG) and I'll convert them to a PDF file!\n\n" +
    "• Send multiple images to combine them\n" +
    "• Type /convert when ready\n" +
    "• /cancel to clear your images\n"
    "• Type /help to see how to use,
    { parse_mode: 'Markdown' }
  );
});

// Help command
bot.command('help', (ctx) => {
  ctx.reply(
    "🆘 *How to use:*\n\n" +
    "1. Send me images (as photos or files)\n" +
    "2. When ready, type /convert\n" +
    "3. I'll send you a PDF with all images\n\n" +
    "• Max 50 images per PDF\n" +
    "• Images are ordered by send time\n" +
    "• /cancel clears your current images",
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
    const photo = ctx.message.photo.pop(); // Get highest quality version
    await processImage(ctx, photo);
  } catch (error) {
    console.error("Photo error:", error);
    ctx.reply("❌ Error processing photo. Please try again.");
  }
});

// Handle document messages (for files)
bot.on('document', async (ctx) => {
  try {
    const doc = ctx.message.document;
    const validTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    
    if (validTypes.includes(doc.mime_type)) {
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
  if (ctx.session.images.length >= 50) {
    return ctx.reply("⚠️ Maximum 50 images per PDF. Type /convert to generate.");
  }

  ctx.reply("⏳ Processing image...");
  
  try {
    const fileUrl = await ctx.telegram.getFileLink(file.file_id);
    const response = await fetch(fileUrl);
    const imageBuffer = await response.buffer();
    
    // Convert to standardized format
    const processedImage = await sharp(imageBuffer)
      .rotate() // Auto-orient based on EXIF
      .jpeg({ quality: 90 }) // Convert to JPEG
      .toBuffer();
    
    ctx.session.images.push(processedImage);
    ctx.reply(`✅ Image added (${ctx.session.images.length}/50). Send more or /convert.`);
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

  ctx.reply("🛠️ Creating PDF... This may take a moment.");
  
  try {
    const pdfDoc = new PDFDocument();
    const buffers = [];
    
    pdfDoc.on('data', buffers.push.bind(buffers));
    
    // Add each image to PDF
    for (const [index, imgBuffer] of ctx.session.images.entries()) {
      const image = await sharp(imgBuffer).toBuffer();
      pdfDoc.image(image, {
        fit: [500, 700],
        align: 'center',
        valign: 'center'
      });
      
      // Add new page except for last image
      if (index < ctx.session.images.length - 1) {
        pdfDoc.addPage();
      }
    }
    
    // Finalize PDF
    pdfDoc.end();
    await new Promise(resolve => pdfDoc.on('end', resolve));
    
    // Send PDF to user
    const pdfBuffer = Buffer.concat(buffers);
    await ctx.replyWithDocument({
      source: pdfBuffer,
      filename: 'images.pdf'
    }, {
      caption: `📄 Your PDF (${ctx.session.images.length} images)`
    });
    
    // Clear session
    ctx.session.images = [];
  } catch (error) {
    console.error("PDF error:", error);
    ctx.reply("❌ Failed to create PDF. Please try again.");
  }
});

// Error handling
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.update.update_id}:`, err);
  ctx.reply("❌ An error occurred. Please try again later.");
});

// Vercel serverless function handler
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

// Local development support
if (process.env.NODE_ENV === 'development') {
  bot.launch();
  console.log('Bot running in development mode');
}