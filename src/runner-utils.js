const MEDIA_MARKER_RE = /^\[\[(image|file):(.+?)\]\]$/i;
const DDS_TASK_RE = /dds|creditease\.corp/i;

function buildHistoryText(history) {
  return history
    .map((entry) => `${entry.role === 'assistant' ? 'Assistant' : 'User'}: ${entry.text}`)
    .join('\n\n');
}

function buildAttachmentSummary(attachments) {
  if (!attachments?.length) {
    return '(none)';
  }
  return attachments
    .map((attachment, index) => (
      `${index + 1}. type=${attachment.kind} path=${attachment.path}${attachment.fileName ? ` fileName=${attachment.fileName}` : ''}`
    ))
    .join('\n');
}

function buildTaskExecutionHints(inbound) {
  const text = inbound?.text || '';
  if (!DDS_TASK_RE.test(text)) {
    return [];
  }

  return [
    'DDS task instructions:',
    '1. Before any DDS browser interaction, run D:\\tools\\dds2-open.cmd to reuse the persistent DDS browser profile with saved login state.',
    '2. After that, use D:\\tools\\playwright-cli.cmd commands against the already-open DDS browser session.',
    '3. Do not create a fresh in-memory Playwright browser for DDS tasks.',
    '4. If a screenshot is requested, save or copy the final image under D:\\projects\\output\\playwright and return that absolute path.',
  ];
}

function buildDelegationHints(inbound) {
  const routeKind = inbound?.meta?.routeKind || '';
  const taskId = inbound?.meta?.taskId || '';
  if (routeKind !== 'group_delegate_request' || !taskId) {
    return [];
  }

  return [
    'Delegated task context:',
    `1. This is a delegated bot-to-bot task for [task:${taskId}].`,
    '2. Answer only the delegated sub-task from the current user message.',
    `3. Keep the visible result starting with [task:${taskId}] so the origin bot can reconcile it.`,
    '4. Do not emit a new [delegate] prefix unless the delegated instruction explicitly asks for another delegation step.',
  ];
}

export function buildBridgePrompt(systemPrompt, history, inbound) {
  const historyText = buildHistoryText(history);
  const executionHints = buildTaskExecutionHints(inbound);
  const delegationHints = buildDelegationHints(inbound);
  return [
    systemPrompt,
    '',
    'Conversation so far:',
    historyText || '(empty)',
    '',
    'Current user message:',
    inbound.text,
    '',
    ...(executionHints.length > 0 ? [...executionHints, ''] : []),
    ...(delegationHints.length > 0 ? [...delegationHints, ''] : []),
    'Inbound attachments saved locally:',
    buildAttachmentSummary(inbound.attachments),
    '',
    'If images or files are attached, inspect the local paths directly when your tools support it.',
    'If you want to send media back, output markers like [[image:/absolute/path]] or [[file:/absolute/path]].',
    'Reply to the current user message directly.',
  ].join('\n');
}

export function extractMediaMarkers(rawReply) {
  const textLines = [];
  const media = [];

  for (const line of rawReply.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(MEDIA_MARKER_RE);
    if (!match) {
      textLines.push(line);
      continue;
    }
    media.push({
      kind: match[1].toLowerCase(),
      path: match[2].trim(),
    });
  }

  return {
    text: textLines.join('\n').trim(),
    media,
  };
}
