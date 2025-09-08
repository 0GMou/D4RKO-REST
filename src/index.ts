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
      InstallerIdentifier: `${m.PackageIdentifier}-${m.PackageVersion}-${idx + 1}`,
      InstallerSha256: ins.InstallerSha256,
      InstallerUrl: ins.InstallerUrl,
      Architecture: ins.Architecture,
      InstallerType: ins.InstallerType ?? topInstallerType,
    };
    const nestedType = ins.NestedInstallerType ?? topNestedType;
    const nestedFiles = ins.NestedInstallerFiles ?? topNestedFiles;
    if (nestedType) item.NestedInstallerType = nestedType;
    if (nestedFiles) item.NestedInstallerFiles = nestedFiles;
    return item;
  });
}

// Locales[] (opcional en respuesta REST)
function toLocales(m: any): any[] | undefined {
  if (!m.PackageLocale) return undefined;
  const loc: any = {
    PackageLocale: m.PackageLocale,
    Publisher: m.Publisher ?? PUBLISHER,
    PackageName: m.PackageName ?? "MPV",
  };
  if (m.ShortDescription) loc.ShortDescription = m.ShortDescription;
  if (m.PublisherUrl) loc.PublisherUrl = m.PublisherUrl;
  if (m.PackageUrl) loc.PackageUrl = m.PackageUrl;
  if (m.ReleaseNotes) loc.ReleaseNotes = m.ReleaseNotes;
  if (m.ReleaseNotesUrl) loc.ReleaseNotesUrl = m.ReleaseNotesUrl;
  return [loc];
}

// /information (según OpenAPI 1.9.0)
function informationResponse() {
  return {
    Data: {
      SourceIdentifier: "D4RKO",
      ServerSupportedVersions: SUPPORTED_API_VERSIONS,
      Authentication: { AuthenticationType: "none" },
      UnsupportedPackageMatchFields: [],
      RequiredPackageMatchFields: [],
      UnsupportedQueryParameters: [],
      RequiredQueryParameters: [],
      SourceAgreements: [],
    },
  };
}

function manifestSingle(m: any) {
  const version = {
    PackageVersion: m.PackageVersion,
    Installers: toInstallers(m),
    ...(toLocales(m) ? { Locales: toLocales(m) } : {}),
  };
  return {
    Data: { PackageIdentifier: m.PackageIdentifier, Versions: [version] },
  };
}

function manifestMultiple(multi: any[]) {
  return {
    Data: multi.map((m) => ({
      PackageIdentifier: m.PackageIdentifier,
      Versions: [
        {
          PackageVersion: m.PackageVersion,
          Installers: toInstallers(m),
          ...(toLocales(m) ? { Locales: toLocales(m) } : {}),
        },
      ],
    })),
  };
}

function searchResult(versions: string[], pkgName: string) {
  return {
    Data: [
      {
        PackageIdentifier: PACKAGE_IDENTIFIER,
        PackageName: pkgName,
        Publisher: PUBLISHER,
        Versions: versions.map((v) => ({ PackageVersion: v })),
      },
    ],
    RequiredPackageMatchFields: [],
    UnsupportedPackageMatchFields: [],
  };
}

// ---------- HANDLERS ----------
async function handleInformation() {
  return json(informationResponse());
}

async function handleManifestSearch(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* vacío */ }

  const maxResults: number | undefined = body?.MaximumResults;
  const key: string | undefined = body?.Query?.KeyWord;

  if (key && !/mpv|d4rko\.mpv/i.test(key)) {
    return json({ Data: [], RequiredPackageMatchFields: [], UnsupportedPackageMatchFields: [] });
  }

  const versions = await listVersions();
  if (versions.length === 0) return json({ Data: [] }); // rate limit o vacío

  const cut = maxResults && maxResults > 0 ? versions.slice(0, maxResults) : [versions[0]];
  const m = await loadSingleton(versions[0]);
  const pkgName = m.PackageName ?? "MPV";
  return json(searchResult(cut, pkgName));
}

