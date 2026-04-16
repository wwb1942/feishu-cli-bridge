const MEDIA_MARKER_RE = /^\[\[(image|file):(.+?)\]\]$/i;
const DDS_TASK_RE = /dds|creditease\.corp/i;
const DISCUSSION_CONTROL_RE = /\[\[discussion-control:([\s\S]+?)\]\]/g;
const VALID_DISCUSSION_PHASES = new Set(['stance', 'cross_exam', 'convergence', 'verdict']);

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

function buildDiscussionHints(inbound) {
  const discussion = inbound?.meta?.discussion;
  if (!discussion) {
    return [];
  }

  if (discussion.role === 'host') {
    return [
      'Discussion host context:',
      `1. Shared task id: [task:${discussion.taskId}]`,
      `2. Current phase: ${discussion.phase}`,
      `3. Participant bots: ${(discussion.participantBotOpenIds || []).join(', ') || '(none)'}`,
      `4. Original human question: ${discussion.questionText || '(none)'}`,
      `5. Stance results: ${JSON.stringify(discussion.stanceByParticipantBotOpenId || {})}`,
      `6. Unresponsive participants: ${(discussion.unresponsiveParticipantBotOpenIds || []).join(', ') || '(none)'}`,
      `7. Prior phase summaries: ${JSON.stringify(discussion.phaseSummaries || [])}`,
      `8. Recent discussion events: ${JSON.stringify(discussion.recentEvents || [])}`,
      `9. Current bot-message budget: ${discussion.botMessageCount}/${discussion.policy?.maxBotMessages}`,
      '10. Reply with exactly one [[discussion-control:{...}]] marker.',
    ];
  }

  if (discussion.role === 'participant') {
    return [
      'Discussion participant context:',
      `1. Shared task id: [task:${discussion.taskId}]`,
      `2. Original human question: ${discussion.originalQuestion || '(none)'}`,
      `3. Current delegated focus: ${discussion.focus || '(none)'}`,
      `4. Keep the visible result starting with [task:${discussion.taskId}].`,
    ];
  }

  return [];
}

export function buildBridgePrompt(systemPrompt, history, inbound) {
  const historyText = buildHistoryText(history);
  const executionHints = buildTaskExecutionHints(inbound);
  const delegationHints = buildDelegationHints(inbound);
  const discussionHints = buildDiscussionHints(inbound);
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
    ...(discussionHints.length > 0 ? [...discussionHints, ''] : []),
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

export function parseDiscussionControlReply(text = '') {
  const matches = [...text.matchAll(DISCUSSION_CONTROL_RE)];
  if (matches.length === 0) {
    return {
      visibleText: text.trim(),
      control: null,
      hasMarker: false,
      malformed: false,
    };
  }

  const visibleText = text.replace(DISCUSSION_CONTROL_RE, '').trim();
  if (matches.length !== 1) {
    return {
      visibleText,
      control: null,
      hasMarker: true,
      malformed: true,
    };
  }

  try {
    const parsed = JSON.parse(matches[0][1]);
    const nextPhase = VALID_DISCUSSION_PHASES.has(parsed?.nextPhase) ? parsed.nextPhase : '';
    if (!nextPhase) {
      throw new Error('Invalid nextPhase');
    }

    const delegations = Array.isArray(parsed?.delegations)
      ? parsed.delegations
        .filter(item => item?.targetBotOpenId && item?.instruction)
        .map(item => ({
          targetBotOpenId: String(item.targetBotOpenId).trim(),
          instruction: String(item.instruction).trim(),
        }))
      : [];

    return {
      visibleText,
      control: {
        nextPhase,
        delegations,
        publicSummary: typeof parsed?.publicSummary === 'string' ? parsed.publicSummary.trim() : '',
      },
      hasMarker: true,
      malformed: false,
    };
  } catch {
    return {
      visibleText,
      control: null,
      hasMarker: true,
      malformed: true,
    };
  }
}
