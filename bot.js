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
const GROUP_LINK = 'https://chat.whatsapp.com/Io2YijPSBLbAOyhFkDniyQ';

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
const blockedPrivateUsers = new Set();

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

async function blockPrivateUser(sock, jid) {
    try {
        if (!jid.endsWith('@s.whatsapp.net')) {
            console.log(`⚠️ تجاهل الحظر - ليس مستخدم خاص: ${jid}`);
            return;
        }
        
        if (blockedPrivateUsers.has(jid)) {
            return;
        }
        
        const privateBlockMsg = `⛔ *هذا البوت يعمل في المجموعات فقط!*

━━━━━━━━━━━━━━━━━━━━━
📢 انضم للمجموعة الرسمية لاستخدام البوت:

🔗 ${GROUP_LINK}

━━━━━━━━━━━━━━━━━━━━━
⚠️ *تم حظرك تلقائياً*
للتواصل مع المطور، انضم للمجموعة أعلاه.`;

        await sock.sendMessage(jid, { 
            text: privateBlockMsg,
            contextInfo: {
                forwardingScore: 999,
                isForwarded: true
            }
        });
        
        await sock.updateBlockStatus(jid, 'block');
        blockedPrivateUsers.add(jid);
        
        console.log(`🚫 تم حظر المستخدم الخاص: ${jid}`);
        
        if (dbEnabled) {
            try {
                const phone = jid.replace('@s.whatsapp.net', '');
                await pool.query(
                    'INSERT INTO blacklist (phone_number, reason) VALUES ($1, $2) ON CONFLICT (phone_number) DO NOTHING',
                    [phone, 'تم الحظر تلقائياً - محاولة استخدام البوت في الخاص']
                );
            } catch (dbError) {
                console.error('❌ خطأ في تسجيل الحظر:', dbError.message);
            }
        }
    } catch (error) {
        console.error('❌ خطأ في حظر المستخدم:', error.message);
    }
}

