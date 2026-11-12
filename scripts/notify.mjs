// Open Seat — manda a Telegram los avisos nuevos de la última actualización
// Lo corre el workflow "Actualizar avisos" después de traer los avisos.
//
// Necesita dos secretos del repo (Settings → Secrets and variables → Actions):
//   TELEGRAM_BOT_TOKEN  el token que da @BotFather
//   TELEGRAM_CHAT_ID    el canal, por ejemplo @openseat_diseno
// Si no están configurados, no hace nada.
//
// Qué manda: los avisos que aparecieron por primera vez en esta corrida,
// de los roles de CHANNEL_ROLES, que no estén cerrados para Argentina.
// Va un solo mensaje por corrida (un resumen), no uno por aviso.

import { readFile } from "node:fs/promises";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const SITE = process.env.SITE_URL || "https://lalapicoroso.github.io/open-seat/";
const CHANNEL_ROLES = (process.env.CHANNEL_ROLES || "pd,uxui,research").split(",").map(s => s.trim());
const MAX_ITEMS = 15;

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function pickNew(data, roles = CHANNEL_ROLES) {
  return (data.jobs || [])
    .filter(j => j.firstSeen && j.firstSeen === data.updatedAt)
    .filter(j => roles.includes(j.role))
    .filter(j => j.ar !== false)
    .sort((a, b) => (b.ar === true) - (a.ar === true));
}

export function formatMessage(jobs, site = SITE) {
  const shown = jobs.slice(0, MAX_ITEMS);
  const lines = [`<b>${jobs.length === 1 ? "1 aviso nuevo" : `${jobs.length} avisos nuevos`} de diseño y UX</b>`, ""];
  for (const j of shown) {
    const where = j.ar === true ? "🟢 Desde Argentina" : "🟡 No aclara países";
    lines.push(`<a href="${esc(j.url)}">${esc(j.t)}</a>`);
    lines.push(`${esc(j.c)} · ${esc(j.mod)} · ${where}`);
    lines.push("");
  }
  if (jobs.length > shown.length) lines.push(`Y ${jobs.length - shown.length} más.`);
  lines.push(`<a href="${esc(site)}">Ver todos en Open Seat</a>`);
  return lines.join("\n");
}

async function main() {
  if (!TOKEN || !CHAT) { console.log("Telegram no está configurado; no se envía nada."); return; }
  const data = JSON.parse(await readFile(new URL("../data/jobs.json", import.meta.url), "utf8"));
  const jobs = pickNew(data);
  if (!jobs.length) { console.log("No hay avisos nuevos para el canal."); return; }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text: formatMessage(jobs), parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) throw new Error(`Telegram respondió ${res.status}: ${out.description || "sin detalle"}`);
  console.log(`Enviado a Telegram: ${jobs.length} avisos nuevos.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
