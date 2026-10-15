# بک‌اند سایت پرشین

سرور ساده (Node.js، بدون هیچ کتابخونه‌ی اضافه) برای:
- ثبت سفارش، نظر و لایک استوری‌ها از سایت
- ورود ادمین با **نام کاربری و رمز عبور**
- ذخیره‌ی تغییرات پنل (محصولات، عکس‌ها، تنظیمات) روی گیت‌هاب
- بکاپ خودکار سفارش‌ها و نظرها تو یه ریپوی خصوصی گیت‌هاب

## ۱) توکن گیت‌هاب
گیت‌هاب ← Settings ← Developer settings ← Personal access tokens ← **Fine-grained tokens** ← Generate new token:
- Repository access: **Only select repositories** و فقط دو ریپوی `Persian` و `Persian-backup` رو انتخاب کن
- Permissions ← Repository permissions ← **Contents: Read and write**
- Expiration رو یه سال بذار و تاریخش رو یادداشت کن (بعد از انقضا باید توکن جدید بسازی)

توکن رو فقط یک بار می‌بینی؛ همون موقع تو پنل هاست (مرحله ۳) وارد کن. **هیچ‌جا تو چت یا فایل ننویسش.**

## ۲) ریپوی بک‌اند
یه ریپوی **خصوصی** به اسم `persian-backend` بساز و فایل‌های `server.js`، `package.json` و `README.md` رو توش آپلود کن.

## ۳) دیپلوی روی Render
1. render.com ← New ← **Web Service** ← ریپوی `persian-backend` رو وصل کن.
2. Runtime: **Node**. Build Command: `npm install` (یا خالی). Start Command: `node server.js`.
3. بخش **Environment** این متغیرها رو وارد کن (مقدارها رو خودت بنویس):

| نام | مقدار |
|---|---|
| `ADMIN_USERNAME` | نام کاربری دلخواه |
| `ADMIN_PASSWORD` | رمز قوی و بلند |
| `SESSION_SECRET` | یه رشته‌ی تصادفی حداقل ۳۲ حرفی |
| `GITHUB_TOKEN` | توکن مرحله ۱ |
| `CONTENT_REPO` | `persian4634/Persian` |
| `BACKUP_REPO` | `persian4634/Persian-backup` |
| `ALLOWED_ORIGINS` | `https://persian4634.ir,https://www.persian4634.ir` |

اختیاری: `CONTENT_BRANCH` و `BACKUP_BRANCH` (پیش‌فرض `main`)، `BACKUP_PATH` (پیش‌فرض `backup.json`)، `SESSION_HOURS` (پیش‌فرض ۱۲).

بعد از دیپلوی، آدرس سرویس رو تو مرورگر باز کن. باید `{"ok":true,...}` ببینی.

## ۴) دامنه‌ی ثابت
تو Render ← سرویس ← Settings ← **Custom Domains** ← `api.persian4634.ir` رو اضافه کن. Render یه رکورد CNAME بهت می‌ده. همون رو تو پنل DNS دامنه (همونجایی که رکوردهای `persian4634.ir` رو مدیریت می‌کنی) برای نام `api` بساز. بعد از چند دقیقه SSL خودکار فعال می‌شه.

## ۵) وصل کردن سایت
1. فایل `admin.html` جدید رو جایگزین قبلی تو ریپوی `Persian` کن.
2. تو همون ریپو، `data/config.json` رو باز کن و مقدار `apiBase` رو بکن `https://api.persian4634.ir` (بدون `/` آخر).
3. چند دقیقه صبر کن و با نام کاربری و رمز جدید وارد پنل شو.

## نکته‌ها
- **Render رایگان بعد از چند دقیقه بی‌کاری می‌خوابه** و اولین درخواست تا یک دقیقه طول می‌کشه. دیسکش هم موقتیه، برای همین سرور ۳۰ ثانیه بعد از هر تغییر (سفارش، نظر، لایک) خودش بکاپ می‌گیره و اگه خالی بالا بیاد، از گیت‌هاب بازیابی می‌کنه.
- ورود ناموفق: بعد از ۸ بار تلاش اشتباه، ۱۵ دقیقه قفل می‌شه.
- قیمت‌ها از سمت مرورگر مشتری فرستاده می‌شن و سرور فقط جمع و تخفیف رو حساب می‌کنه. سفارش رو قبل از ارسال با قیمت واقعی تو پنل چک کن.
- اگه رمز یا توکن لو رفت: تو Render عوضشون کن و توکن گیت‌هاب رو Revoke کن.
