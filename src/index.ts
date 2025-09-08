// Cloudflare Worker – WinGet REST 1.9.0 (solo lectura)
// Lee los manifiestos "singleton" desde 0GMou/D4RKO-WINGET y expone los endpoints
// /information, POST /manifestSearch, /packageManifests, y /packages/*
// Ajustado al OpenAPI 1.9.0. No requiere base de datos.

import YAML from "yaml";

// ---------- CONFIG ----------
const OWNER = "0GMou";
const WINGET_REPO = "D4RKO-WINGET";
const PACKAGE_IDENTIFIER = "d4rko.mpv";
const PUBLISHER = "D4RKO";
const BASE_DIR = "manifests/d/d4rko/d4rko.mpv";
const GH_API = `https://api.github.com/repos/${OWNER}/${WINGET_REPO}/contents/${BASE_DIR}`;
const GH_RAW = (version: string) =>
  `https://raw.githubusercontent.com/${OWNER}/${WINGET_REPO}/main/${BASE_DIR}/${version}/${PACKAGE_IDENTIFIER}.yaml`;

const GH_HEADERS = {
  "user-agent": "d4rko-rest",
  "accept": "application/vnd.github+json"
};

// Importante: anunciamos varias versiones para negociar con clientes anteriores
const SUPPORTED_API_VERSIONS = [
  "1.0.0","1.1.0","1.2.0","1.3.0","1.4.0",
  "1.5.0","1.6.0","1.7.0","1.8.0","1.9.0"
];

// ---------- RESPUESTAS ----------
function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=120",
      ...headers,
    },
  });
}

function notFound(msg = "Not Found") {
  return json({ ErrorCode: "NotFound", Message: msg }, 404);
}

function badRequest(msg = "Bad Request") {
  return json({ ErrorCode: "BadRequest", Message: msg }, 400);
}

// ---------- UTIL ----------
function bySemverDesc(a: string, b: string) {
  const pa = a.split(".").map((s) => parseInt(s, 10));
  const pb = b.split(".").map((s) => parseInt(s, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return vb - va;
  }
  return 0;
}

async function listVersions(): Promise<string[]> {
  const r = await fetch(GH_API, { headers: GH_HEADERS });
  if (!r.ok) {
    if (r.status === 403) return []; // rate limit → devolvemos vacío
    throw new Error(`GitHub API error: ${r.status}`);
  }
  const items: Array<{ name: string; type: string }> = await r.json();
  const versions = items.filter((i) => i.type === "dir").map((i) => i.name);
  versions.sort(bySemverDesc);
  return versions;
}

async function loadSingleton(version: string): Promise<any> {
  const r = await fetch(GH_RAW(version), { headers: GH_HEADERS });
  if (!r.ok) throw new Error(`RAW not found for ${version}: ${r.status}`);
  const text = await r.text();
  return YAML.parse(text);
}

// Installer[] desde un singleton ZIP portable (esquema soportado 1.6/1.9).
function toInstallers(m: any): any[] {
  const installers = Array.isArray(m.Installers) ? m.Installers : [];
  const topInstallerType = m.InstallerType;
  const topNestedType = m.NestedInstallerType;
  const topNestedFiles = m.NestedInstallerFiles;

  return installers.map((ins: any, idx: number) => {
    const item: any = {
      InstallerIdentifier:
