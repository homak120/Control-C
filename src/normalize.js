// Turn raw Claude Code transcript lines into display items and session metadata.
//
// The transcript format is internal to Claude Code and changes between versions,
// so every assumption about it lives in this one file.

import { responseCost } from './pricing.js';

const MAX_PROMPT = 20000;
const MAX_TOOL_IO = 4000;

const clip = (s, n) => {
  s = s == null ? '' : String(s);
  return s.length > n ? { text: s.slice(0, n), truncated: s.length - n } : { text: s, truncated: 0 };
};

const blockText = (content) =>
  Array.isArray(content)
    ? content.map((b) => (typeof b === 'string' ? b : b?.text ?? (b?.type === 'image' ? '[image]' : ''))).join('\n')
    : String(content ?? '');

const tag = (s, name) => s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();

/**
 * Normalize one parsed transcript line.
 * Returns display items (possibly none). `meta` collects session-level facts
 * (title, cwd, model, cost…) and is updated in place. Sidechain lines (subagent
 * work) are skipped unless `sidechain` is set, as it is for subagent transcripts.
 */
export function normalizeLine(d, line, meta, { sidechain = false } = {}) {
  const ts = d.timestamp || null;
  const base = { line, ts };
  const items = [];

  if (d.cwd && !meta.cwd) meta.cwd = d.cwd;
  if (d.version) meta.version = d.version;
  if (d.gitBranch && d.gitBranch !== 'HEAD') meta.gitBranch = d.gitBranch;
  if (ts) {
    if (!meta.firstTs || ts < meta.firstTs) meta.firstTs = ts;
    if (!meta.lastTs || ts > meta.lastTs) meta.lastTs = ts;
  }
  if (d.isSidechain && !sidechain) return items;

  switch (d.type) {
    case 'user': {
      const c = d.message?.content;
      if (d.isMeta) break;
      if (d.isCompactSummary) {
        items.push({ ...base, kind: 'compact-summary', ...clip(blockText(c), MAX_PROMPT) });
        break;
      }
      if (typeof c === 'string' || (Array.isArray(c) && !c.some((b) => b?.type === 'tool_result'))) {
        const text = blockText(c);
        const cmd = tag(text, 'command-name');
        if (cmd) {
          items.push({ ...base, kind: 'command', name: cmd, args: tag(text, 'command-args') || '' });
          meta.lastActivity = 'command';
          break;
        }
        if (text.includes('<local-command-stdout>') || text.includes('<local-command-caveat>')) break;
        const images = Array.isArray(c) ? c.filter((b) => b?.type === 'image').length : 0;
        items.push({
          ...base, kind: 'prompt', ...clip(text, MAX_PROMPT), images,
          source: d.promptSource || null, human: d.origin?.kind === 'human',
        });
        meta.prompts = (meta.prompts || 0) + 1;
        meta.lastPrompt = text.slice(0, 200);
        meta.turnOpen = true;
        meta.closed = false;
        break;
      }
      for (const b of c) {
        if (b?.type !== 'tool_result') continue;
        const out = blockText(b.content);
        items.push({ ...base, kind: 'tool_result', toolUseId: b.tool_use_id, isError: !!b.is_error, size: out.length, ...clip(out, MAX_TOOL_IO) });
      }
      break;
    }

    case 'assistant': {
      const m = d.message || {};
      if (m.model && m.model !== '<synthetic>') meta.model = m.model;
      // One API response is split over several lines that repeat the same usage; count it once.
      if (m.id && m.usage && meta._lastMsgId !== m.id) {
        meta._lastMsgId = m.id;
        addUsage(meta, m.model, m.usage);
      }
      for (const b of m.content || []) {
        if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          items.push({ ...base, kind: 'thinking', msgId: m.id, tokens: m.usage?.output_tokens_details?.thinking_tokens ?? null, text: b.thinking || '' });
        } else if (b.type === 'text' && b.text?.trim()) {
          items.push({ ...base, kind: 'text', msgId: m.id, text: b.text });
        } else if (b.type === 'tool_use') {
          const input = b.input || {};
          items.push({
            ...base, kind: 'tool_use', msgId: m.id, id: b.id, name: b.name,
            description: input.description || input.prompt?.slice?.(0, 120) || null,
            summary: toolSummary(b.name, input),
            input: clip(JSON.stringify(input, null, 2), MAX_TOOL_IO).text,
          });
        }
      }
      break;
    }

    case 'system':
      switch (d.subtype) {
        case 'turn_duration':
          items.push({ ...base, kind: 'turn-end', durationMs: d.durationMs, messageCount: d.messageCount });
          meta.turnOpen = false;
          break;
        case 'away_summary':
          items.push({ ...base, kind: 'recap', text: d.content || '' });
          break;
        case 'local_command': {
          const out = tag(d.content || '', 'local-command-stdout');
          if (out) items.push({ ...base, kind: 'command-output', ...clip(out, MAX_TOOL_IO) });
          break;
        }
        case 'compact_boundary':
          items.push({ ...base, kind: 'compact', trigger: d.compactMetadata?.trigger, preTokens: d.compactMetadata?.preTokens, postTokens: d.compactMetadata?.postTokens });
          break;
        case 'informational':
        case 'bridge_status':
          items.push({ ...base, kind: 'notice', level: d.level || 'info', text: d.content || d.subtype });
          break;
      }
      break;

    case 'cost-state':
      meta.costUSD = d.totalCostUSD;
      meta.closed = true;
      meta.turnOpen = false;
      items.push({ ...base, kind: 'session-end', costUSD: d.totalCostUSD, apiMs: d.totalAPIDuration, models: Object.keys(d.modelUsage || {}) });
      break;

    case 'continued-in':
      meta.continuedIn = d.continuedInSessionId;
      items.push({ ...base, kind: 'notice', level: 'info', text: `Continued in session ${d.continuedInSessionId}`, sessionLink: d.continuedInSessionId });
      break;

    case 'ai-title': meta.aiTitle = d.aiTitle; break;
    case 'custom-title': meta.customTitle = d.customTitle; break;
    case 'agent-name': meta.agentName = d.agentName; break;
    case 'permission-mode': meta.permissionMode = d.permissionMode; break;
  }
  return items;
}

