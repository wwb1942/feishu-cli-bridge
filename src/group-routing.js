import crypto from 'node:crypto';

const LEADING_TASK_RE = /^\s*\[task:([a-z0-9_-]+)\]\s*/i;
const LEADING_DELEGATE_RE = /^\s*\[delegate\]\s*\[task:([a-z0-9_-]+)\]\s*/i;

function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function extractDelegateTaskId(text = '') {
  return text.match(LEADING_DELEGATE_RE)?.[1] || '';
}

export function extractLeadingTaskId(text = '') {
  return text.match(LEADING_TASK_RE)?.[1] || '';
}

export function extractTaskId(text = '') {
  return extractLeadingTaskId(text);
}

export function isDelegateMessage(text = '') {
  return LEADING_DELEGATE_RE.test(text);
}

export function generateTaskId() {
  return crypto.randomUUID().slice(0, 8).toLowerCase();
}

export function getMentionTargets(input = {}) {
  return unique(input.mentionOpenIds || []);
}

export function selectDiscussionHostBotOpenId(input = {}) {
  const mentionOpenIds = getMentionTargets(input);
  if (mentionOpenIds.length === 0) {
    return '';
  }

  if (input.discussionHostBotOpenId && mentionOpenIds.includes(input.discussionHostBotOpenId)) {
    return input.discussionHostBotOpenId;
  }

  if (input.mentionOrderReliable === false) {
    return [...mentionOpenIds].sort((left, right) => left.localeCompare(right))[0] || '';
  }

  return mentionOpenIds[0] || '';
}

function classifyGroupUserMessage(input) {
  const mentionOpenIds = getMentionTargets(input);
  const hostBotOpenId = mentionOpenIds.length > 1
    ? selectDiscussionHostBotOpenId(input)
    : '';

  if (!mentionOpenIds.includes(input.selfBotOpenId)) {
    return { kind: 'ignore', taskId: '', hostBotOpenId };
  }

  if (mentionOpenIds.length > 1) {
    if (input.selfBotOpenId === hostBotOpenId) {
      return { kind: 'group_discussion_request', taskId: '', hostBotOpenId };
    }
    return { kind: 'ignore', taskId: '', hostBotOpenId };
  }

  return { kind: 'group_user_request', taskId: '', hostBotOpenId: '' };
}

function classifyGroupAssistantMessage(input) {
  const mentionsSelf = getMentionTargets(input).includes(input.selfBotOpenId);
  const delegateTaskId = extractDelegateTaskId(input.text || '');
  if (mentionsSelf && delegateTaskId) {
    return {
      kind: 'group_delegate_request',
      taskId: delegateTaskId,
      hostBotOpenId: '',
    };
  }

  const taskId = extractLeadingTaskId(input.text || '');
  if (taskId && input.pendingTask?.taskId === taskId) {
    return {
      kind: 'group_delegate_result',
      taskId,
      hostBotOpenId: '',
    };
  }

  return { kind: 'ignore', taskId: '', hostBotOpenId: '' };
}

export function classifyInboundMessage(input = {}) {
  if (input.chatType !== 'group') {
    return {
      kind: 'direct_dm_request',
      taskId: extractLeadingTaskId(input.text || ''),
      hostBotOpenId: '',
    };
  }

  if (input.senderType === 'USER') {
    return classifyGroupUserMessage(input);
  }

  if (input.senderType === 'ASSISTANT') {
    return classifyGroupAssistantMessage(input);
  }

  return { kind: 'ignore', taskId: '', hostBotOpenId: '' };
}

export function buildSessionKey(input = {}) {
  if (input.kind === 'group_discussion_request') {
    return `group:${input.chatId}:discussion:${input.taskId}:host:${input.selfBotOpenId}`;
  }

  if (input.kind === 'group_delegate_request' || input.kind === 'group_delegate_result') {
    return `group:${input.chatId}:task:${input.taskId}:bot:${input.selfBotOpenId}`;
  }

  if (input.kind === 'group_user_request') {
    return `group:${input.chatId}:user:${input.senderOpenId}:bot:${input.selfBotOpenId}`;
  }

  return `dm:${input.senderOpenId}`;
}
