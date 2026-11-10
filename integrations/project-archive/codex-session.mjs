import { execFile } from 'node:child_process';

/** Use Codex's own durable queue. The desktop consumes it in the existing visible chat. */
export function queueCodex({ binary, threadId, prompt, execute = execFile }) {
  if (!/^[a-f0-9-]{36}$/.test(threadId ?? '')) throw new Error('Invalid dedicated session ID');
  return new Promise((resolve, reject) => {
    execute(binary, ['queue', '--thread', threadId, '--message', prompt],
      { timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) { reject(new Error('Codex queue delivery failed; check the app and hook receipt')); return; }
        const messageId = /Queued message ([a-f0-9-]{36}) for thread/.exec(stdout)?.[1];
        if (!messageId) { reject(new Error('Codex did not acknowledge a queued message')); return; }
        // Acceptance is not model completion. App-closed deliveries remain durably queued.
        resolve({ thread_id: threadId, message_id: messageId, status: 'queued' });
      });
  });
}
