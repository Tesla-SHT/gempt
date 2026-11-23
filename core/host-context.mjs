import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveConfigPath } from '../magpie_plugin/lib/backend.mjs';
import { atomicJson, resolvePath, withLock, withinPath } from './state.mjs';

export function contextPath(config) {
  return join(dirname(resolveConfigPath(config)), 'host-context.json');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function workspaceKey(path) {
  if (typeof path !== 'string' || !path.trim()) return null;
  try {
    const resolved = resolvePath(path);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    return null;
  }
}

export function readHostContext(config, cwd) {
  try {
    const data = JSON.parse(readFileSync(contextPath(config), 'utf8'));
    if (!isObject(data)) return {};
    const key = workspaceKey(cwd);
    if (!key) return data;
    const indexed = Object.entries(data.by_workspace || {})
      .filter(([root, context]) => isObject(context) && withinPath(key, root))
      .sort(([left], [right]) => right.length - left.length)[0]?.[1];
    if (indexed) return indexed;
    const roots = Array.isArray(data.workspace_paths) ? data.workspace_paths.map(workspaceKey).filter(Boolean) : [];
    if (roots.some((root) => withinPath(key, root))) return data;
    return !roots.length && !Object.keys(data.by_workspace || {}).length ? data : {};
  } catch {
    return {};
  }
}

export async function updateHostContext(conversationId, workspacePaths, { parentId, geminiFamily, configPath } = {}) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) return;
  const path = contextPath(configPath);
  try {
    await withLock(join(dirname(path), 'host-context.lock'), () => {
      const data = readHostContext(configPath);
      const entries = data.subagent_conversations;
      const children = new Set(Array.isArray(entries) ? entries.filter((entry) => typeof entry === 'string') : []);
      const active = data.conversation_id;
      let workspace = Array.isArray(workspacePaths) ? workspacePaths.filter((entry) => typeof entry === 'string') : [];
      const byWorkspace = data.by_workspace = isObject(data.by_workspace) ? data.by_workspace : {};
      // Seed legacy state before the first update can replace the global workspace.
      for (const key of (Array.isArray(data.workspace_paths) ? data.workspace_paths : []).map(workspaceKey)) {
        if (key && !byWorkspace[key] && active && !children.has(active)) {
          byWorkspace[key] = { conversation_id: active, workspace_paths: data.workspace_paths,
            gemini_family: data.gemini_family, updated_at: data.updated_at };
        }
      }
      const updatedAt = Date.now() / 1000;
      if (parentId) {
        children.add(conversationId);
        for (const [key, context] of Object.entries(byWorkspace)) {
          if (context.conversation_id !== conversationId) continue;
          if (context.previous_context && !children.has(context.previous_context.conversation_id)) {
            byWorkspace[key] = context.previous_context;
          } else {
            delete byWorkspace[key];
          }
        }
        if (active === conversationId || !active) {
          const previous = data.previous_context;
          delete data.previous_context;
          const restore = isObject(previous) && !children.has(previous.conversation_id);
          const parent = (restore && previous) || Object.values(byWorkspace).find((ctx) => ctx.conversation_id === parentId);
          data.conversation_id = parent?.conversation_id || parentId;
          data.workspace_paths = parent?.workspace_paths || [];
          if (parent?.gemini_family) data.gemini_family = parent.gemini_family;
          else delete data.gemini_family;
        }
      } else if (!children.has(conversationId)) {
        const contexts = Object.values(byWorkspace).filter(isObject);
        const sameConversation = contexts.find((ctx) => ctx.conversation_id === conversationId)
          || (active === conversationId ? data : contexts.map((ctx) => ctx.previous_context)
            .find((ctx) => ctx?.conversation_id === conversationId));
        if (!workspace.length && Array.isArray(sameConversation?.workspace_paths)) workspace = sameConversation.workspace_paths;
        const keys = [...new Set(workspace.map(workspaceKey).filter(Boolean))];
        const family = typeof geminiFamily === 'string' ? geminiFamily.trim() : '';
        const snapshot = { conversation_id: conversationId, workspace_paths: workspace, updated_at: updatedAt };
        snapshot.gemini_family = family || sameConversation?.gemini_family;
        if (typeof active === 'string' && active && active !== conversationId) {
          data.previous_context = { conversation_id: active, workspace_paths: data.workspace_paths ?? [],
            gemini_family: data.gemini_family };
        }
        for (const key of keys) {
          const previous = byWorkspace[key];
          const restore = previous?.conversation_id === conversationId ? previous.previous_context : previous;
          byWorkspace[key] = { ...snapshot,
            ...(restore ? { previous_context: { ...restore, previous_context: undefined } } : {}) };
        }
        Object.assign(data, snapshot);
      } else {
        return;
      }
      data.updated_at = updatedAt;
      data.subagent_conversations = [...children].sort();
      atomicJson(path, data);
    });
  } catch {
    // Host context is best-effort so a transient lock or write error cannot block invocation.
  }
}
