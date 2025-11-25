import makeWASocket, { DisconnectReason, useMultiFileAuthState, Browsers, delay } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import gplay from 'google-play-scraper';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import pkg from 'pg';
const { Pool } = pkg;
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = pino({ level: 'silent' });

const DEVELOPER_NUMBER = '212718938088@s.whatsapp.net';
const BOT_PROFILE_IMAGE_URL = 'https://i.postimg.cc/TPgStdfc/Screenshot-2025-11-25-08-24-05-916-com-openai-chatgpt-edit.jpg';

let pool = null;
let dbEnabled = false;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
    });
}

const userSessions = new Map();
const activeDownloads = new Map();
const imageCache = new Map();

let pairingCodeRequested = false;
let globalSock = null;
let botImageBuffer = null;

async function initDatabase() {
    if (!process.env.DATABASE_URL) {
        console.log('⚠️  DATABASE_URL غير موجود - البوت يعمل بدون قاعدة بيانات');
        dbEnabled = false;
        return;
    }
    try {
        console.log('🗄️  جاري التحقق من قاعدة البيانات...');
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        dbEnabled = true;
        console.log('✅ قاعدة البيانات متصلة بنجاح!');
    } catch (error) {
        dbEnabled = false;
        console.error('❌ خطأ في الاتصال بقاعدة البيانات:', error.message);
        console.log('⚠️  البوت يعمل بدون قاعدة بيانات');
    }
}

async function downloadBotProfileImage() {
    try {
        if (botImageBuffer) {
            return botImageBuffer;
        }

        const imagePath = path.join(__dirname, 'bot_assets', 'profile.jpg');
        
        if (fs.existsSync(imagePath)) {
            console.log('✅ صورة البوت موجودة بالفعل');
            botImageBuffer = fs.readFileSync(imagePath);
            return botImageBuffer;
        }

        console.log('📥 جاري تحميل صورة البروفايل...');
        const response = await axios.get(BOT_PROFILE_IMAGE_URL, {
            responseType: 'arraybuffer',
            timeout: 15000
        });
        
        botImageBuffer = Buffer.from(response.data);
        fs.writeFileSync(imagePath, botImageBuffer);
        console.log('✅ تم تحميل صورة البروفايل بنجاح');
        return botImageBuffer;
    } catch (error) {
        console.error('❌ خطأ في تحميل صورة البوت:', error.message);
        return null;
    }
}

async function setBotProfile(sock) {
    try {
        const profileImagePath = await downloadBotProfileImage();
        if (profileImagePath && fs.existsSync(profileImagePath)) {
            const imageBuffer = fs.readFileSync(profileImagePath);
            await sock.updateProfilePicture(sock.user.id, imageBuffer);
            console.log('✅ تم تحديث صورة البروفايل');
        }
    } catch (error) {
        console.error('⚠️  خطأ في تحديث صورة البروفايل:', error.message);
    }
}

async function getUserInfo(sock, jid) {
    try {
        const [result] = await sock.onWhatsApp(jid.replace('@s.whatsapp.net', ''));
        if (result && result.exists) {
            return {
                exists: true,
                jid: result.jid
            };
        }
        return { exists: false };
    } catch (error) {
        console.error('خطأ في الحصول على معلومات المستخدم:', error);
        return { exists: false };
    }
}

async function getUserProfile(sock, jid) {
    try {
        let profilePic = null;
        try {
            profilePic = await sock.profilePictureUrl(jid, 'image');
        } catch (e) {
            console.log('لا توجد صورة شخصية للمستخدم');
        }

        const status = await sock.fetchStatus(jid).catch(() => null);
        
        const numberWithoutSuffix = jid.replace('@s.whatsapp.net', '');
        
        return {
            profilePic,
            status: status?.status || 'لا يوجد بايو',
            number: numberWithoutSuffix,
            formattedNumber: '+' + numberWithoutSuffix
        };
    } catch (error) {
        console.error('خطأ في جلب بيانات البروفايل:', error);
        return null;
    }
}

async function checkIfNewUser(phone) {
    if (!dbEnabled) return false;
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE phone_number = $1',
            [phone]
        );
        return result.rows.length === 0;
    } catch (error) {
        console.error('خطأ في التحقق من المستخدم:', error);
        return false;
    }
}

