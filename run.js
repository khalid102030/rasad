// ════════════════════════════════════════════════════════════
// راصد — أتمتة التحليل اليومي عبر Playwright
// يفتح راصد في متصفح حقيقي، يعبّئ المفاتيح، يضغط "تحميل وتحليل"،
// ينتظر اكتمال التحليل والرفع إلى Supabase، ثم يُغلق.
// المفاتيح تأتي من متغيّرات البيئة (Environment Variables) — آمنة.
// ════════════════════════════════════════════════════════════

const { chromium } = require('playwright');

// ── الإعدادات من متغيّرات البيئة ──
const CFG = {
  url:      process.env.RASAD_URL      || 'https://rasidn.netlify.app',
  sheet:    process.env.RASAD_SHEET    || '',   // رابط Google Sheet (أو معرّفه)
  claude:   process.env.RASAD_CLAUDE   || '',   // مفتاح Claude
  sahmk:    process.env.RASAD_SAHMK    || '',   // مفتاح سهمك
  proxy:    process.env.RASAD_PROXY    || '',   // رابط Apps Script (سهمك)
  owner:    process.env.RASAD_OWNER    || '',   // مفتاح المالك
  timeoutMs: parseInt(process.env.RASAD_TIMEOUT || '180000', 10)  // 3 دقائق افتراضياً
};

function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }

(async () => {
  if (!CFG.owner) { log('❌ RASAD_OWNER (مفتاح المالك) مطلوب — بدونه لا رفع.'); process.exit(1); }

  log('🚀 بدء الأتمتة — فتح المتصفح...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({ locale: 'ar-SA', timezoneId: 'Asia/Riyadh' });
  const page = await ctx.newPage();

  // التقط رسائل الكونسول — نعرف منها اكتمال الرفع
  let uploaded = false, uploadedCount = 0;
  page.on('console', m => {
    const t = m.text();
    if (t.includes('رُفعت') && t.includes('Supabase')) {
      uploaded = true;
      const match = t.match(/رُفعت\s+(\d+)/);
      if (match) uploadedCount = parseInt(match[1], 10);
      log('☁️ ' + t);
    }
    if (t.includes('❌') || t.includes('فشل')) log('⚠️ console: ' + t);
  });
  page.on('pageerror', e => log('⚠️ page error: ' + e.message));

  try {
    log('📂 تحميل الصفحة: ' + CFG.url);
    await page.goto(CFG.url, { waitUntil: 'networkidle', timeout: 60000 });

    // انتظر مكتبة XLSX تجهز (لازمة لتحميل الجلسات)
    await page.waitForFunction(() => typeof window.XLSX !== 'undefined', { timeout: 30000 })
      .catch(() => log('⚠️ XLSX لم تُحمّل — قد يتعثّر تحميل الجلسات'));

    // ── عبّئ الحقول (شاشة البداية) ──
    log('🔑 تعبئة المفاتيح...');
    async function fill(id, val) {
      if (!val) return;
      const el = await page.$('#' + id);
      if (el) { await el.fill(val); }
    }
    await fill('sheetUrl', CFG.sheet);
    await fill('apiKey', CFG.claude);
    await fill('sahmkKeyField', CFG.sahmk);
    await fill('sahmkProxyField', CFG.proxy);
    await fill('ownerKeyField', CFG.owner);

    // فعّل "تذكّر المفتاح" إن وُجد
    const rem = await page.$('#rememberKey');
    if (rem) { await rem.check().catch(() => {}); }

    // علّم أن الإعدادات مُستوردة (يفعّل زر التحليل)
    await page.evaluate(() => {
      try { localStorage.setItem('rasad_settings_imported', '1'); } catch (e) {}
      if (typeof PRO_SETTINGS_IMPORTED !== 'undefined') PRO_SETTINGS_IMPORTED = true;
      const b = document.getElementById('loadBtn');
      if (b) { b.disabled = false; b.style.opacity = ''; }
    });

    // ── اضغط "تحميل وتحليل" ──
    log('⚡ ضغط زر تحميل وتحليل...');
    await page.click('#loadBtn');

    // انتظر التطبيق يظهر (التحميل نجح)
    await page.waitForSelector('#app', { state: 'visible', timeout: 60000 })
      .catch(() => log('⚠️ لم تظهر واجهة التطبيق — قد يكون التحميل تعثّر'));
    log('✅ التطبيق ظهر — التحليل جارٍ...');

    // ── انتظر اكتمال الرفع إلى Supabase ──
    const start = Date.now();
    while (!uploaded && (Date.now() - start) < CFG.timeoutMs) {
      await page.waitForTimeout(2000);
    }

    if (uploaded) {
      log('🎉 نجحت الأتمتة! رُفعت ' + uploadedCount + ' توصية إلى Supabase.');
      // انتظر إضافي بسيط لضمان اكتمال أي رفع متأخر
      await page.waitForTimeout(5000);
      await browser.close();
      process.exit(0);
    } else {
      log('⏱️ انتهت المهلة دون تأكيد الرفع (' + (CFG.timeoutMs/1000) + 'ث).');
      log('   قد يكون التحليل تمّ لكن الرفع تأخّر — تحقّق من Supabase يدوياً.');
      await browser.close();
      process.exit(2);
    }
  } catch (err) {
    log('❌ خطأ: ' + (err.message || err));
    try { await browser.close(); } catch (e) {}
    process.exit(1);
  }
})();
