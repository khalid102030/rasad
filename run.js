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

    // انتظر مكتبة XLSX تجهز (لازمة لتحميل الجلسات) — مع محاولة تحميل بديلة
    let xlsxReady = await page.waitForFunction(() => typeof window.XLSX !== 'undefined', { timeout: 45000 })
      .then(() => true).catch(() => false);
    if (!xlsxReady) {
      log('⏳ XLSX لم تجهز — محاولة تحميلها يدوياً...');
      await page.evaluate(() => {
        return new Promise((resolve) => {
          if (typeof window.XLSX !== 'undefined') return resolve();
          const srcs = [
            'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
            'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
            'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js'
          ];
          let i = 0;
          const tryLoad = () => {
            if (typeof window.XLSX !== 'undefined') return resolve();
            if (i >= srcs.length) return resolve();
            const s = document.createElement('script');
            s.src = srcs[i++];
            s.onload = () => setTimeout(() => (typeof window.XLSX !== 'undefined' ? resolve() : tryLoad()), 200);
            s.onerror = tryLoad;
            document.head.appendChild(s);
          };
          tryLoad();
        });
      });
      xlsxReady = await page.evaluate(() => typeof window.XLSX !== 'undefined');
      log(xlsxReady ? '✅ XLSX جهزت بعد المحاولة اليدوية' : '⚠️ تعذّر تحميل XLSX — قد يفشل تحميل الجلسات');
    } else {
      log('✅ XLSX جاهزة');
    }

    // مهلة استقرار قصيرة بعد جهوزية المكتبة
    await page.waitForTimeout(2000);

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
    });

    // 🛡️ فحص حداثة البيانات قبل التحليل: نحمّل الجلسات فقط (بلا رفع) ونتحقق من التاريخ.
    //    proSyncSheets يحمّل جلسات Google Sheet. نستدعيه ونفحص قبل أي تحليل/رفع.
    log('🔍 فحص حداثة بيانات Google Drive...');
    await page.evaluate(() => { try { if (typeof proSyncSheets === 'function') return proSyncSheets(); } catch(e){} });
    await page.waitForTimeout(8000);  // امنح وقتاً لتحميل الجلسات
    const freshness = await page.evaluate(() => {
      try {
        if (!window.db || !db.sessions || !db.sessions.length) return { ok: false, reason: 'لا جلسات' };
        var last = db.sessions[db.sessions.length - 1];
        var lastStr = String(last.date || last.label || '').slice(0, 10);
        var riyadh = new Date(Date.now() + 3 * 3600 * 1000);
        var today = riyadh.toISOString().slice(0, 10);
        var yest = new Date(riyadh.getTime() - 86400000).toISOString().slice(0, 10);
        return { ok: (lastStr === today || lastStr === yest), lastDate: lastStr, today: today, count: db.sessions.length };
      } catch (e) { return { ok: false, reason: e.message }; }
    });
    if (!freshness.ok) {
      log('⛔ بيانات غير حديثة: آخر جلسة ' + (freshness.lastDate || freshness.reason || '؟') + ' · اليوم ' + (freshness.today||'؟'));
      log('   إيقاف دون رفع — تجنّباً لتحليل/رفع بيانات قديمة. تحقّق من تحديث Google Drive.');
      await browser.close();
      process.exit(3);
    }
    log('✅ البيانات حديثة (آخر جلسة: ' + freshness.lastDate + ' · ' + freshness.count + ' جلسة)');

    // ── اضغط "تحميل وتحليل" ──
    log('⚡ ضغط زر تحميل وتحليل...');
    await page.waitForSelector('#loadBtn', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);
    // فعّل الزر وانقره عبر الحدث الأصلي (onclick) — يشغّل proStart في نطاقه الصحيح
    const started = await page.evaluate(() => {
      const b = document.getElementById('loadBtn');
      if (!b) return false;
      b.disabled = false;
      b.style.opacity = '';
      b.style.pointerEvents = 'auto';
      b.click();
      return true;
    });
    if (!started) { log('⚠️ تعذّر بدء التحليل — الزر غير موجود'); }

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
