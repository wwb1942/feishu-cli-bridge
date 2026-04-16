# Group Collaboration Manual Checklist

Use this checklist when validating explicit delegation and hosted discussion in a real Feishu group.

## Setup

- Start one bridge process per bot profile.
- Make sure each bot uses its own `DATA_DIR` and `FEISHU_ACCOUNT_ID`.
- Enable group collaboration with `FEISHU_GROUP_DELEGATION_ENABLED=true`.

## Direct Group Request

1. Human sends `@bot-a` in a group.
2. Confirm bot A replies in the group, not in DM.

## Hosted Discussion

1. Human sends a message mentioning `@bot-a @bot-b @bot-c`.
2. Confirm exactly one host bot starts the discussion.
3. Confirm non-host participant bots do not answer the original human message directly.
4. Confirm the host sends stance requests to participants.
5. Confirm participant results return with a leading `[task:<id>]`.
6. Confirm the host can continue into cross-exam and then publish one final verdict.
7. Confirm a participant that never answers is marked `unresponsive`, and the host still continues with available input.
8. Confirm a discussion that hits the configured message or duration guardrail ends with a forced convergence or verdict.

## Explicit Delegation

1. Bot A sends `[delegate] [task:test123] @bot-b ...`.
2. Confirm bot A posts a short delegation confirmation.
3. Confirm bot B executes and posts `[task:test123] ...` success in the group.
4. Confirm bot A stays silent on success.
5. Confirm if bot B fails, bot B posts the visible failure result.
6. Confirm if bot B runner times out, bot B posts an execution-timeout style failure.
7. Confirm if bot B never replies, bot A posts a wait-timeout notice after `FEISHU_DELEGATE_TIMEOUT_MS`.

## Ordering and Recovery

1. Confirm an out-of-order delegated result that arrives before the origin bot observes the pending task is still reconciled during the grace window.
2. Confirm unrelated assistant chatter without valid leading protocol markers is ignored.
