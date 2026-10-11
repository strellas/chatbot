import {
    init, login, logout, checkMe,
    connectWs, sendChat, sendWs, requestHistory,
    stopGeneration, events, ROUTES,
} from '../api/api.js';

/* ============================================================
   TEMA
   ============================================================ */

function applyTheme() {
    const t = localStorage.getItem('theme') || 'dark';
    document.body.classList.toggle('theme-light', t === 'light');
    document.body.classList.toggle('theme-dark', t === 'dark');
    document.querySelectorAll('#theme-toggle').forEach(btn => {
        const light = t === 'light';
        btn.setAttribute('aria-pressed', String(light));
        btn.querySelector('.icon.moon')?.classList.toggle('hidden', light);
        btn.querySelector('.icon.sun')?.classList.toggle('hidden', !light);
    });
}
document.addEventListener('click', (e) => {
    if (e.target.closest('#theme-toggle')) {
        const cur = localStorage.getItem('theme') || 'dark';
        localStorage.setItem('theme', cur === 'dark' ? 'light' : 'dark');
        applyTheme();
    }
});
applyTheme();

/* ============================================================
   UTILIDADES UI
   ============================================================ */

// Mini-renderizador Markdown SEGURO: escapa TODO primero, luego formatea.
// Nunca renderiza HTML crudo del usuario/modelo → sin superficie XSS.
function renderMarkdown(raw) {
    const esc = raw
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return esc
        .replace(/```([\s\S]*?)```/g, (_, code) =>
            `<pre><code>${code.replace(/^\n|\n$/g, '')}</code></pre>`)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?])/g, '$1<em>$2</em>')
        .replace(/^#{2,3} (.+)$/gm, '<p><strong>$1</strong></p>')
        .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
        .split(/\n{2,}/).map(block =>
            block.trim().startsWith('<') ? block : `<p>${block.replace(/\n/g, '<br>')}</p>`)
        .join('');
}

function fmtTime(dateStr) {
    const d = new Date(String(dateStr).replace(' ', 'T') + 'Z');
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(dateStr) {
    const d = new Date(String(dateStr).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return '';
    const today = new Date(); const yest = new Date(Date.now() - 864e5);
    if (d.toDateString() === today.toDateString()) return 'Hoy';
    if (d.toDateString() === yest.toDateString()) return 'Ayer';
    return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
}

// Toasts (reemplazan al alert/confirm nativo)
function showToast(message, type = 'info', ms = 3200) {
    const cont = document.getElementById('toast-container');
    if (!cont) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    cont.appendChild(el);
    setTimeout(() => {
        el.classList.add('toast-out');
        el.addEventListener('animationend', () => el.remove(), { once: true });
    }, ms);
}

// Modal de confirmación basado en <dialog> nativo
function askConfirm(bodyText) {
    return new Promise(resolve => {
        const dlg = document.getElementById('confirm-modal');
        if (!dlg) { resolve(confirm(bodyText)); return; }
        document.getElementById('modal-body').textContent = bodyText;
        const done = val => { dlg.close(); cleanup(); resolve(val); };
        const onCancel = () => done(false);
        const onConfirm = () => done(true);
        const onDlgClick = e => { if (e.target === dlg) onCancel(); }; // click fuera
        function cleanup() {
            document.getElementById('modal-cancel').removeEventListener('click', onCancel);
            document.getElementById('modal-confirm').removeEventListener('click', onConfirm);
            document.getElementById('modal-close').removeEventListener('click', onCancel);
            dlg.removeEventListener('click', onDlgClick);
            dlg.removeEventListener('cancel', onCancel);
        }
        document.getElementById('modal-cancel').addEventListener('click', onCancel);
        document.getElementById('modal-confirm').addEventListener('click', onConfirm);
        document.getElementById('modal-close').addEventListener('click', onCancel);
        dlg.addEventListener('click', onDlgClick);
        dlg.addEventListener('cancel', onCancel);
        dlg.showModal();
    });
}

function hideLoader() {
    document.querySelector('.loader-screen')?.classList.add('done');
}

/* ============================================================
   PÁGINA: ACCESO (nombre + contraseña, sin registro)
   ============================================================ */

function setupLogin() {
    const loginForm = document.getElementById('login-form');
    const errBox = document.getElementById('auth-error');
    const errMsg = errBox.querySelector('.error-message');
    const userInput = document.getElementById('login-user');
    const passInput = document.getElementById('login-pass');

    function showError(msg) {
        errMsg.textContent = msg;
        errBox.classList.remove('hidden');
        clearTimeout(showError._t);
        showError._t = setTimeout(() => errBox.classList.add('hidden'), 4500);
    }

    function setBtnLoading(btn, loading, textIdle) {
        btn.classList.toggle('loading', loading);
        btn.disabled = loading;
        if (!loading) btn.querySelector('.btn-text').textContent = textIdle;
    }

    // Un solo flujo: escribe nombre y contraseña y entra. Si el nombre es
    // nuevo, el backend crea la cuenta automáticamente. Sin registro.
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('login-submit');
        setBtnLoading(btn, true);
        try {
            await login(userInput.value.trim(), passInput.value);
            window.location.href = ROUTES.chat;
        } catch (err) {
            showError('❌ ' + err.message);
            setBtnLoading(btn, false, 'Entrar');
        }
    });
}