async function notifyDeveloperNewUser(sock, userJid, userName) {
    if (!dbEnabled) return;
    try {
        const phoneNumber = userJid.replace('@s.whatsapp.net', '');
        const isNew = await checkIfNewUser(phoneNumber);
        
        if (isNew) {
            console.log(`🆕 مستخدم جديد: ${userName} (${phoneNumber})`);
            
            await pool.query(
                'INSERT INTO users (phone_number, username, first_seen, last_activity) VALUES ($1, $2, NOW(), NOW()) ON CONFLICT (phone_number) DO NOTHING',
                [phoneNumber, userName]
            );
            
            const profile = await getUserProfile(sock, userJid);
            
            let message = `╔═══════════════════════════════╗\n`;
            message += `║    🆕 مستخدم جديد للبوت 🆕    ║\n`;
            message += `╚═══════════════════════════════╝\n\n`;
            message += `👤 *الاسم:* ${userName || 'غير متوفر'}\n`;
            message += `📱 *الرقم:* +${phoneNumber}\n`;
            
            if (profile) {
                message += `📝 *البايو:* ${profile.status || 'لا يوجد'}\n`;
            }
            
            message += `⏰ *التاريخ:* ${new Date().toLocaleString('ar-EG', { 
                dateStyle: 'full', 
                timeStyle: 'short' 
            })}\n`;
            message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            message += `🤖 *بوت AppOmar الاحترافي*`;

            if (profile && profile.profilePic) {
                try {
                    const response = await axios.get(profile.profilePic, {
                        responseType: 'arraybuffer',
                        timeout: 10000
                    });
                    await sock.sendMessage(DEVELOPER_NUMBER, {
                        image: Buffer.from(response.data),
                        caption: message,
                        contextInfo: {
                            forwardingScore: 999,
                            isForwarded: true
                        }
                    });
                    console.log('✅ تم إرسال إشعار للمطور مع الصورة');
                } catch (imgError) {
                    console.error('⚠️  خطأ في تحميل صورة المستخدم:', imgError.message);
                    await sock.sendMessage(DEVELOPER_NUMBER, { 
                        text: message,
                        contextInfo: {
                            forwardingScore: 999,
                            isForwarded: true
                        }
                    });
                    console.log('✅ تم إرسال إشعار للمطور بدون صورة');
                }
            } else {
                await sock.sendMessage(DEVELOPER_NUMBER, { 
                    text: message,
                    contextInfo: {
                        forwardingScore: 999,
                        isForwarded: true
                    }
                });
                console.log('✅ تم إرسال إشعار للمطور');
            }
        }
    } catch (error) {
        console.error('❌ خطأ في إرسال إشعار للمطور:', error.message);
        console.error('تفاصيل:', error.stack);
    }
}

async function checkBlacklist(phone) {
    if (!dbEnabled) return false;
    try {
        const result = await pool.query(
            'SELECT * FROM blacklist WHERE phone_number = $1',
            [phone]
        );
        return result.rows.length > 0;
    } catch (error) {
        console.error('خطأ في التحقق من القائمة السوداء:', error);
        return false;
    }
}

async function updateUserActivity(phone, userName) {
    if (!dbEnabled) return;
    try {
        await pool.query(
            'INSERT INTO users (phone_number, username, last_activity) VALUES ($1, $2, NOW()) ON CONFLICT (phone_number) DO UPDATE SET last_activity = NOW(), username = $2',
            [phone, userName]
        );
    } catch (error) {
        console.error('خطأ في تحديث نشاط المستخدم:', error);
    }
}

async function incrementSpamScore(phone) {
    if (!dbEnabled) return false;
    try {
        const result = await pool.query(
            'UPDATE users SET spam_score = spam_score + 1 WHERE phone_number = $1 RETURNING spam_score',
            [phone]
        );
        
        if (result.rows[0] && result.rows[0].spam_score >= 5) {
            await pool.query(
                'INSERT INTO blacklist (phone_number, reason) VALUES ($1, $2) ON CONFLICT (phone_number) DO NOTHING',
                [phone, 'تم الحظر تلقائياً بسبب الإزعاج المتكرر']
            );
            return true;
        }
        return false;
    } catch (error) {
        console.error('خطأ في زيادة درجة الإزعاج:', error);
        return false;
    }
}

