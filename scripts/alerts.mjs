// Open Seat — manda a cada persona suscripta al bot de Telegram los avisos nuevos que coinciden con sus filtros
// Lo corre el workflow "Actualizar avisos" justo después de traer los avisos.
//
// Las preferencias las guarda el bot (bot/worker.js) en Cloudflare KV; acá se leen con la API de Cloudflare.
// Necesita estos secretos del repo (si falta alguno, no hace nada):
//   TELEGRAM_BOT_TOKEN, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
// y el id del namespace de KV, que el workflow de despliegue del bot guarda en bot/kv.json.

import { readFile } from "node:fs/promises";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const SITE = "https://lalapicoroso.github.io/open-seat/";
const MAX_PER_MESSAGE = 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const LVL = { junior: "Junior", mid: "Semi senior", senior: "Senior", lead: "Lead o staff" };

// Mismo criterio que los filtros del sitio. Si la persona eligió niveles, también le llegan
// los avisos que no aclaran el nivel (son muchos y no queremos que se pierda ninguno).
export function matches(j, p) {
  if (p.roles?.length && !p.roles.includes(j.role)) return false;
  if (p.lvls?.length && j.lvl !== "any" && !p.lvls.includes(j.lvl)) return false;
  if (p.mods?.length && !p.mods.includes(j.mod)) return false;
  if (p.where === "yes" && j.ar !== true) return false;
  if ((p.where || "incl") === "incl" && j.ar === false) return false;
  if (p.lang && j.lang !== p.lang) return false;
  return true;
}

export function newJobs(data) {
  return (data.jobs || []).filter(j => j.firstSeen && j.firstSeen === data.updatedAt);
}

export function formatAlert(jobs) {
  const sorted = [...jobs].sort((a, b) => ((b.ar === true) - (a.ar === true)) || String(b.posted || "").localeCompare(String(a.posted || "")));
  const shown = sorted.slice(0, MAX_PER_MESSAGE);
  const lines = [`🆕 <b>${jobs.length === 1 ? "1 aviso nuevo" : `${jobs.length} avisos nuevos`} para vos</b>`, ""];
  for (const j of shown) {
    const where = j.ar === true ? "🟢 Podés aplicar desde Argentina" : j.ar === null ? "🟡 No aclara países" : "⚪ Fuera de Argentina";
    const meta = [j.c, j.mod, LVL[j.lvl]].filter(Boolean).map(esc).join(" · ");
    lines.push(`<a href="${esc(j.url)}"><b>${esc(j.t)}</b></a>`, meta, where, "");
  }
  if (jobs.length > shown.length) lines.push(`Y ${jobs.length - shown.length} más en <a href="${SITE}">Open Seat</a>.`, "");
  lines.push("Cambiar filtros: /filtros · Pausar: /pausar");
  return lines.join("\n");
}

// ---------- Cloudflare KV ----------
async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${path}`, {
    ...init, headers: { Authorization: `Bearer ${CF_TOKEN}`, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Cloudflare ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}
async function listSubscribers(ns) {
  const keys = [];
  let cursor = "";
  do {
    const r = await (await cf(`${ns}/keys?prefix=u:&limit=1000${cursor ? `&cursor=${cursor}` : ""}`)).json();
    keys.push(...r.result.map(k => k.name));
    cursor = r.result_info?.cursor || "";
  } while (cursor);
  const subs = [];
  for (const k of keys) {
    try { subs.push({ key: k, chat: k.slice(2), prefs: await (await cf(`${ns}/values/${encodeURIComponent(k)}`)).json() }); } catch (e) { console.log(`No pude leer ${k}: ${e.message}`); }
  }
  return subs;
}

async function main() {
  if (!TOKEN || !CF_TOKEN || !CF_ACCOUNT) { console.log("Faltan secretos del bot de Telegram o de Cloudflare: no se mandan alertas."); return; }
  let ns;
  try { ns = JSON.parse(await readFile(new URL("../bot/kv.json", import.meta.url), "utf8")).id; } catch {}
  if (!ns) { console.log("Todavía no se desplegó el bot (falta bot/kv.json): no se mandan alertas."); return; }

  const data = JSON.parse(await readFile(new URL("../data/jobs.json", import.meta.url), "utf8"));
  const fresh = newJobs(data);
  console.log(`Avisos nuevos en esta actualización: ${fresh.length}`);
  if (!fresh.length) return;

  const subs = (await listSubscribers(ns)).filter(s => s.prefs?.active);
  console.log(`Personas con alertas activas: ${subs.length}`);
  let sent = 0, removed = 0;
  for (const s of subs) {
    const mine = fresh.filter(j => matches(j, s.prefs));
    if (!mine.length) continue;
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: s.chat, text: formatAlert(mine), parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (res.ok) sent++;
    else {
      const err = await res.json().catch(() => ({}));
      // La persona bloqueó el bot o borró el chat: borramos sus datos
      if (res.status === 403 || /chat not found|user is deactivated/i.test(err.description || "")) {
        await cf(`${ns}/values/${encodeURIComponent(s.key)}`, { method: "DELETE" }).catch(() => {});
        removed++;
      } else console.log(`No se pudo mandar a una persona: ${res.status} ${err.description || ""}`);
      if (res.status === 429) await sleep(((err.parameters?.retry_after) || 5) * 1000);
    }
    await sleep(60); // Telegram permite ~30 mensajes por segundo
  }
  console.log(`Alertas enviadas: ${sent}. Personas que bloquearon el bot (datos borrados): ${removed}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exitCode = 0; });
