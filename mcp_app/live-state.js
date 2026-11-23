function cwdBaseUrl(cwd) {
  const raw = String(cwd || "").trim().replaceAll("\\", "/");
  if (!raw || /[\x00-\x1f\x7f]/.test(raw) || raw.startsWith("//")) return null;
  if (/^[a-z]:(?:\/|$)/i.test(raw)) {
    const drive = raw.slice(0, 2);
    const rest = raw.slice(2).split("/").filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
    return new URL(`file:///${drive}/${rest ? `${rest}/` : ""}`);
  }
  if (raw.startsWith("/")) {
    const rest = raw.split("/").filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
    return new URL(`file:///${rest ? `${rest}/` : ""}`);
  }
  return null;
}

function normalizeFileUrl(value) {
  if (!/^file:\/\//i.test(value)) return null;
  const url = new URL(value);
  return url.protocol === "file:" && !url.hostname && !url.username && !url.password ? url : null;
}

function splitHrefHash(value) {
  const hashIndex = value.indexOf("#");
  if (hashIndex < 0) return { path: value, hash: "" };
  return { path: value.slice(0, hashIndex), hash: value.slice(hashIndex) };
}

function approvedFileUri(target, fileUris) {
  if (!fileUris || typeof fileUris !== "object") return null;
  const { path, hash } = splitHrefHash(target);
  const direct = Object.hasOwn(fileUris, target) ? fileUris[target]
    : (Object.hasOwn(fileUris, path) ? fileUris[path] : null);
  if (typeof direct === "string") {
    const url = normalizeFileUrl(direct);
    if (!url) return null;
    if (hash && !url.hash) url.hash = hash;
    return { kind: "file", value: url.href };
  }
  if (/^file:\/\//i.test(target)) {
    const candidate = normalizeFileUrl(target);
    if (!candidate) return null;
    const baseHref = candidate.href.slice(0, candidate.href.length - candidate.hash.length);
    for (const uri of Object.values(fileUris)) {
      if (typeof uri !== "string") continue;
      const allowed = normalizeFileUrl(uri);
      if (!allowed) continue;
      const allowedBase = allowed.href.slice(0, allowed.href.length - allowed.hash.length);
      if (allowedBase === baseHref) return { kind: "file", value: candidate.href };
    }
  }
  return null;
}

function isStrictRelativeFileUrl(url, baseUrl) {
  if (url.protocol !== "file:" || url.hostname || url.username || url.password || url.search) return false;
  const basePath = baseUrl.pathname;
  const candidatePath = url.pathname;
  const windowsBase = /^\/[a-z]:\//i.test(basePath);
  const matchesPrefix = windowsBase
    ? candidatePath.slice(0, basePath.length).toLowerCase() === basePath.toLowerCase()
    : candidatePath.startsWith(basePath);
  if (!matchesPrefix || candidatePath.length <= basePath.length) return false;
  const rel = candidatePath.slice(basePath.length);
  for (const segment of rel.split("/")) {
    if (!segment) continue;
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { return false; }
    if (!decoded || decoded === "." || decoded === ".." || /[\\/\x00-\x1f\x7f]/.test(decoded)) return false;
    if (/^[a-z]:/i.test(decoded)) return false;
  }
  return true;
}

export function linkTarget(value, cwd, options = {}) {
  if (typeof value !== "string") return null;
  const target = value.trim();
  if (!target || target.startsWith("#") || /[\x00-\x1f\x7f]/.test(target)) return null;
  try {
    if (/^https?:\/\//i.test(target)) {
      const url = new URL(target);
      return url.username || url.password ? null : { kind: "web", value: url.href };
    }
    if (options?.approved) {
      const url = normalizeFileUrl(target);
      return url ? { kind: "file", value: url.href } : null;
    }
    const approved = approvedFileUri(target, options?.fileUris);
    if (approved) return approved;
    if (/^[a-z]:/i.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target) || /^[\\/]/.test(target)) {
      return null;
    }
    const baseUrl = cwdBaseUrl(cwd);
    if (!baseUrl) return null;
    const normalized = target.replaceAll("\\", "/");
    if (normalized.startsWith("/")) return null;
    const url = new URL(normalized, baseUrl);
    return isStrictRelativeFileUrl(url, baseUrl) ? { kind: "file", value: url.href } : null;
  } catch {
    return null;
  }
}

// Timeline messages are bounded previews of the combined transcript. Recover their
// boundaries when they are unambiguous, otherwise render the complete text once.
export function timelineMessages(timeline, fullText) {
  const messages = timeline.filter((event) => event.type === "agent_message" && event.text);
  if (!fullText) return new Map(messages.map((event) => [event, event.text]));
  if (messages.length === 1) return new Map([[messages[0], fullText]]);
  const fallback = () => new Map([[messages.at(-1), fullText]]);
  if (!messages.length || !fullText.startsWith(messages[0].text)) return fallback();
  let start = 0;
  const result = new Map();
  for (let index = 1; index < messages.length; index++) {
    const preview = messages[index].text;
    const marker = `\n\n${preview}`;
    const boundary = fullText.indexOf(marker, start + messages[index - 1].text.length);
    if (boundary < 0 || fullText.indexOf(marker, boundary + 2) >= 0) return fallback();
    result.set(messages[index - 1], fullText.slice(start, boundary));
    start = boundary + 2;
  }
  result.set(messages.at(-1), fullText.slice(start));
  return result;
}

export function streamRenderKey(
  runId, state, events, fileUris, transcript, pendingCall, hasSnapshot,
  restrictedFiles = null, remoteTurnUnconfirmed = false,
) {
  return JSON.stringify([runId, state, events, fileUris, transcript, pendingCall, hasSnapshot, restrictedFiles, remoteTurnUnconfirmed]);
}

export function listArguments(scope, lockedConversation, offset = 0) {
  return { scope, limit: 50, ...(offset ? { offset } : {}),
    ...(scope === "session" && lockedConversation ? { host_conversation_id: lockedConversation } : {}) };
}
