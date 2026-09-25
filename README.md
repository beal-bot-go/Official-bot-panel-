# Bot Panel (Host) — official-messenger-bot চালানোর জন্য

এটা একটা স্বতন্ত্র প্যানেল — নিজে কোনো বট না, শুধু আপনার `official-messenger-bot.zip` আপলোড নিয়ে সেটাকে সাবপ্রসেস হিসেবে চালায় ও কন্ট্রোল করে (ঠিক আপনার আগের Belal-bot-panel-এর মতোই, শুধু এবার এটা official Graph API বটের জন্য)।

## GitHub-এ রাখা

1. এই ফোল্ডারটা (`panel-host/`) একটা নতুন GitHub রিপোতে পুশ করুন — এটা আপনার `official-messenger-bot` প্রজেক্ট থেকে **সম্পূর্ণ আলাদা রিপো**
2. `.env` কখনো পুশ করবেন না (`.gitignore`-এ আগে থেকেই বাদ দেওয়া আছে)

## Render-এ ডিপ্লয়

1. Render → **New → Web Service** → এই রিপো কানেক্ট করুন
2. Build command: `npm install`
3. Start command: `node server.js`
4. Environment Variables:
   - `PANEL_PASSWORD` = নিজের শক্ত পাসওয়ার্ড
   - `PORT` = `10000` (Render নিজে থেকেও একটা PORT দেয়, দুটোই কাজ করবে)
5. ডিপ্লয় হওয়ার পর পাওয়া URL-এ যান (যেমন `https://your-panel.onrender.com`)

## ব্যবহার

1. PANEL_PASSWORD দিয়ে লগইন করুন
2. **🚀 ডিপ্লয়** ট্যাবে গিয়ে `official-messenger-bot.zip` (পুরো জিপ, ভেতরের `official-bot` ফোল্ডারসহ) আপলোড করুন
3. **📦 Install + Start** চাপুন — প্যানেল নিজে থেকে `npm install` চালিয়ে বট চালু করবে
4. **📁 ফাইল** ট্যাব থেকে `commands/`, `utils/` ও `.env` এডিট করতে পারবেন
5. **📜 লগ** ট্যাবে লাইভ আউটপুট দেখা যাবে
6. `.env` ফাইলে বটের আসল key (PAGE_ACCESS_TOKEN, RAPIDAPI_KEY ইত্যাদি) বসিয়ে **🔄 Restart** চাপুন

## UptimeRobot দিয়ে ঘুম থেকে জাগিয়ে রাখা

Render free tier ১৫ মিনিট নিষ্ক্রিয় থাকলে ঘুমিয়ে পড়ে। এটা আটকাতে:

1. uptimerobot.com-এ ফ্রি অ্যাকাউন্ট বানান
2. **Add New Monitor → HTTP(s)**
3. URL: `https://your-panel.onrender.com/ping`
4. Interval: ৫ মিনিট
5. Save — এখন প্রতি ৫ মিনিটে পিং হবে, Render জেগে থাকবে

## সতর্কতা

- `PANEL_PASSWORD` কারো সাথে শেয়ার করবেন না — এটা দিয়ে যে কেউ আপনার বট কোড দেখতে/বদলাতে/বন্ধ করতে পারবে
- `bot/` ফোল্ডার (আপলোড হওয়া প্রজেক্ট) Render-এর ডিস্কে থাকে — Render free tier-এ **persistent disk না থাকলে** re-deploy হলে এটা মুছে যেতে পারে, তখন আবার জিপ আপলোড করতে হবে
