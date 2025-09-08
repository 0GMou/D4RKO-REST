// Cloudflare Worker — WinGet REST (solo lectura) para D4RKO
// Expone manifests Singleton desde 0GMou/D4RKO-WINGET cumpliendo la REST de WinGet.

import YAML from "yaml";

// ---------- Config ----------
const OWNER = "0GMou";
const WINGET_REPO = "D4RKO-WINGET";
const PACKAGE_IDENTIFIER = "d4rko.mpv";
const PUBLISHER = "D4RKO";
const BASE_DIR = "manifests/d/d4rko/d4rko.mpv";

// GitHub
const GH_API = `https://api.github.com/repos/${OWNER}/${WINGET_REPO}/contents/${BASE_DIR}`;
const GH_RAW = (version: string) =>
  `https://raw.githubusercontent.com/${OWNER}/${WINGET_REPO}/main/${BASE_DIR}/${version}/${PACKAGE_IDENTIFIER}.yaml`;
const GH_HEADERS = { "user-agent": "d4rko-rest", accept: "application/vnd.github+json" };

// Versiones REST anunciadas (cliente 1.12 negocia 1.10.0 sin problema)
const SUPPORTED_API_VERSIONS = [
  "1.0.0","1.1.0","1.2.0","1.3.0","1.4.0","1.5.0","1.6.0","1.7.0","1.8.0","1.9.0","1.10.0"
];

// ---------- Helpers de respuesta ----------
function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=120", ...headers },
  });
}
function notFound(msg = "Not Found") { return json({ ErrorCode: "NotFound", Message: msg }, 404); }

