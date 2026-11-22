import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveConfigPath } from '../magpie_plugin/lib/backend.mjs';
import { atomicJson, withLock } from './state.mjs';

export function contextPath(config) {
  return join(dirname(resolveConfigPath(config)), 'host-context.json');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readHostContext(config) {
  try {
    const data = JSON.parse(readFileSync(contextPath(config), 'utf8'));
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}

export async function updateHostContext(conversationId, workspacePaths, { parentId, geminiFamily, configPath } = {}) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) return;
  const path = contextPath(configPath);
  try {
    await withLock(join(dirname(path), 'host-context.node.lock'), () => {
      const data = readHostContext(configPath);
      const entries = data.subagent_conversations;
      const children = new Set(Array.isArray(entries) ? entries.filter((entry) => typeof entry === 'string') : []);
      const active = data.conversation_id;
      const workspace = Array.isArray(workspacePaths) ? workspacePaths.filter((entry) => typeof entry === 'string') : [];
      if (parentId) {
        children.add(conversationId);
        if (active === conversationId || !active) {
          const previous = data.previous_context;
          delete data.previous_context;
          const restore = isObject(previous) && !children.has(previous.conversation_id);
          data.conversation_id = (restore && previous.conversation_id) || parentId;
          data.workspace_paths = (restore && previous.workspace_paths) || [];
        }
      } else if (!children.has(conversationId)) {
        if (typeof active === 'string' && active && active !== conversationId) {
          data.previous_context = { conversation_id: active, workspace_paths: data.workspace_paths ?? [] };
        }
        data.conversation_id = conversationId;
        data.workspace_paths = workspace;
      } else {
        return;
      }
      if (typeof geminiFamily === 'string' && geminiFamily.trim()) data.gemini_family = geminiFamily.trim();
      data.updated_at = Date.now() / 1000;
      data.subagent_conversations = [...children].sort();
      atomicJson(path, data);
    });
  } catch {
    // Host context is best-effort so a transient lock or write error cannot block invocation.
  }
}