function isGroupMessage(jid) {
    return jid.endsWith('@g.us');
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
            timeout: 120000,
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
            console.log('🤖 بوت AppOmar جاهز للاستخدام في المجموعات');
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
                    console.log('✅ تم رفض المكالمة');
                } catch (error) {
                    console.error('❌ خطأ في رفض المكالمة:', error.message);
                }
            }
        }
    });

    sock.ev.on('group-participants.update', async (event) => {
        try {
            const { id, participants, action } = event;
            const joinTime = new Date().toLocaleString('ar-EG', { 
                dateStyle: 'full', 
                timeStyle: 'short',
                timeZone: 'Africa/Cairo'
            });
            
            if (action === 'add') {
                console.log(`👋 أعضاء جدد انضموا للمجموعة: ${participants.length}`);
                
                for (const participant of participants) {
                    try {
                        const phoneNumber = participant.split('@')[0];
                        let profilePic = null;
                        let userName = phoneNumber;
                        
                        try {
                            profilePic = await sock.profilePictureUrl(participant, 'image');
                        } catch (e) {
                            console.log('لا توجد صورة شخصية للمستخدم');
                        }
                        
                        const welcomeMessage = `╔═══════════════════════════════╗
║     👋 أهلاً وسهلاً بك!      ║
╚═══════════════════════════════╝

🎉 *عضو جديد انضم للمجموعة!*

━━━━━━━━━━━━━━━━━━━━━
👤 *الاسم:* @${phoneNumber}
📱 *الرقم:* +${phoneNumber}
⏰ *وقت الانضمام:* ${joinTime}
━━━━━━━━━━━━━━━━━━━━━

🤖 *بوت AppOmar لتحميل التطبيقات*

📖 *طريقة الاستخدام:*
📝 أرسل اسم أي تطبيق
⚡ سيتم إرساله تلقائياً!

💡 أرسل *بدء* لمزيد من المعلومات
━━━━━━━━━━━━━━━━━━━━━`;

                        if (profilePic) {
                            try {
                                const response = await axios.get(profilePic, {
                                    responseType: 'arraybuffer',
                                    timeout: 10000
                                });
                                await sock.sendMessage(id, {
                                    image: Buffer.from(response.data),
                                    caption: welcomeMessage,
                                    mentions: [participant],
                                    contextInfo: { forwardingScore: 999, isForwarded: true }
                                });
                            } catch (imgError) {
                                const botImage = await downloadBotProfileImage();
                                if (botImage) {
                                    await sock.sendMessage(id, {
                                        image: botImage,
                                        caption: welcomeMessage,
                                        mentions: [participant],
                                        contextInfo: { forwardingScore: 999, isForwarded: true }
                                    });
                                } else {
                                    await sock.sendMessage(id, {
                                        text: welcomeMessage,
                                        mentions: [participant],
                                        contextInfo: { forwardingScore: 999, isForwarded: true }
                                    });
                                }
                            }
                        } else {
                            const botImage = await downloadBotProfileImage();
                            if (botImage) {
                                await sock.sendMessage(id, {
                                    image: botImage,
                                    caption: welcomeMessage,
                                    mentions: [participant],
                                    contextInfo: { forwardingScore: 999, isForwarded: true }
                                });
                            } else {
                                await sock.sendMessage(id, {
                                    text: welcomeMessage,
                                    mentions: [participant],
                                    contextInfo: { forwardingScore: 999, isForwarded: true }
                                });
                            }
                        }
                    } catch (userError) {
                        console.error('❌ خطأ في إرسال ترحيب للمستخدم:', userError.message);
                    }
                }
            }
            
            if (action === 'remove') {
                console.log(`👋 أعضاء غادروا المجموعة: ${participants.length}`);
                
                for (const participant of participants) {
                    try {
                        const phoneNumber = participant.split('@')[0];
                        let profilePic = null;
                        
                        try {
                            profilePic = await sock.profilePictureUrl(participant, 'image');
                        } catch (e) {
                            console.log('لا توجد صورة شخصية للمستخدم المغادر');
                        }
                        
                        const goodbyeMessage = `╔═══════════════════════════════╗
║      👋 مع السلامة!          ║
╚═══════════════════════════════╝

😢 *عضو غادر المجموعة*

━━━━━━━━━━━━━━━━━━━━━
👤 *الاسم:* ${phoneNumber}
📱 *الرقم:* +${phoneNumber}
⏰ *وقت المغادرة:* ${joinTime}
━━━━━━━━━━━━━━━━━━━━━

🙏 نتمنى لك التوفيق!
━━━━━━━━━━━━━━━━━━━━━
🤖 بوت AppOmar`;

                        if (profilePic) {
                            try {
                                const response = await axios.get(profilePic, {
                                    responseType: 'arraybuffer',
                                    timeout: 10000
                                });
                                await sock.sendMessage(id, {
                                    image: Buffer.from(response.data),
                                    caption: goodbyeMessage,
                                    contextInfo: { forwardingScore: 999, isForwarded: true }
                                });
                            } catch (imgError) {
                                await sock.sendMessage(id, {
                                    text: goodbyeMessage,
                                    contextInfo: { forwardingScore: 999, isForwarded: true }
                                });
                            }
                        } else {
                            await sock.sendMessage(id, {
                                text: goodbyeMessage,
                                contextInfo: { forwardingScore: 999, isForwarded: true }
                            });
                        }
                    } catch (userError) {
                        console.error('❌ خطأ في إرسال وداع للمستخدم:', userError.message);
                    }
                }
            }
        } catch (error) {
            console.error('❌ خطأ في معالجة تحديث المجموعة:', error.message);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const messageType = Object.keys(msg.message)[0];
            if (messageType !== 'conversation' && messageType !== 'extendedTextMessage') continue;

            const from = msg.key.remoteJid;
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

            if (!text) continue;

            const userName = msg.pushName || 'مستخدم';
            const senderJid = msg.key.participant || from;

            if (!isGroupMessage(from)) {
                console.log(`🚫 رسالة خاصة من: ${from} - سيتم حظره`);
                blockPrivateUser(sock, from).catch(console.error);
                continue;
            }

            console.log(`📩 رسالة من المجموعة: ${from} | المرسل: ${senderJid}`);

            const senderPhone = senderJid.replace('@s.whatsapp.net', '');
            updateUserActivity(senderPhone, userName).catch(console.error);

            handleGroupMessage(sock, from, senderJid, text, msg, userName).catch(error => {
                console.error('❌ خطأ في معالجة الرسالة:', error);
                sock.sendMessage(from, { 
                    text: '❌ عذراً، حدث خطأ. يرجى المحاولة مرة أخرى.' 
                }).catch(console.error);
            });
        }
    });

    return sock;
}