async function logDownload(userPhone, appId, appName, fileType, fileSize) {
    if (!dbEnabled) return;
    try {
        await pool.query(
            'INSERT INTO downloads (user_phone, app_id, app_name, file_type, file_size) VALUES ($1, $2, $3, $4, $5)',
            [userPhone, appId, appName, fileType, fileSize]
        );
        
        await pool.query(
            'UPDATE users SET total_downloads = total_downloads + 1 WHERE phone_number = $1',
            [userPhone]
        );
    } catch (error) {
        console.error('خطأ في تسجيل التحميل:', error);
    }
}

function extractXAPK(xapkBuffer, appTitle) {
    return new Promise((resolve, reject) => {
        try {
            const zip = new AdmZip(xapkBuffer);
            const zipEntries = zip.getEntries();
            
            const result = {
                apk: null,
                obb: []
            };
            
            for (const entry of zipEntries) {
                const entryName = entry.entryName;
                
                if (entryName.endsWith('.apk') && !entryName.includes('/')) {
                    if (!result.apk) {
                        result.apk = {
                            buffer: entry.getData(),
                            filename: `${appTitle.replace(/[^a-zA-Z0-9]/g, '_')}.apk`
                        };
                    }
                } else if (entryName.toLowerCase().includes('.obb')) {
                    result.obb.push({
                        buffer: entry.getData(),
                        filename: path.basename(entryName)
                    });
                }
            }
            
            resolve(result);
        } catch (error) {
            reject(error);
        }
    });
}

