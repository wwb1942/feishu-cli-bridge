const MEDIA_MARKER_RE = /^\[\[(image|file):(.+?)\]\]$/i;

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

export function buildBridgePrompt(systemPrompt, history, inbound) {
  const historyText = buildHistoryText(history);
  return [
    systemPrompt,
    '',
    'Conversation so far:',
    historyText || '(empty)',
    '',
    'Current user message:',
    inbound.text,
    '',
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