async function handlePackageManifestsAll() {
  const versions = await listVersions();
  const manifests = await Promise.all(versions.map((v) => loadSingleton(v)));
  return json(manifestMultiple(manifests));
}

async function handlePackageManifestsById(id: string) {
  if (id.toLowerCase() !== PACKAGE_IDENTIFIER) return notFound("Unknown PackageIdentifier");
  const versions = await listVersions();
  if (versions.length === 0) return notFound("No versions");
  const manifests = await Promise.all(versions.map((v) => loadSingleton(v)));
  return json(manifestMultiple(manifests));
}

async function handlePackages() {
  return json({ Data: [{ PackageIdentifier: PACKAGE_IDENTIFIER }] });
}

async function handlePackagesById(id: string) {
  if (id.toLowerCase() !== PACKAGE_IDENTIFIER) return notFound("Unknown PackageIdentifier");
  return json({ Data: { PackageIdentifier: PACKAGE_IDENTIFIER } });
}

async function handleVersionsById(id: string) {
  if (id.toLowerCase() !== PACKAGE_IDENTIFIER) return notFound("Unknown PackageIdentifier");
  const versions = await listVersions();
  return json({ Data: versions.map((v) => ({ PackageVersion: v })) });
}

async function handleVersionDetail(id: string, ver: string) {
  if (id.toLowerCase() !== PACKAGE_IDENTIFIER) return notFound("Unknown PackageIdentifier");
  const m = await loadSingleton(ver).catch(() => null);
  if (!m) return notFound("Version not found");
  return json({ Data: { PackageIdentifier: PACKAGE_IDENTIFIER, PackageVersion: ver } });
}

async function handleInstallers(id: string, ver: string) {
  if (id.toLowerCase() !== PACKAGE_IDENTIFIER) return notFound("Unknown PackageIdentifier");
  const m = await loadSingleton(ver).catch(() => null);
  if (!m) return notFound("Version not found");
  return json({ Data: toInstallers(m) });
}

async function handleLocales(id: string, ver: string) {
  if (id.toLowerCase() !== PACKAGE_IDENTIFIER) return notFound("Unknown PackageIdentifier");
  const m = await loadSingleton(ver).catch(() => null);
  if (!m) return notFound("Version not found");
  const l = toLocales(m);
  return json({ Data: l ?? [] });
}

// ---------- ROUTER ----------
export default {
  async fetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const pathname = url.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "GET" && pathname === "/information") return handleInformation();
      if (req.method === "POST" && pathname === "/manifestSearch") return handleManifestSearch(req);
      if (req.method === "GET" && pathname === "/packageManifests") return handlePackageManifestsAll();

      let m = pathname.match(/^\/packageManifests\/([^/]+)$/);
      if (req.method === "GET" && m) return handlePackageManifestsById(m[1]);

      if (req.method === "GET" && pathname === "/packages") return handlePackages();
      m = pathname.match(/^\/packages\/([^/]+)$/);
      if (req.method === "GET" && m) return handlePackagesById(m[1]);

      m = pathname.match(/^\/packages\/([^/]+)\/versions$/);
      if (req.method === "GET" && m) return handleVersionsById(m[1]);

      m = pathname.match(/^\/packages\/([^/]+)\/versions\/([^/]+)$/);
      if (req.method === "GET" && m) return handleVersionDetail(m[1], m[2]);

      m = pathname.match(/^\/packages\/([^/]+)\/versions\/([^/]+)\/installers$/);
      if (req.method === "GET" && m) return handleInstallers(m[1], m[2]);

      m = pathname.match(/^\/packages\/([^/]+)\/versions\/([^/]+)\/locales$/);
      if (req.method === "GET" && m) return handleLocales(m[1], m[2]);

      return notFound();
    } catch (e: any) {
      return json({ ErrorCode: "ServerError", Message: e?.message ?? "Unhandled error" }, 500);
    }
  },
};
