// Open Seat — bot de alertas en Telegram (Cloudflare Worker)
//
// Este Worker solo atiende la conversación: cuando alguien le escribe al bot o toca un botón,
// Telegram llama a este Worker (webhook) y acá se guardan sus filtros en KV.
// El envío de avisos nuevos lo hace GitHub Actions después de cada actualización
// (scripts/alerts.mjs), leyendo las preferencias guardadas en el mismo KV.
//
// Datos que se guardan por persona (clave "u:<chat_id>"): sus filtros, si las alertas están
// activas y la fecha de alta. Nada más: ni nombre, ni usuario, ni teléfono.
// /baja borra todo.
//
// Variables (las carga el workflow de despliegue):
//   TELEGRAM_BOT_TOKEN   token de @BotFather (secreto)
//   WEBHOOK_SECRET       secreto compartido con Telegram para verificar que el pedido es suyo
//   SUBS                 namespace de KV con las preferencias

export const SITE = "https://open-seat.github.io/";

export const ROLES = [["pd", "Product design"], ["uxui", "UX/UI"], ["research", "UX research"], ["pm", "Producto"], ["dev", "Desarrollo"], ["data", "Datos e IA"]];
export const LEVELS = [["junior", "Junior"], ["mid", "Semi senior"], ["senior", "Senior"], ["lead", "Lead o staff"]];
export const MODS = [["Remoto", "Remoto"], ["Híbrido", "Híbrido"], ["Presencial", "Presencial"]];
export const WHERE = [["yes", "Solo confirmados para Argentina"], ["incl", "Argentina y los que no aclaran país"], ["all", "Todos los países"]];
export const LANGS = [["", "Cualquier idioma"], ["Español", "Solo en español"], ["Inglés", "Solo en inglés"]];
const STEPS = ["roles", "lvls", "mods", "where", "lang"];

export const blankPrefs = () => ({ roles: [], lvls: [], mods: [], where: "incl", lang: "", active: false, step: "roles", created: new Date().toISOString().slice(0, 10) });

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const label = (list, k) => (list.find(x => x[0] === k) || [k, k])[1];
const many = (list, keys, none) => keys.length ? keys.map(k => label(list, k)).join(", ") : none;

export function summary(p) {
  return [
    `<b>Rol:</b> ${esc(many(ROLES, p.roles, "todos"))}`,
    `<b>Nivel:</b> ${esc(many(LEVELS, p.lvls, "todos"))}${p.lvls.length ? " (más los que no aclaran nivel)" : ""}`,
    `<b>Modalidad:</b> ${esc(many(MODS, p.mods, "todas"))}`,
    `<b>Dónde:</b> ${esc(label(WHERE, p.where))}`,
    `<b>Idioma:</b> ${esc(label(LANGS, p.lang))}`,
  ].join("\n");
}

// ---------- pantallas del asistente ----------
const btn = (text, data) => ({ text, callback_data: data });
const rows = (buttons, per = 2) => buttons.reduce((acc, b, i) => (i % per ? acc[acc.length - 1].push(b) : acc.push([b]), acc), []);
const check = on => (on ? "✅ " : "");

export function screen(p) {
  const n = STEPS.indexOf(p.step) + 1;
  const head = `Paso ${n} de ${STEPS.length}`;
  const nav = [btn("Siguiente", "next")];
  if (p.step === "roles") return {
    text: `${head}\n<b>¿Qué roles te interesan?</b>\nPodés elegir varios. Si no elegís ninguno, te llegan todos.`,
    keyboard: [...rows(ROLES.map(([k, l]) => btn(check(p.roles.includes(k)) + l, `t:roles:${k}`))), nav],
  };
  if (p.step === "lvls") return {
    text: `${head}\n<b>¿Qué seniority?</b>\nPodés elegir varios. También te van a llegar los avisos que no aclaran el nivel.`,
    keyboard: [...rows(LEVELS.map(([k, l]) => btn(check(p.lvls.includes(k)) + l, `t:lvls:${k}`))), [btn("Atrás", "back"), ...nav]],
  };
  if (p.step === "mods") return {
    text: `${head}\n<b>¿Qué modalidad?</b>\nSi no elegís ninguna, te llegan todas.`,
    keyboard: [rows(MODS.map(([k, l]) => btn(check(p.mods.includes(k)) + l, `t:mods:${k}`)), 3)[0], [btn("Atrás", "back"), ...nav]],
  };
  if (p.step === "where") return {
    text: `${head}\n<b>¿Desde dónde podés trabajar?</b>`,
    keyboard: [...WHERE.map(([k, l]) => [btn(check(p.where === k) + l, `s:where:${k}`)]), [btn("Atrás", "back"), ...nav]],
  };
  return {
    text: `${head}\n<b>¿En qué idioma?</b>\nEs el idioma en que está escrito el aviso.`,
    keyboard: [...LANGS.map(([k, l]) => [btn(check(p.lang === k) + l, `s:lang:${k}`)]), [btn("Atrás", "back"), btn("Activar alertas", "done")]],
  };
}

export const doneScreen = p => ({
  text: `🔔 <b>Listo, tus alertas están activas.</b>\n\n${summary(p)}\n\nTe aviso cuando aparezca un aviso nuevo que coincida. Open Seat se actualiza cada 6 horas.`,
  keyboard: [[btn("Cambiar filtros", "edit"), btn("Pausar", "pause")], [{ text: "Ver avisos en Open Seat", url: SITE }]],
});