async function downloadAPKStream(packageName, appTitle) {
    try {
        const API_URL = process.env.API_URL || 'http://localhost:8000';
        const downloadUrl = `${API_URL}/download/${packageName}`;
        
        console.log(`📥 جاري التحميل من API: ${downloadUrl}`);
        
        const response = await axios.get(downloadUrl, {
            responseType: 'arraybuffer',
            timeout: 60000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            maxRedirects: 5
        });
        
        if (response.status === 200 && response.data) {
            const contentDisposition = response.headers['content-disposition'];
            let filename = `${packageName}.apk`;
            
            if (contentDisposition) {
                const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
                if (filenameMatch) {
                    filename = filenameMatch[1].replace(/['"]/g, '');
                }
            }
            
            const buffer = Buffer.from(response.data);
            const size = buffer.length;
            
            console.log(`✅ تم التحميل بنجاح: ${filename} (${(size / (1024 * 1024)).toFixed(2)} MB)`);
            
            return { buffer, filename, size };
        } else {
            console.error('❌ فشل التحميل من API');
            return null;
        }
    } catch (error) {
        console.error('❌ خطأ في تحميل APK:', error.message);
        
        console.log('📥 محاولة التحميل باستخدام Python Script...');
        return await downloadAPKStreamFallback(packageName, appTitle);
    }
}

async function downloadAPKStreamFallback(packageName, appTitle) {
    return new Promise((resolve) => {
        const pythonScript = path.join(__dirname, 'scrap.py');
        const pythonProcess = spawn('python3', [pythonScript, packageName]);
        
        let output = '';
        let error = '';

        pythonProcess.stdout.on('data', (data) => {
            output += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
            error += data.toString();
        });

        pythonProcess.on('close', (code) => {
            if (code === 0 && output.trim()) {
                const filePath = output.trim();
                if (fs.existsSync(filePath)) {
                    const buffer = fs.readFileSync(filePath);
                    const filename = path.basename(filePath);
                    const fileSize = fs.statSync(filePath).size;
                    
                    fs.unlinkSync(filePath);
                    
                    resolve({ buffer, filename, size: fileSize });
                } else {
                    resolve(null);
                }
            } else {
                console.error('❌ خطأ في سكربت Python:', error);
                resolve(null);
            }
        });

        pythonProcess.on('error', (err) => {
            console.error('❌ خطأ في تشغيل Python:', err);
            resolve(null);
        });
    });
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('session');

    const sock = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: false,
        getMessage: async (key) => {
            return { conversation: '' };
        }
    });

    globalSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;

            console.log('❌ الاتصال مغلق');

            if (shouldReconnect) {
                pairingCodeRequested = false;
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log('✅ متصل بواتساب بنجاح!');
            console.log('🤖 بوت AppOmar جاهز للاستخدام');
            pairingCodeRequested = false;
            
            await setBotProfile(sock);
        } else if (connection === 'connecting') {
            console.log('🔗 جاري الاتصال بواتساب...');
            
            if (!sock.authState.creds.registered && !pairingCodeRequested) {
                pairingCodeRequested = true;
                
                const phoneNumber = process.env.PHONE_NUMBER;
                
                if (!phoneNumber) {
                    console.error('\n❌ خطأ: متغير البيئة PHONE_NUMBER غير موجود!');
                    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                    console.log('📌 يرجى إضافة رقم هاتفك في متغيرات البيئة');
                    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
                    process.exit(1);
                }

                setTimeout(async () => {
                    try {
                        const code = await sock.requestPairingCode(phoneNumber);
                        console.log('\n📱 رمز الاقتران الخاص بك:');
                        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                        console.log(`        ${code}        `);
                        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
                    } catch (error) {
                        console.error('❌ خطأ في طلب رمز الاقتران:', error.message);
                        pairingCodeRequested = false;
                    }
                }, 3000);
            }
        }
    });

    sock.ev.on('call', async (callData) => {
        for (const call of callData) {
            if (call.status === 'offer') {
                console.log(`📞 مكالمة واردة من: ${call.from}`);
                
                try {
                    await sock.rejectCall(call.id, call.from);
                    
                    await sock.sendMessage(call.from, {
                        text: '⚠️ *المكالمات غير مسموحة*\n\n📝 هذا بوت تلقائي لتحميل التطبيقات.\n\n💬 يرجى التواصل عبر الرسائل النصية فقط.',
                        contextInfo: {
                            forwardingScore: 999,
                            isForwarded: true
                        }
                    });
                    
                    console.log('✅ تم رفض المكالمة وإرسال رسالة تنبيه');
                } catch (error) {
                    console.error('❌ خطأ في رفض المكالمة:', error.message);
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        
        if (!msg.message || msg.key.fromMe) return;

        const messageType = Object.keys(msg.message)[0];
        if (messageType !== 'conversation' && messageType !== 'extendedTextMessage') return;

        const from = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

        if (!text) return;

        const userName = msg.pushName || 'مستخدم';

        const isBlacklisted = await checkBlacklist(from);
        if (isBlacklisted) {
            await sock.sendMessage(from, { 
                text: '⛔ عذراً، تم حظرك من استخدام هذا البوت بسبب مخالفة سياسة الاستخدام.' 
            });
            return;
        }

        await updateUserActivity(from, userName);
        await notifyDeveloperNewUser(sock, from, userName);

        try {
            await handleMessage(sock, from, text, msg, userName);
        } catch (error) {
            console.error('❌ خطأ في معالجة الرسالة:', error);
            await sock.sendMessage(from, { 
                text: '❌ عذراً، حدث خطأ. يرجى المحاولة مرة أخرى.' 
            });
        }
    });

    return sock;
}

async function handleMessage(sock, from, text, msg, userName) {
    let session = userSessions.get(from);
    if (!session) {
        session = { state: 'idle', searchResults: [], requestCount: 0, lastRequest: Date.now(), isDownloading: false };
        userSessions.set(from, session);
    }

    const now = Date.now();
    if (now - session.lastRequest < 2000) {
        session.requestCount++;
        if (session.requestCount > 10) {
            const banned = await incrementSpamScore(from);
            if (banned) {
                await sock.sendMessage(from, { 
                    text: '⛔ تم حظرك تلقائياً بسبب الإزعاج المتكرر. للاستفسار، تواصل مع المطور.' 
                });
                return;
            }
            await sock.sendMessage(from, { 
                text: '⚠️ من فضلك، تمهل قليلاً! لا ترسل طلبات متتالية بهذه السرعة.' 
            });
            return;
        }
    } else {
        session.requestCount = 0;
    }
    session.lastRequest = now;

    if (session.state === 'idle' || text.toLowerCase() === 'بدء' || text.toLowerCase() === 'start') {
        const welcomeMsg = `╔═══════════════════════╗
║   مرحباً ${userName} 👋   
╚═══════════════════════╝

🤖 *بوت AppOmar الاحترافي*
━━━━━━━━━━━━━━━━━━━━━

✨ *المميزات:*
⚡ بحث فائق السرعة
📦 تحميل مباشر من Google Play
🎮 دعم XAPK + OBB
🔒 آمن ومجاني 100%

━━━━━━━━━━━━━━━━━━━━━
📖 *طريقة الاستخدام:*

1️⃣ أرسل اسم التطبيق
2️⃣ اختر من القائمة (1-10)
3️⃣ استلم الملف فوراً

💡 *نصيحة:* أرسل 0 لتخطي القائمة

━━━━━━━━━━━━━━━━━━━━━
📸 https://www.instagram.com/omarxarafp
━━━━━━━━━━━━━━━━━━━━━

📝 ابدأ الآن بإرسال اسم التطبيق...`;

        const imageBuffer = await downloadBotProfileImage();
        
        if (imageBuffer) {
            await sock.sendMessage(from, {
                image: imageBuffer,
                caption: welcomeMsg,
                contextInfo: {
                    forwardingScore: 999,
                    isForwarded: true,
                    externalAdReply: {
                        title: '🤖 بوت AppOmar',
                        body: 'أفضل بوت لتحميل التطبيقات',
                        mediaType: 1,
                        sourceUrl: 'https://www.nstagram.com/omarxarafp'
                    }
                }
            });
        } else {
            await sock.sendMessage(from, { 
                text: welcomeMsg,
                contextInfo: {
                    forwardingScore: 999,
                    isForwarded: true
                }
            });
        }
        
        session.state = 'waiting_for_search';
    } else if (session.state === 'waiting_for_search') {
        await sock.sendMessage(from, { 
            react: { text: '🔍', key: msg.key }
        });
        
        try {
            // محاولة البحث باسم الحزمة مباشرة إذا كان النص يبدو كاسم حزمة
            const isPackageName = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(text.trim());
            
            let results;
            if (isPackageName) {
                try {
                    const appDetails = await gplay.app({ appId: text.trim() });
                    results = [appDetails];
                } catch {
                    results = await gplay.search({ term: text, num: 10 });
                }
            } else {
                results = await gplay.search({ term: text, num: 10 });
            }
            
            if (results.length === 0) {
                await sock.sendMessage(from, { 
                    text: '❌ لم أجد نتائج. جرب كلمة أخرى.',
                    contextInfo: {
                        forwardingScore: 999,
                        isForwarded: true
                    }
                });
                return;
            }

            const cleanResults = results.map((app, idx) => ({
                title: app.title,
                appId: app.appId || app.id || app.packageName,
                developer: app.developer || '',
                score: app.score || 0,
                icon: app.icon || null,
                url: app.url || '',
                index: idx + 1
            }));

            session.searchResults = [...cleanResults];
            session.state = 'waiting_for_selection';
            userSessions.set(from, session);
            
            console.log(`📋 تم حفظ ${cleanResults.length} نتيجة للمستخدم ${from}`);

            const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
            
            let resultText = '🔍 *نتائج البحث*\n\n';
            
            cleanResults.forEach((app, index) => {
                const emoji = index < 10 ? numberEmojis[index] : `${index + 1}.`;
                const rating = app.score ? `⭐${app.score.toFixed(1)}` : '';
                resultText += `${emoji} *${app.title}*\n`;
                if (app.developer) resultText += `   👨‍💻 ${app.developer} ${rating}\n`;
            });
            
            resultText += '\n📝 أرسل رقم التطبيق (1-' + cleanResults.length + ')\n';
            resultText += '💡 أو أرسل 0 للبحث من جديد';
            
            const imageBuffer = await downloadBotProfileImage();
            
            if (imageBuffer) {
                await sock.sendMessage(from, {
                    image: imageBuffer,
                    caption: resultText,
                    contextInfo: {
                        forwardingScore: 999,
                        isForwarded: true
                    }
                });
            } else {
                await sock.sendMessage(from, { 
                    text: resultText,
                    contextInfo: {
                        forwardingScore: 999,
                        isForwarded: true
                    }
                });
            }
        } catch (error) {
            console.error('❌ خطأ في البحث:', error);
            await sock.sendMessage(from, { 
                text: '❌ حدث خطأ أثناء البحث. حاول مرة أخرى.' 
            });
        }
    } else if (session.state === 'waiting_for_selection') {
        const selection = parseInt(text.trim());
        
        if (session.isDownloading) {
            await sock.sendMessage(from, { 
                text: '⏳ انتظر من فضلك، طلبك قيد التنفيذ...' 
            });
            return;
        }
        
        if (selection === 0) {
            await sock.sendMessage(from, { 
                text: '🔍 حسناً، أرسل اسم التطبيق:',
                contextInfo: {
                    forwardingScore: 999,
                    isForwarded: true
                }
            });
            session.state = 'waiting_for_search';
            session.searchResults = [];
            userSessions.set(from, session);
            return;
        }
        
        const resultsCount = session.searchResults?.length || 0;
        console.log(`📊 المستخدم ${from} اختار الرقم ${selection} من أصل ${resultsCount} نتيجة`);
        
        if (isNaN(selection) || selection < 1 || selection > resultsCount) {
            if (resultsCount === 0) {
                await sock.sendMessage(from, { 
                    text: '❌ لم يتم العثور على نتائج بحث. أرسل اسم التطبيق للبحث:',
                    contextInfo: {
                        forwardingScore: 999,
                        isForwarded: true
                    }
                });
                session.state = 'waiting_for_search';
                userSessions.set(from, session);
            } else {
                await sock.sendMessage(from, { 
                    text: `❌ أرسل رقماً صحيحاً من 1 إلى ${resultsCount}\n💡 أو أرسل 0 للبحث من جديد`,
                    contextInfo: {
                        forwardingScore: 999,
                        isForwarded: true
                    }
                });
            }
            return;
        }
        
        session.isDownloading = true;
        userSessions.set(from, session);

        const selectedApp = session.searchResults[selection - 1];
        console.log(`✅ تم اختيار التطبيق: ${selectedApp.title} (${selectedApp.appId})`);
        
        let appId = selectedApp.appId;

        if (!appId && selectedApp.url) {
            const urlMatch = selectedApp.url.match(/id=([^&]+)/);
            if (urlMatch) appId = urlMatch[1];
        }

        if (!appId) {
            await sock.sendMessage(from, { 
                text: `❌ لم أتمكن من الحصول على معرف التطبيق. اختر تطبيقاً آخر.` 
            });
            session.isDownloading = false;
            userSessions.set(from, session);
            return;
        }
        
        await sock.sendMessage(from, { 
            react: { text: '⏳', key: msg.key }
        });

        try {
            const appDetails = await gplay.app({ appId: appId });
            
            let detailsText = `📱 *${appDetails.title}*\n\n`;
            detailsText += `📦 *الحزمة:* ${appDetails.appId}\n`;
            detailsText += `⭐ *التقييم:* ${appDetails.score ? appDetails.score.toFixed(1) : 'N/A'}/5\n`;
            detailsText += `📥 *التحميلات:* ${appDetails.installs || 'N/A'}\n`;
            detailsText += `📏 *الحجم:* ${appDetails.size || 'N/A'}\n`;
            detailsText += `🔄 *الإصدار:* ${appDetails.version || 'N/A'}\n`;
            detailsText += `👨‍💻 *المطور:* ${appDetails.developer || 'N/A'}\n\n`;
            detailsText += `📝 ${appDetails.description ? appDetails.description.substring(0, 200) + '...' : 'N/A'}`;

            if (appDetails.icon) {
                try {
                    const response = await axios.get(appDetails.icon, {
                        responseType: 'arraybuffer'
                    });
                    await sock.sendMessage(from, {
                        image: Buffer.from(response.data),
                        caption: detailsText,
                        contextInfo: {
                            forwardingScore: 999,
                            isForwarded: true
                        }
                    });
                } catch {
                    await sock.sendMessage(from, { text: detailsText });
                }
            } else {
                await sock.sendMessage(from, { text: detailsText });
            }

            await sock.sendMessage(from, { 
                react: { text: '📥', key: msg.key }
            });

            const apkStream = await downloadAPKStream(appDetails.appId, appDetails.title);
            
            if (apkStream) {
                await sock.sendMessage(from, { 
                    react: { text: '✅', key: msg.key }
                });

                await logDownload(from, appDetails.appId, appDetails.title, apkStream.filename.endsWith('.xapk') ? 'xapk' : 'apk', apkStream.size);

                if (apkStream.filename.endsWith('.xapk')) {
                    try {
                        const extractedFiles = await extractXAPK(apkStream.buffer, appDetails.title);
                        
                        if (extractedFiles.obb && extractedFiles.obb.length > 0) {
                            if (extractedFiles.apk) {
                                await sock.sendMessage(from, {
                                    document: extractedFiles.apk.buffer,
                                    mimetype: 'application/vnd.android.package-archive',
                                    fileName: extractedFiles.apk.filename
                                });
                            }
                            
                            for (const obbFile of extractedFiles.obb) {
                                await sock.sendMessage(from, {
                                    document: obbFile.buffer,
                                    mimetype: 'application/octet-stream',
                                    fileName: obbFile.filename
                                });
                            }
                            
                            let instructions = '✅ *تم الإرسال بنجاح!*\n\n';
                            instructions += '📋 *طريقة التثبيت:*\n';
                            instructions += '1️⃣ ثبت ملف APK أولاً\n';
                            instructions += '2️⃣ انسخ ملف OBB إلى:\n';
                            instructions += `   📁 Android/obb/${appDetails.appId}/\n\n`;
                            instructions += ' تابعني على انستجرام:\n';
                            instructions += 'https://www.instagram.com/omarxarafp\n\n';
                            instructions += '🙏 شكراً لاستخدامك بوت AppOmar';
                            
                            await sock.sendMessage(from, { text: instructions });
                        } else {
                            await sock.sendMessage(from, {
                                document: apkStream.buffer,
                                mimetype: 'application/octet-stream',
                                fileName: apkStream.filename
                            });
                            
                            let instructions = '✅ *تم الإرسال بنجاح!*\n\n';
                            instructions += '📋 *طريقة التثبيت:*\n';
                            instructions += '• استخدم تطبيق XAPK Installer\n';
                            instructions += '• أو فك الضغط يدوياً\n\n';
                            instructions += ' تابعني على انستجرام:\n';
                            instructions += 'https://www.instagram.com/omarxarafp\n\n';
                            instructions += '🙏 شكراً لاستخدامك بوت AppOmar';
                            
                            await sock.sendMessage(from, { text: instructions });
                        }
                    } catch (extractError) {
                        console.error('❌ خطأ في استخراج XAPK:', extractError);
                        await sock.sendMessage(from, {
                            document: apkStream.buffer,
                            mimetype: 'application/octet-stream',
                            fileName: apkStream.filename
                        });
                        
                        let successMsg = '✅ *تم الإرسال بنجاح!*\n\n';
                        successMsg += 'تابعني على انستجرام:\n';
                        successMsg += 'https://www.instagram.com/omarxarafp\n\n';
                        successMsg += '🙏 شكراً لاستخدامك بوت AppOmar';
                        
                        await sock.sendMessage(from, { text: successMsg });
                    }
                } else {
                    await sock.sendMessage(from, {
                        document: apkStream.buffer,
                        mimetype: 'application/vnd.android.package-archive',
                        fileName: apkStream.filename
                    });
                    
                    let successMsg = '✅ *تم الإرسال بنجاح!*\n\n';
                    successMsg += 'تابعني على انستجرام:\n';
                    successMsg += 'https://www.instagram.com/omarxarafp\n\n';
                    successMsg += '🙏 شكراً لاستخدامك بوت AppOmar';
                    
                    await sock.sendMessage(from, { text: successMsg });
                }
                
                session.state = 'waiting_for_search';
                session.isDownloading = false;
                session.searchResults = [];
                userSessions.set(from, session);
                console.log(`✅ تم إنهاء التحميل للمستخدم ${from}`);
            } else {
                await sock.sendMessage(from, { 
                    text: '❌ لم أتمكن من تحميل التطبيق.\n\n💡 جرب تطبيقاً آخر.' 
                });
                session.state = 'waiting_for_search';
                session.isDownloading = false;
                userSessions.set(from, session);
            }
        } catch (error) {
            console.error('❌ خطأ:', error);
            await sock.sendMessage(from, { 
                text: '❌ حدث خطأ. حاول مرة أخرى.' 
            });
            session.state = 'waiting_for_search';
            session.isDownloading = false;
            userSessions.set(from, session);
        }
    }
}

console.log('╔══════════════════════════════════════╗');
console.log('║     🤖 بوت AppOmar الاحترافي 🤖     ║');
console.log('╚══════════════════════════════════════╝\n');
console.log('🚀 جاري بدء البوت...\n');

await initDatabase();
await downloadBotProfileImage();

connectToWhatsApp().catch(err => {
    console.error('❌ خطأ فادح:', err);
    process.exit(1);
});