async function handleGroupMessage(sock, groupJid, senderJid, text, msg, userName) {
    const sessionKey = `${groupJid}_${senderJid}`;
    let session = userSessions.get(sessionKey);
    
    if (!session) {
        session = { isDownloading: false, lastRequest: 0, requestCount: 0, currentApp: null };
        userSessions.set(sessionKey, session);
    }

    const now = Date.now();
    
    if (now - session.lastRequest < 1000) {
        session.requestCount++;
        if (session.requestCount > 8) {
            sock.sendMessage(groupJid, { 
                text: '⚠️ تمهل قليلاً!',
                contextInfo: { forwardingScore: 999, isForwarded: true }
            }).catch(console.error);
            return;
        }
    } else {
        session.requestCount = 0;
    }
    session.lastRequest = now;

    if (session.isDownloading) {
        sock.sendMessage(groupJid, { 
            text: `⏳ طلبك "${session.currentApp || 'التطبيق'}" قيد التنفيذ...`,
            contextInfo: { forwardingScore: 999, isForwarded: true }
        }).catch(console.error);
        return;
    }

    if (text.toLowerCase() === 'بدء' || text.toLowerCase() === 'start' || text.toLowerCase() === 'مساعدة' || text.toLowerCase() === 'help') {
        const welcomeMsg = `╔═══════════════════════╗
║   مرحباً ${userName} 👋   
╚═══════════════════════╝

🤖 *بوت AppOmar الاحترافي*
━━━━━━━━━━━━━━━━━━━━━

✨ *المميزات:*
⚡ بحث وتحميل فوري
📦 تحميل مباشر من Google Play
🎮 دعم XAPK + OBB
🔒 آمن ومجاني 100%

━━━━━━━━━━━━━━━━━━━━━
📖 *طريقة الاستخدام:*

📝 أرسل اسم التطبيق مباشرة
⚡ سيتم إرسال التطبيق تلقائياً!

━━━━━━━━━━━━━━━━━━━━━
📸 https://www.instagram.com/omarxarafp
━━━━━━━━━━━━━━━━━━━━━`;

        const imageBuffer = await downloadBotProfileImage();
        
        if (imageBuffer) {
            await sock.sendMessage(groupJid, {
                image: imageBuffer,
                caption: welcomeMsg,
                contextInfo: {
                    forwardingScore: 999,
                    isForwarded: true
                }
            });
        } else {
            await sock.sendMessage(groupJid, { 
                text: welcomeMsg,
                contextInfo: {
                    forwardingScore: 999,
                    isForwarded: true
                }
            });
        }
        return;
    }

    session.isDownloading = true;
    session.currentApp = text.substring(0, 30);
    userSessions.set(sessionKey, session);

    sock.sendMessage(groupJid, { 
        react: { text: '🔍', key: msg.key }
    }).catch(console.error);

    try {
        const isPackageName = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(text.trim());
        
        let selectedApp;
        
        if (isPackageName) {
            try {
                selectedApp = await gplay.app({ appId: text.trim() });
            } catch {
                const results = await gplay.search({ term: text, num: 1 });
                if (results.length > 0) {
                    selectedApp = results[0];
                }
            }
        } else {
            const results = await gplay.search({ term: text, num: 1 });
            if (results.length > 0) {
                selectedApp = results[0];
            }
        }
        
        if (!selectedApp) {
            sock.sendMessage(groupJid, { 
                react: { text: '❌', key: msg.key }
            }).catch(console.error);
            sock.sendMessage(groupJid, { 
                text: '❌ لم أجد التطبيق. جرب اسم آخر.',
                contextInfo: { forwardingScore: 999, isForwarded: true }
            }, { quoted: msg }).catch(console.error);
            session.isDownloading = false;
            session.currentApp = null;
            userSessions.set(sessionKey, session);
            return;
        }

        const appId = selectedApp.appId || selectedApp.id || selectedApp.packageName;
        const appTitle = selectedApp.title || appId;
        session.currentApp = appTitle;
        userSessions.set(sessionKey, session);
        console.log(`✅ تم العثور على التطبيق: ${appTitle} (${appId})`);

        sock.sendMessage(groupJid, { react: { text: '📥', key: msg.key } }).catch(console.error);

        const [appDetails, apkStream] = await Promise.all([
            gplay.app({ appId: appId }).catch(() => selectedApp),
            downloadAPKStream(appId, appTitle)
        ]);
        
        let detailsText = `📱 *${appDetails.title || appTitle}*\n\n`;
        detailsText += `📦 *الحزمة:* ${appDetails.appId || appId}\n`;
        detailsText += `⭐ *التقييم:* ${appDetails.score ? appDetails.score.toFixed(1) : 'N/A'}/5\n`;
        detailsText += `📥 *التحميلات:* ${appDetails.installs || 'N/A'}\n`;
        detailsText += `📏 *الحجم:* ${appDetails.size || 'N/A'}\n`;
        detailsText += `🔄 *الإصدار:* ${appDetails.version || 'N/A'}\n`;
        detailsText += `👨‍💻 *المطور:* ${appDetails.developer || 'N/A'}`;

        const iconUrl = appDetails.icon || selectedApp.icon;
        if (iconUrl) {
            axios.get(iconUrl, { responseType: 'arraybuffer', timeout: 3000 })
                .then(response => {
                    sock.sendMessage(groupJid, {
                        image: Buffer.from(response.data),
                        caption: detailsText,
                        contextInfo: { forwardingScore: 999, isForwarded: true }
                    }, { quoted: msg });
                })
                .catch(() => {
                    sock.sendMessage(groupJid, { 
                        text: detailsText,
                        contextInfo: { forwardingScore: 999, isForwarded: true }
                    }, { quoted: msg });
                });
        } else {
            sock.sendMessage(groupJid, { 
                text: detailsText,
                contextInfo: { forwardingScore: 999, isForwarded: true }
            }, { quoted: msg }).catch(console.error);
        }
        
        if (apkStream) {
            sock.sendMessage(groupJid, { react: { text: '✅', key: msg.key } }).catch(console.error);

            const senderPhone = senderJid.replace('@s.whatsapp.net', '');
            logDownload(senderPhone, appDetails.appId || appId, appDetails.title || appTitle, apkStream.filename.endsWith('.xapk') ? 'xapk' : 'apk', apkStream.size).catch(console.error);

            if (apkStream.filename.endsWith('.xapk')) {
                try {
                    const extractedFiles = await extractXAPK(apkStream.buffer, appDetails.title || appTitle);
                    
                    if (extractedFiles.obb && extractedFiles.obb.length > 0) {
                        if (extractedFiles.apk) {
                            await sock.sendMessage(groupJid, {
                                document: extractedFiles.apk.buffer,
                                mimetype: 'application/vnd.android.package-archive',
                                fileName: extractedFiles.apk.filename
                            }, { quoted: msg });
                        }
                        
                        for (const obbFile of extractedFiles.obb) {
                            await sock.sendMessage(groupJid, {
                                document: obbFile.buffer,
                                mimetype: 'application/octet-stream',
                                fileName: obbFile.filename
                            }, { quoted: msg });
                        }
                        
                        let instructions = `✅ *تم الإرسال بنجاح!*\n\n`;
                        instructions += `📋 *طريقة التثبيت:*\n`;
                        instructions += `1️⃣ ثبت ملف APK أولاً\n`;
                        instructions += `2️⃣ انسخ ملف OBB إلى:\n`;
                        instructions += `   📁 Android/obb/${appDetails.appId || appId}/\n\n`;
                        instructions += `📸 https://www.instagram.com/omarxarafp\n`;
                        instructions += `🙏 شكراً لاستخدامك بوت AppOmar`;
                        
                        await sock.sendMessage(groupJid, { 
                            text: instructions,
                            contextInfo: { forwardingScore: 999, isForwarded: true }
                        }, { quoted: msg });
                    } else {
                        await sock.sendMessage(groupJid, {
                            document: apkStream.buffer,
                            mimetype: 'application/octet-stream',
                            fileName: apkStream.filename
                        }, { quoted: msg });
                        
                        let instructions = `✅ *تم الإرسال بنجاح!*\n\n`;
                        instructions += `📋 *طريقة التثبيت:*\n`;
                        instructions += `• استخدم تطبيق XAPK Installer\n`;
                        instructions += `• أو فك الضغط يدوياً\n\n`;
                        instructions += `📸 https://www.instagram.com/omarxarafp\n`;
                        instructions += `🙏 شكراً لاستخدامك بوت AppOmar`;
                        
                        await sock.sendMessage(groupJid, { 
                            text: instructions,
                            contextInfo: { forwardingScore: 999, isForwarded: true }
                        }, { quoted: msg });
                    }
                } catch (extractError) {
                    console.error('❌ خطأ في استخراج XAPK:', extractError);
                    await sock.sendMessage(groupJid, {
                        document: apkStream.buffer,
                        mimetype: 'application/octet-stream',
                        fileName: apkStream.filename
                    }, { quoted: msg });
                    
                    let successMsg = `✅ *تم الإرسال!*\n\n`;
                    successMsg += `📸 https://www.instagram.com/omarxarafp\n`;
                    successMsg += `🙏 شكراً لاستخدامك بوت AppOmar`;
                    
                    await sock.sendMessage(groupJid, { 
                        text: successMsg,
                        contextInfo: { forwardingScore: 999, isForwarded: true }
                    }, { quoted: msg });
                }
            } else {
                await sock.sendMessage(groupJid, {
                    document: apkStream.buffer,
                    mimetype: 'application/vnd.android.package-archive',
                    fileName: apkStream.filename
                }, { quoted: msg });
                
                let successMsg = `✅ *تم الإرسال بنجاح!*\n\n`;
                successMsg += `📸 https://www.instagram.com/omarxarafp\n`;
                successMsg += `🙏 شكراً لاستخدامك بوت AppOmar`;
                
                await sock.sendMessage(groupJid, { 
                    text: successMsg,
                    contextInfo: { forwardingScore: 999, isForwarded: true }
                }, { quoted: msg });
            }
            
            console.log(`✅ تم إنهاء التحميل للمستخدم ${senderJid} في المجموعة ${groupJid}`);
        } else {
            await sock.sendMessage(groupJid, { 
                react: { text: '❌', key: msg.key }
            });
            await sock.sendMessage(groupJid, { 
                text: '❌ لم أتمكن من تحميل التطبيق.\n💡 جرب تطبيقاً آخر.',
                contextInfo: { forwardingScore: 999, isForwarded: true }
            }, { quoted: msg });
        }
    } catch (error) {
        console.error('❌ خطأ:', error);
        await sock.sendMessage(groupJid, { 
            react: { text: '❌', key: msg.key }
        });
        await sock.sendMessage(groupJid, { 
            text: '❌ حدث خطأ. حاول مرة أخرى.',
            contextInfo: { forwardingScore: 999, isForwarded: true }
        }, { quoted: msg });
    }

    session.isDownloading = false;
    session.currentApp = null;
    userSessions.set(sessionKey, session);
}

console.log('╔══════════════════════════════════════╗');
console.log('║     🤖 بوت AppOmar الاحترافي 🤖     ║');
console.log('║     📢 وضع المجموعات فقط            ║');
console.log('╚══════════════════════════════════════╝\n');
console.log('🚀 جاري بدء البوت...\n');

await initDatabase();
await downloadBotProfileImage();

connectToWhatsApp().catch(err => {
    console.error('❌ خطأ فادح:', err);
    process.exit(1);
});