// ---------- Util ----------
function bySemverDesc(a: string, b: string) {
  const pa = a.split(".").map((s) => parseInt(s, 10));
  const pb = b.split(".").map((s) => parseInt(s, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0, vb = pb[i] ?? 0;
    if (va !== vb) return vb - va;
  }
  return 0;
}
async function listVersions(): Promise<string[]> {
  const r = await fetch(GH_API, { headers: GH_HEADERS });
  if (!r.ok) { if (r.status === 403) return []; throw new Error(`GitHub API error: ${r.status}`); }
  const items: Array<{ name: string; type: string }> = await r.json();
  const versions = items.filter(i => i.type === "dir").map(i => i.name);
  versions.sort(bySemverDesc);
  return versions;
}
async function loadSingleton(version: string): Promise<any> {
  const r = await fetch(GH_RAW(version), { headers: GH_HEADERS });
  if (!r.ok) throw new Error(`RAW not found for ${version}: ${r.status}`);
  return YAML.parse(await r.text());
}

function buildDefaultLocale(m: any) {
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
  if (m.License) loc.License = m.License;
  if (m.LicenseUrl) loc.LicenseUrl = m.LicenseUrl;
  if (m.PrivacyUrl) loc.PrivacyUrl = m.PrivacyUrl;
  if (m.Author) loc.Author = m.Author;
  if (m.Tags) loc.Tags = m.Tags;
  return loc;
}
function toLocales(m: any): any[] | undefined {
  if (!m.PackageLocale) return undefined; // singleton puede no tener Locales extra
  // Para sencillo: usamos el mismo bloque como único Locale si no hay más
  return [buildDefaultLocale(m)];
}
function toInstallers(m: any): any[] {
  const installers = Array.isArray(m.Installers) ? m.Installers : [];
  const topType = m.InstallerType, topNested = m.NestedInstallerType, topFiles = m.NestedInstallerFiles;
  return installers.map((ins: any, i: number) => {
    const item: any = {
      InstallerIdentifier: `${m.PackageIdentifier}-${m.PackageVersion}-${i + 1}`,
      InstallerSha256: ins.InstallerSha256,
      InstallerUrl: ins.InstallerUrl,
      Architecture: ins.Architecture,
      InstallerType: ins.InstallerType ?? topType,
    };
    const nestedType = ins.NestedInstallerType ?? topNested;
    const nestedFiles = ins.NestedInstallerFiles ?? topFiles;
    if (nestedType) item.NestedInstallerType = nestedType;
    if (nestedFiles) item.NestedInstallerFiles = nestedFiles;
    if (ins.Scope) item.Scope = ins.Scope;
    if (ins.InstallerLocale) item.InstallerLocale = ins.InstallerLocale;
    return item;
  });
}

// /information (sin SourceAgreements si no hay acuerdos)
function informationResponse() {
  return {
    Data: {
      SourceIdentifier: "D4RKO",
      ServerSupportedVersions: SUPPORTED_API_VERSIONS,
      Authentication: { AuthenticationType: "none" },
      UnsupportedPackageMatchFields: [],
      RequiredPackageMatchFields: [],
      UnsupportedQueryParameters: [],
      RequiredQueryParameters: []
    },
  };
}

// Respuesta “multi-paquete” (no la usa el cliente para instalar, pero la dejamos correcta)
function manifestMultiple(multi: any[]) {
  return {
    Data: multi.map(m => ({
      PackageIdentifier: m.PackageIdentifier,
      Versions: [{
        PackageVersion: m.PackageVersion,
        DefaultLocale: buildDefaultLocale(m),
        Installers: toInstallers(m),
        ...(toLocales(m) ? { Locales: toLocales(m) } : {})
      }]
    })),
  };
}

// Respuesta “by id” (la que usa el cliente para resolver el paquete)
function manifestSingle(pkgId: string, manifests: any[]) {
  return {
    Data: {
      PackageIdentifier: pkgId,
      Versions: manifests.map(m => ({
        PackageVersion: m.PackageVersion,
        DefaultLocale: buildDefaultLocale(m),
        Installers: toInstallers(m),
        ...(toLocales(m) ? { Locales: toLocales(m) } : {})
      }))
    }
  };
}

// ---------- Handlers ----------
async function handleInformation() { return json(informationResponse()); }

async function handleManifestSearch(req: Request) {
  let body: any = {};
  if (req.method === "POST") { try { body = await req.json(); } catch {} }
  const maxResults: number | undefined = body?.MaximumResults;
  const key: string | undefined = body?.Query?.KeyWord;

  if (key && !/mpv|d4rko\.mpv/i.test(key)) {
    return json({ Data: [], RequiredPackageMatchFields: [], UnsupportedPackageMatchFields: [] });
  }

  const versions = await listVersions();
  if (versions.length === 0) return json({ Data: [] });
  const cut = maxResults && maxResults > 0 ? versions.slice(0, maxResults) : [versions[0]];
  const m = await loadSingleton(versions[0]);
  const pkgName = m.PackageName ?? "MPV";

  return json({
    Data: [{
      PackageIdentifier: PACKAGE_IDENTIFIER,
      PackageName: pkgName,
      Publisher: PUBLISHER,
      Versions: cut.map(v => ({ PackageVersion: v })),
    }],
    RequiredPackageMatchFields: [],
    UnsupportedPackageMatchFields: [],
  });
}

async function handlePackageManifestsAll() {
  const versions = await listVersions();
  const manifests = await Promise.all(versions.map(v => loadSingleton(v)));
  return json(manifestMultiple(manifests));
}

async function handlePackageManifestsById(id: string) {
  if (id.toLowerCase() !== PACKAGE_IDENTIFIER) return notFound("Unknown PackageIdentifier");
  const versions = await listVersions();
  if (versions.length === 0) return notFound("No versions");
  const manifests = await Promise.all(versions.map(v => loadSingleton(v)));
  return json(manifestSingle(PACKAGE_IDENTIFIER, manifests));
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
  return json({ Data: versions.map(v => ({ PackageVersion: v })) });
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

// ---------- Router & normalización ----------
function normalizePath(pathname: string) {
  let p = pathname.replace(/\/+$/, ""); if (p === "") p = "/";
  if (p === "/api") p = "/"; else if (p.startsWith("/api/")) p = p.slice(4) || "/";
  const vm = p.match(/^\/v\d+(\.\d+)?(\/.*)?$/); if (vm) p = p.replace(/^\/v\d+(\.\d+)?/, "") || "/";
  return p === "" ? "/" : p;
}

export default {
  async fetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const method = req.method === "HEAD" ? "GET" : req.method;
      const pathname = normalizePath(url.pathname);

      if (method === "GET" && pathname === "/") return handleInformation();
      if (method === "GET" && pathname === "/information") return handleInformation();
      if ((method === "POST" || method === "GET") && pathname === "/manifestSearch") return handleManifestSearch(req);

      if (method === "GET" && pathname === "/packageManifests") return handlePackageManifestsAll();
      let m = pathname.match(/^\/packageManifests\/([^/]+)$/);
      if (method === "GET" && m) return handlePackageManifestsById(m[1]);

      if (method === "GET" && pathname === "/packages") return handlePackages();
      m = pathname.match(/^\/packages\/([^/]+)$/);
      if (method === "GET" && m) return handlePackagesById(m[1]);
      m = pathname.match(/^\/packages\/([^/]+)\/versions$/);
      if (method === "GET" && m) return handleVersionsById(m[1]);
      m = pathname.match(/^\/packages\/([^/]+)\/versions\/([^/]+)$/);
      if (method === "GET" && m) return handleVersionDetail(m[1], m[2]);
      m = pathname.match(/^\/packages\/([^/]+)\/versions\/([^/]+)\/installers$/);
      if (method === "GET" && m) return handleInstallers(m[1], m[2]);
      m = pathname.match(/^\/packages\/([^/]+)\/versions\/([^/]+)\/locales$/);
      if (method === "GET" && m) return handleLocales(m[1], m[2]);

      return notFound();
    } catch (e: any) {
      return json({ ErrorCode: "ServerError", Message: e?.message ?? "Unhandled error" }, 500);
    }
  },
};