const HELP = [
  "<b>Comandos</b>",
  "/filtros — cambiar qué avisos te llegan",
  "/estado — ver tus filtros",
  "/pausar — dejar de recibir alertas por un tiempo",
  "/reanudar — volver a recibirlas",
  "/baja — borrar tus datos y dejar de recibir alertas",
  "/privacidad — qué datos guardamos",
].join("\n");

const PRIVACY = "Guardamos solo tus filtros y un número interno que Telegram nos da para poder escribirte. No guardamos tu nombre, tu usuario ni tu teléfono. Con /baja se borra todo.";

// ---------- lógica de la conversación (sin red: devuelve qué responder) ----------
// Recibe el update de Telegram y las preferencias actuales; devuelve { prefs, del, actions }.
export function handle(update, prefs) {
  const actions = [];
  const send = (chat, text, keyboard) => actions.push({ method: "sendMessage", body: { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) } });
  const edit = (chat, msg, text, keyboard) => actions.push({ method: "editMessageText", body: { chat_id: chat, message_id: msg, text, parse_mode: "HTML", disable_web_page_preview: true, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) } });

  if (update.message) {
    const chat = update.message.chat.id;
    if (update.message.chat.type !== "private") return { prefs, actions };
    const cmd = String(update.message.text || "").trim().split(/[\s@]/)[0].toLowerCase();
    if (cmd === "/start" || cmd === "/filtros") {
      const p = { ...(prefs || blankPrefs()), step: "roles" };
      const s = screen(p);
      if (cmd === "/start" && !prefs) send(chat, "👋 <b>Hola, soy el bot de Open Seat.</b>\nTe aviso cuando aparezcan avisos de tecnología, diseño y producto que coincidan con lo que buscás. Son 5 pasos con botones.");
      send(chat, s.text, s.keyboard);
      return { prefs: p, actions };
    }
    if (!prefs) { send(chat, "Para empezar, mandá /start y armá tu alerta."); return { prefs, actions }; }
    if (cmd === "/estado") {
      send(chat, `${prefs.active ? "🔔 Alertas activas" : "⏸ Alertas en pausa"}\n\n${summary(prefs)}`, [[btn("Cambiar filtros", "edit"), btn(prefs.active ? "Pausar" : "Reanudar", prefs.active ? "pause" : "resume")]]);
      return { prefs, actions };
    }
    if (cmd === "/pausar") { send(chat, "⏸ Pausé tus alertas. Cuando quieras volver, mandá /reanudar."); return { prefs: { ...prefs, active: false }, actions }; }
    if (cmd === "/reanudar") { send(chat, "🔔 Tus alertas están activas de nuevo."); return { prefs: { ...prefs, active: true, step: "done" }, actions }; }
    if (cmd === "/baja") { send(chat, "Listo, borré tus datos y no vas a recibir más alertas. Si algún día querés volver, mandá /start."); return { prefs: null, del: true, actions }; }
    if (cmd === "/privacidad") { send(chat, PRIVACY); return { prefs, actions }; }
    send(chat, HELP);
    return { prefs, actions };
  }

  if (update.callback_query) {
    const q = update.callback_query;
    const chat = q.message?.chat?.id, msg = q.message?.message_id;
    actions.push({ method: "answerCallbackQuery", body: { callback_query_id: q.id } });
    if (!chat) return { prefs, actions };
    let p = { ...(prefs || blankPrefs()) };
    const data = String(q.data || "");
    const [kind, field, value] = data.split(":");
    if (kind === "t" && ["roles", "lvls", "mods"].includes(field)) {
      const set = new Set(p[field]); set.has(value) ? set.delete(value) : set.add(value); p[field] = [...set];
    } else if (kind === "s" && ["where", "lang"].includes(field)) {
      p[field] = value || "";
    } else if (data === "next") { p.step = STEPS[Math.min(STEPS.indexOf(p.step) + 1, STEPS.length - 1)] || "roles"; }
    else if (data === "back") { p.step = STEPS[Math.max(STEPS.indexOf(p.step) - 1, 0)] || "roles"; }
    else if (data === "edit") { p.step = "roles"; }
    else if (data === "done") { p = { ...p, active: true, step: "done" }; const s = doneScreen(p); edit(chat, msg, s.text, s.keyboard); return { prefs: p, actions }; }
    else if (data === "pause") { p.active = false; edit(chat, msg, `⏸ <b>Alertas en pausa.</b>\n\n${summary(p)}`, [[btn("Reanudar", "resume"), btn("Cambiar filtros", "edit")]]); return { prefs: p, actions }; }
    else if (data === "resume") { p = { ...p, active: true, step: "done" }; const s = doneScreen(p); edit(chat, msg, s.text, s.keyboard); return { prefs: p, actions }; }
    if (!STEPS.includes(p.step)) p.step = "roles";
    const s = screen(p);
    edit(chat, msg, s.text, s.keyboard);
    return { prefs: p, actions };
  }
  return { prefs, actions };
}

// ---------- Worker ----------
async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.ok;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("Open Seat bot 🟢", { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (request.method !== "POST" || url.pathname !== "/telegram") return new Response("Not found", { status: 404 });
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });

    let update;
    try { update = await request.json(); } catch { return new Response("ok"); }
    const chat = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    if (!chat) return new Response("ok");
    const key = `u:${chat}`;
    const prefs = await env.SUBS.get(key, "json");
    const out = handle(update, prefs);
    if (out.del) await env.SUBS.delete(key);
    else if (out.prefs && JSON.stringify(out.prefs) !== JSON.stringify(prefs)) await env.SUBS.put(key, JSON.stringify(out.prefs));
    for (const a of out.actions) await tg(env, a.method, a.body);
    return new Response("ok");
  },
};