/* ============================================================
   PÁGINA: CHAT
   ============================================================ */

function setupChat() {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');
    const inner = document.getElementById('chat-inner');
    const scroller = document.getElementById('chat-scroll-container');
    const historyList = document.getElementById('history-list');
    const emptyState = document.getElementById('empty-state');
    const typingEl = document.getElementById('typing-indicator');
    const scrollBtn = document.getElementById('scroll-bottom-btn');
    const charCounter = document.getElementById('char-counter');
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('backdrop');
    const menuBtn = document.getElementById('menu-btn');
    const statusIndicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');

    let isGenerating = false;
    let lastDateLabel = null;
    let streamMsg = null;      // { row, content, raw } del mensaje en streaming
    let lastUserPrompt = '';

    /* --- Sesión --- */
    checkMe().then(user => {
        if (!user) { window.location.href = ROUTES.auth; return; }
        document.getElementById('display-username').textContent = user.username || 'Usuario';
        connectWs(handleWsMessage, null, onWsOpen, onWsClose);
    });

    /* --- Input: contador, autosize, Enter --- */
    function refreshCounter() {
        charCounter.textContent = `${input.value.length} / 4096`;
    }
    input.addEventListener('input', () => {
        // Fallback de autosize (field-sizing: content lo cubre si hay soporte)
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 150) + 'px';
        refreshCounter();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); sendMessage(); }
    });
    sendBtn.addEventListener('click', sendMessage);
    stopBtn.addEventListener('click', () => {
        stopGeneration(); // requiere soporte backend ({type:"stop"})
        showToast('Deteniendo generación…', 'info', 1500);
    });
    refreshCounter();

    /* --- Prompts sugeridos (delegación: sin re-binds) --- */
    document.addEventListener('click', (e) => {
        const chip = e.target.closest('.prompt-chip');
        if (chip) { input.value = chip.dataset.prompt || chip.textContent; sendMessage(); }
    });

    /* --- Sidebar móvil --- */
    function setSidebar(open) {
        sidebar.classList.toggle('open', open);
        backdrop.classList.toggle('show', open);
        menuBtn.setAttribute('aria-expanded', String(open));
    }
    menuBtn.addEventListener('click', () => setSidebar(!sidebar.classList.contains('open')));
    backdrop.addEventListener('click', () => setSidebar(false));
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && sidebar.classList.contains('open')) setSidebar(false);
    });

    /* --- Acciones sidebar --- */
    document.getElementById('logout-btn').addEventListener('click', async () => {
        await logout();
        window.location.href = ROUTES.auth;
    });
    document.getElementById('refresh-history').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        btn.classList.remove('spinning');
        requestAnimationFrame(() => btn.classList.add('spinning'));
        requestHistory();
    });
    document.getElementById('new-chat-btn').addEventListener('click', () => {
        // Limpiar vista sin clonar nada: se reusa el mismo empty-state
        [...inner.children].forEach(el => { if (el !== emptyState && el !== typingEl) el.remove(); });
        emptyState.classList.remove('hidden');
        lastDateLabel = null;
        lastUserPrompt = '';
        input.focus();
    });
    document.getElementById('clear-history-btn').addEventListener('click', async () => {
        const ok = await askConfirm('Se borrará TODO tu historial de conversaciones. Esta acción no se puede deshacer.');
        if (ok) sendWs({ type: 'clear_history' });
    });
    // Banner offline: el botón "Reintentar" reconecta el WebSocket
    document.getElementById('retry-conn')?.addEventListener('click', () =>
        connectWs(handleWsMessage, null, onWsOpen, onWsClose));

    /* --- Botón "ir al final" --- */
    scroller.addEventListener('scroll', () => {
        const farFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 300;
        scrollBtn.classList.toggle('hidden', !farFromBottom);
    }, { passive: true });
    scrollBtn.addEventListener('click', () =>
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }));

    function scrollToBottom(force = false) {
        const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 150;
        if (force || nearBottom) scroller.scrollTop = scroller.scrollHeight;
    }

    /* --- Envío --- */
    function sendMessage() {
        const text = input.value.trim();
        if (!text || isGenerating) return;
        hideEmpty();
        lastUserPrompt = text;
        input.value = ''; input.style.height = 'auto'; refreshCounter();
        appendMessage('user', text);
        setGenerating(true);
        if (!sendChat(text)) {
            appendMessage('assistant', '⚠️ Sin conexión con el servidor. Reintentando…');
            setGenerating(false);
        }
    }

    function setGenerating(state) {
        isGenerating = state;
        stopBtn.hidden = !state;
        sendBtn.disabled = state;
    }

    function hideEmpty() { emptyState.classList.add('hidden'); }

    /* --- Render de mensajes --- */
    function appendMessage(role, text, meta = {}) {
        hideEmpty();

        const tpl = document.getElementById('msg-template');
        let row;
        if (role === 'assistant' && tpl && tpl.content) {
            row = tpl.content.firstElementChild.cloneNode(true);
        } else {
            row = document.createElement('article');
            row.className = `message msg-${role}`;
            row.innerHTML = `
                <div class="msg-avatar">${role === 'user' ? '🧑' : '🤖'}</div>
                <div class="msg-body">
                    <header class="msg-header">
                        <span class="msg-author"></span>
                        <time class="msg-time"></time>
                    </header>
                    <div class="msg-content"></div>
                </div>`;
        }

        const author = row.querySelector('.msg-author');
        if (author) author.textContent = role === 'user' ? 'Tú' : 'Asistente';
        const time = row.querySelector('.msg-time');
        if (time) {
            const t = meta.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            time.textContent = t;
        }

        const content = row.querySelector('.msg-content');
        // user: texto plano; assistant: markdown renderizado (ya escapado)
        if (role === 'user') content.textContent = text;
        else content.innerHTML = renderMarkdown(text);

        // Acciones (solo en mensajes con plantilla)
        row.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
            navigator.clipboard.writeText(text).then(() => {
                showToast('📋 Copiado al portapapeles', 'success', 1500);
            }).catch(() => showToast('No se pudo copiar', 'error'));
        });
        row.querySelector('[data-action="regenerate"]')?.addEventListener('click', () => {
            if (isGenerating || !lastUserPrompt) return;
            row.remove();
            appendMessage('user', lastUserPrompt);
            setGenerating(true);
            sendChat(lastUserPrompt);
        });
        row.querySelectorAll('[data-action="good"], [data-action="bad"]').forEach(btn => {
            btn.addEventListener('click', () => {
                row.querySelectorAll('[data-action="good"], [data-action="bad"]')
                    .forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // typing indicator siempre al final
        inner.insertBefore(row, typingEl.parentNode === inner ? typingEl : null);
        scrollToBottom();
        return { row, content, raw: text };
    }

    function addDateSeparator(label) {
        if (label === lastDateLabel || !label) return;
        lastDateLabel = label;
        const sep = document.createElement('div');
        sep.className = 'date-sep';
        sep.textContent = label;
        inner.insertBefore(sep, typingEl.parentNode === inner ? typingEl : null);
    }

    /* --- Skeleton historial --- */
    function removeSkeleton() {
        historyList.querySelector('.history-skeleton')?.remove();
    }

    /* --- Protocolo WS --- */
    function handleWsMessage(data) {
        switch (data.type) {
            case 'typing':
                typingEl.classList.remove('hidden');
                inner.appendChild(typingEl); // asegurar al final
                scrollToBottom(true);
                break;

            case 'delta': {
                if (!streamMsg) {
                    typingEl.classList.add('hidden');
                    streamMsg = appendMessage('assistant', '', { time: '' });
                    streamMsg.row.querySelector('.msg-actions')?.classList.add('hidden');
                    streamMsg.content.classList.add('stream-cursor');
                }
                streamMsg.raw += data.text;
                streamMsg.content.innerHTML = renderMarkdown(streamMsg.raw);
                scrollToBottom();
                break;
            }

            case 'done': {
                if (streamMsg) {
                    streamMsg.content.classList.remove('stream-cursor');
                    streamMsg.row.querySelector('.msg-actions')?.classList.remove('hidden');
                    const time = streamMsg.row.querySelector('.msg-time');
                    if (time && !time.textContent) {
                        time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    }
                    streamMsg = null;
                }
                typingEl.classList.add('hidden');
                removeSkeleton();
                rebuildSidebarHistory();
                setGenerating(false);
                input.focus();
                break;
            }

            case 'error': {
                typingEl.classList.add('hidden');
                streamMsg = null;
                setGenerating(false);
                appendMessage('assistant', `⚠️ ${data.detail || 'Error del servidor'}`);
                break;
            }

            case 'history': {
                [...inner.children].forEach(el => { if (el !== emptyState && el !== typingEl) el.remove(); });
                lastDateLabel = null;
                if (!data.messages || !data.messages.length) {
                    emptyState.classList.remove('hidden');
                    break;
                }
                data.messages.forEach(m => {
                    addDateSeparator(fmtDate(m.created_at));
                    appendMessage(m.role, m.content, { time: fmtTime(m.created_at) });
                });
                removeSkeleton();
                rebuildSidebarHistory();
                scroller.scrollTop = scroller.scrollHeight;
                break;
            }

            case 'history_cleared': {
                [...inner.children].forEach(el => { if (el !== emptyState && el !== typingEl) el.remove(); });
                historyList.innerHTML = '';
                lastDateLabel = null;
                emptyState.classList.remove('hidden');
                showToast('🗑️ Historial borrado', 'success');
                break;
            }
        }
    }

    /* --- Sidebar: últimos intercambios --- */
    function rebuildSidebarHistory() {
        const msgs = [...inner.querySelectorAll('.msg-user .msg-content')]
            .map(c => c.textContent.trim().slice(0, 38));
        historyList.innerHTML = '';
        msgs.slice(-15).forEach((txt, i, arr) => {
            const el = document.createElement('button');
            el.className = 'hist-item' + (i === arr.length - 1 ? ' active' : '');
            el.innerHTML = '<span class="dot" aria-hidden="true"></span>';
            const span = document.createElement('span');
            span.textContent = txt + (txt.length >= 38 ? '…' : '');
            el.appendChild(span);
            el.addEventListener('click', () => {
                const rows = [...inner.querySelectorAll('.msg-user')];
                rows[Math.min(rows.length - arr.length + i, rows.length - 1)]
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
            historyList.appendChild(el);
        });
    }

    /* --- Estado de conexión --- */
    function onWsOpen() {
        statusIndicator.className = 'status-dot connected';
        statusText.textContent = 'En línea';
        document.getElementById('conn-banner')?.classList.add('hidden');
        requestHistory();
    }
    function onWsClose() {
        statusIndicator.className = 'status-dot disconnected';
        statusText.textContent = 'Desconectado';
        document.getElementById('conn-banner')?.classList.remove('hidden');
        if (isGenerating) {
            streamMsg = null;
            typingEl.classList.add('hidden');
            setGenerating(false);
        }
    }

    input.focus();
}

/* ============================================================
   ROUTER + ARRANQUE
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
    init();
    const page = document.body.dataset.page;
    if (page === 'login') { setupLogin(); hideLoader(); }
    else if (page === 'chat') { setupChat(); hideLoader(); }
    else {
        checkMe().then(u => {
            window.location.href = u ? ROUTES.chat : ROUTES.auth;
        });
    }
});

/* Redirección global si caduca la sesión */
events.addEventListener('auth-failed', () => {
    if (document.body.dataset.page === 'chat') window.location.href = ROUTES.auth;
});