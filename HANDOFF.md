# ملف التسليم — مدرّب إلقاء الشعر العربي (فرع dev/v2)

## أين المصدر الحقيقي
| الجزء | الموضع |
|---|---|
| التسجيل | `web/audio/reference.mp3` (يُضمَّن في `dist/karaoke_standalone.html`) |
| التحليل/التوقيت | `web/data/reference_analysis.json`، حدود الأشطر `web/js/core/*`، تصحيحات المشرف المحلية `localStorage` عبر محرر التوقيت |
| الرسم | `web/js/ui/pitchview.js` (+ `engine.trail` في `web/js/audio/engine.js`) |
| الكلمات | `web/js/audio/stt.js` (Web Speech)، المقارنة `web/js/core/speech.js` |
| الحسابات والحفظ | `web/js/cloud/client.js`، شاشة «حسابي وتدريباتي» في `web/js/ui/app.js` |
| قاعدة البيانات | `supabase/migrations/*.sql` (RLS مفعّلة) |
| المقاطع الخاصة | bucket خاص `clips` بسياسات في نفس الترحيل (غير موصولة بالواجهة بعد) |

## تشغيل وبناء
```
python3 serve.py                      # تشغيل محلي (localhost يسمح بالميكروفون)
python3 tools/build_standalone.py     # يبني dist/karaoke_standalone.html (افتحه في Chrome بنقر مزدوج)
node --test tests/js/*.test.js        # اختبارات الوحدة
(cd analysis && python3 -m pytest -q)
python3 tests/e2e/run_e2e.py          # E2E (Playwright)
```
المعاينة داخل iframe تمنع الميكروفون؛ للاختبار الصوتي افتح الملف المستقل أو `localhost` مباشرة.

## ربط Supabase (خطواتك)
1. مشروع Supabase ▸ SQL Editor ▸ الصق `supabase/migrations/20261114000001_init.sql` ونفّذه.
2. Authentication ▸ Providers: فعّل Email (وأوقف تأكيد البريد للتجربة إن شئت).
3. Project Settings ▸ API: انسخ `Project URL` و`anon/publishable key` إلى `web/data/cloud-config.json`:
   `{"url":"https://REF.supabase.co","anonKey":"..."}` ثم أعد `tools/build_standalone.py`. (المفتاح العلني آمن بوجود RLS؛ لا تضع service_role هنا.)
4. سجّل الدخول من الموقع مرة، ثم عيّن نفسك مشرفًا من SQL Editor:
   `update public.profiles set role='admin' where id=(select id from auth.users where email='بريدك');`
   (لا يُمنح الدور تلقائيًا ولا من المتصفح؛ تريغر يمنع تغييره من العميل.)
5. أسرار الخادم (`SUPABASE_SERVICE_ROLE_KEY`، مفاتيح أي مزوّد AI) في أسرار البيئة فقط، وانظر `.env.example`.

## ما نُفّذ واختُبر / ما لم يُنفَّذ
- **اختُبر برمجيًا:** مسار الرسم المباشر (`tests/e2e/pitchview_live_check.py`)، تعرّف الكلمات والمقارنة (`speech_flow_check.py`)، عميل الحفظ (idempotent، طابور، تجديد الجلسة) في `tests/js/cloud.test.js`، ومسار الحساب كاملًا **على خادم Supabase وهمي محلي** (`account_flow_check.py`): حفظ محاولة، فشل شبكة بلا تكرار، ظهورها في «تدريباتي» من متصفح جديد، وعزل حساب ثانٍ.
- **لم يُختبر على Supabase حقيقي:** تطبيق الترحيل، سياسات RLS (لم يوجد Postgres هنا)، التسجيل الفعلي. اختبار الصلاحيات (ضيف/متدرّبان/مشرف) ينتظر مشروعك.
- **لم يُنفَّذ بعد:** مكتبة القصائد/قصيدة اليوم (جدول `daily_poems` جاهز فقط)، صفحة المشرف وبلاغات «قيّمني غلط» ورفع المقاطع، درس «إِنْبَاءً»، واجهة مزوّد AI، الشعار، تحسين الأزرار، محرر التوقيت الموسّع، ضبط حدود الأشطر بالسمع.
- **يحتاج جهازًا فعليًا:** الميكروفون الحقيقي، دقة التعرّف، حركة النقطة بصوتك.

## الرجوع
`git checkout baseline-v1` يعيد النسخة العاملة قبل التطوير (وفي `baseline/` نسخة الملف المستقل والتطبيق الأصلي المرفوع).