// Token totals and a running cost estimate. The exact cost only arrives with the
// cost-state line at exit; until then this is all we have.
function addUsage(meta, model, u) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  meta.outputTokens = (meta.outputTokens || 0) + n(u.output_tokens);
  meta.inputTokens = (meta.inputTokens || 0) + n(u.input_tokens);
  meta.cacheReadTokens = (meta.cacheReadTokens || 0) + n(u.cache_read_input_tokens);
  meta.cacheWriteTokens = (meta.cacheWriteTokens || 0) + n(u.cache_creation_input_tokens);
  if (model === '<synthetic>') return;
  const usd = responseCost(model, u);
  if (usd == null) meta.unpricedResponses = (meta.unpricedResponses || 0) + 1;
  else meta.costEstimateUSD = (meta.costEstimateUSD || 0) + usd;
}

function toolSummary(name, input) {
  switch (name) {
    case 'Bash': return input.command;
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return input.file_path || input.notebook_path;
    case 'Grep': return `${input.pattern}${input.path ? `  in ${input.path}` : ''}`;
    case 'Glob': return input.pattern;
    case 'WebFetch': return input.url;
    case 'WebSearch': return input.query;
    case 'Agent': case 'Task': return input.description || input.subagent_type;
    case 'Skill': return input.skill;
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string');
      return first ? first.slice(0, 200) : null;
    }
  }
}

/** Public shape of a session for the sidebar. */
export function sessionSummary(s) {
  const m = s.meta;
  return {
    id: s.id,
    project: s.projectDir,
    cwd: m.cwd || null,
    title: m.customTitle || m.aiTitle || m.agentName || m.lastPrompt?.slice(0, 80) || null,
    firstTs: m.firstTs || null,
    lastTs: m.lastTs || null,
    lines: s.lineNo,
    bytes: s.offset,
    prompts: m.prompts || 0,
    lastPrompt: m.lastPrompt || null,
    model: m.model || null,
    version: m.version || null,
    gitBranch: m.gitBranch || null,
    costUSD: m.costUSD ?? null,
    costEstimateUSD: m.costEstimateUSD ?? null,
    unpricedResponses: m.unpricedResponses || 0,
    outputTokens: m.outputTokens || 0,
    inputTokens: m.inputTokens || 0,
    cacheReadTokens: m.cacheReadTokens || 0,
    cacheWriteTokens: m.cacheWriteTokens || 0,
    closed: !!m.closed,
    turnOpen: !!m.turnOpen,
    continuedIn: m.continuedIn || null,
    permissionMode: m.permissionMode || null,
    modifiedMs: s.mtimeMs,
  };
}

/**
 * Facts about one subagent, from <session>/subagents/agent-<id>.meta.json and the
 * metadata collected while reading its transcript. `toolUseId` is the parent's
 * Agent/Task tool call that started it.
 */
export function subagentSummary(agentId, metaFile, s) {
  const f = metaFile && typeof metaFile === 'object' ? metaFile : {};
  const str = (v) => (typeof v === 'string' ? v : null);
  return {
    agentId,
    agentType: str(f.agentType),
    description: str(f.description),
    name: str(f.name),
    toolUseId: str(f.toolUseId),
    spawnDepth: Number.isInteger(f.spawnDepth) ? f.spawnDepth : null,
    isFork: f.isFork === true,
    model: s.meta.model || str(f.model),
    firstTs: s.meta.firstTs || null,
    lastTs: s.meta.lastTs || null,
    lines: s.lineNo,
    bytes: s.bytes,
    outputTokens: s.meta.outputTokens || 0,
    costEstimateUSD: s.meta.costEstimateUSD ?? null,
    unpricedResponses: s.meta.unpricedResponses || 0,
  };
}
