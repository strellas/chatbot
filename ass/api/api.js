/**
 * API Client & WebSocket Manager
 * Autenticación, conexión WS y comunicación con el backend.
 *
 * ⚠️ NOTA DE SEGURIDAD: cualquier valor en un .js público es visible para
 * cualquiera que abra DevTools. Si esta key es sensible, genérala por sesión. 
 * Está aquí porque tu arquitectura actual la espera como header/param.
 */

// ============================================================
//  ⚙️  CONFIGURACIÓN
// ============================================================
// ⚠️ Token público: va el valor EN CLARO (el backend solo guarda su sha256).
// Es una credencial COMPARTIDA (filtra el ruido de Internet, no es un secreto
// personal). La defensa real: JWT por usuario + rate-limit por IP + Cloudflare.
const TUNEL = {
    // Túnel nombrado permanente de ChatBOT (no cambia al reiniciar cloudflared)
    BASE_HTTP: "https://chatbot.archivoscloud.site",
    WS_URL: "wss://chatbot.archivoscloud.site/ws",
};
const LOCAL = {
    BASE_HTTP: "http://127.0.0.1:8010",   // ChatBOT; 8000 lo ocupa ChatView
    WS_URL: "ws://127.0.0.1:8010/ws",
};

// Preview local (localhost/127.0.0.1) → backend local; producción → túnel.
// Así ves los cambios al instante sin subir a GitHub en cada iteración.
const API_CONFIG = {
    ...(["localhost", "127.0.0.1"].includes(location.hostname) ? LOCAL : TUNEL),
    PUBLIC_TOKEN: "m28bArnmOiX3rDu_TJYHvphHsWr9V9rQh6lX-irV_rw",
};

// Rutas RELATIVAS al HTML real: funcionan bajo /chatbot/ en GitHub Pages y en
// la raíz con dominio custom. Se derivan de la ubicación de este módulo.
// ⚠️ Apuntar al .html explícito: GitHub Pages NO sirve index.html dentro de
// subcarpetas de un project page (daba 404 en /chatbot/page/register/).
const BASE_PATH = new URL("../../", import.meta.url).pathname;
export const ROUTES = {
    auth:     BASE_PATH + "page/register/register.html",
    register: BASE_PATH + "page/register/register.html",
    login:    BASE_PATH + "page/register/register.html", // alias de compatibilidad
    chat:     BASE_PATH + "page/chat/chat.html",
};

// ============================================================
//  (Todo lo de abajo no se toca)
// ============================================================

const API_BASE = API_CONFIG.BASE_HTTP;
const API_KEY_PUBLICA = API_CONFIG.PUBLIC_TOKEN;
const WS_URL = API_CONFIG.WS_URL;
const HTTP_TIMEOUT_MS = 12000;
const PING_INTERVAL_MS = 25000;
const RECONNECT_DELAY_MS = 3000;

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let pingTimer = null;
let currentToken = sessionStorage.getItem("access_token");
let currentDeviceId = localStorage.getItem("device_id");

const events = new EventTarget();

export function init() {
    if (!API_KEY_PUBLICA) {
        console.error("api.js: API_KEY_PUBLICA está vacía, edítala en la parte superior del archivo.");
    }
    if (!crypto.randomUUID) {
        // Fallback id de dispositivo para navegadores viejos
        if (!localStorage.getItem("device_id")) {
            localStorage.setItem("device_id", "dev-" + Date.now() + "-" + Math.random().toString(36).slice(2));
        }
        currentDeviceId = localStorage.getItem("device_id");
    }
}

/** Petición HTTP genérica con timeout (AbortController). */
async function http(method, endpoint, body = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    const headers = {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY_PUBLICA,
        "X-Device-Id": currentDeviceId || "",
    };

    try {
        const res = await fetch(`${API_BASE}${endpoint}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : null,
            signal: controller.signal,
        });

        if (res.status === 401) {
            handleAuthFailure();
            throw new Error("Unauthorized");
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: "Error desconocido" }));
            throw new Error(err.detail || res.statusText);
        }
        return await res.json();
    } catch (err) {
        if (err.name === "AbortError") throw new Error("Tiempo de espera agotado");
        console.error(`HTTP ${method} ${endpoint} failed:`, err);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function handleAuthFailure() {
    currentToken = null;
    currentDeviceId = null;
    sessionStorage.removeItem("access_token");
    localStorage.removeItem("device_id");
    closeWs();
    events.dispatchEvent(new CustomEvent("auth-failed"));
}

// --- Auth Endpoints ---

export async function register(username, password) {
    return http("POST", "/auth/register", { username, password });
}

export async function login(username, password) {
    const data = await http("POST", "/auth/login", { username, password });
    currentToken = data.access_token;
    currentDeviceId = data.device_id;
    sessionStorage.setItem("access_token", currentToken);
    localStorage.setItem("device_id", currentDeviceId);
    events.dispatchEvent(new CustomEvent("auth-success", { detail: data }));
    return data;
}

export async function logout() {
    if (!currentToken) return;
    try {
        await http("POST", "/auth/logout", {
            access_token: currentToken,
            refresh_token: localStorage.getItem("refresh_token") || "",
        });
    } catch (e) { /* Ignorar errores en logout */ }

    currentToken = null;
    sessionStorage.removeItem("access_token");
    localStorage.removeItem("device_id");
    localStorage.removeItem("refresh_token");
    closeWs();
    events.dispatchEvent(new CustomEvent("logged-out"));
}

export async function checkMe() {
    if (!currentToken) return null;
    try {
        return await http("GET", `/auth/me?token=${encodeURIComponent(currentToken)}`);
    } catch (e) {
        return null;
    }
}

// --- WebSocket Management ---

export function connectWs(onMessage, onError, onOpen, onClose) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const url = `${WS_URL}?key=${encodeURIComponent(API_KEY_PUBLICA)}&token=${encodeURIComponent(currentToken || "")}`;
    ws = new WebSocket(url);

    ws.onopen = () => {
        reconnectAttempts = 0;
        startPing();
        if (onOpen) onOpen();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type !== "pong") {   // pings silenciosos
                if (onMessage) onMessage(data);
            }
        } catch (e) {
            console.error("WS Parse error:", e);
        }
    };

    ws.onerror = (err) => {
        if (onError) onError(err);
    };

    ws.onclose = (event) => {
        stopPing();
        ws = null;
        if (onClose) onClose(event);

        // 1008 = auth rechazada y 1000 = cierre limpio: NO reconectar
        if (event.code !== 1008 && event.code !== 1000) {
            reconnectAttempts++;
            const delay = Math.min(RECONNECT_DELAY_MS * reconnectAttempts, 15000); // backoff
            reconnectTimer = setTimeout(
                () => connectWs(onMessage, onError, onOpen, onClose),
                delay
            );
        }
    };
}

/** Envío genérico por WS (para clear_history, stop, etc.). */
export function sendWs(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
        return true;
    }
    return false;
}

// Heartbeat: el backend cierra tras 5 min de silencio
function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        }
    }, PING_INTERVAL_MS);
}

function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
}

export function sendChat(content) {
    return sendWs({ type: "chat", content });
}

export function requestHistory() {
    return sendWs({ type: "history" });
}

export function clearHistory() {
    return sendWs({ type: "clear_history" });
}

export function stopGeneration() {
    return sendWs({ type: "stop" }); // requiere soporte en tu backend
}

export function closeWs() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    stopPing();
    reconnectAttempts = 0;
    if (ws) {
        ws.onclose = null; // evita reconexión automática al cerrar a propósito
        ws.close();
        ws = null;
    }
}

export { events };
