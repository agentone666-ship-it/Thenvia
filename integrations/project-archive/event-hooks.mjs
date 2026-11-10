import { watch, readdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function atomicJSON(path, value) {
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}

/** OS filesystem notifications, not watchFile or a repeated timer. Debounce only after an event. */
export function watchChanges(paths, callback, delay = 400) {
  let timer;
  const changed = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; callback(); }, delay);
  };
  const watchers = paths.map(({ path, accept }) => watch(path, (_event, name) => {
    if (!name || accept(String(name))) changed();
  }));
  return () => { clearTimeout(timer); for (const watcher of watchers) watcher.close(); };
}

export function pendingEvents(root) {
  const events = [];
  const inbox = join(root, 'SessionInbox');
  for (const name of readdirSync(inbox)) {
    if (!/^[a-f0-9]{64}\.request\.json$/.test(name)) continue;
    const id = name.slice(0, 64);
    if (!existsSync(join(inbox, id + '.response.json')) || !existsSync(join(inbox, id + '.opportunities.json'))) {
      // A rejected decision is a distinct actionable event; writing a valid response isn't.
      const rejected = join(inbox, id + '.response.json.rejected');
      const revision = existsSync(rejected) ? createHash('sha256').update(readFileSync(rejected)).digest('hex') : 'new';
      events.push({ id: `recording:${id}:${revision}`, request_id: id });
    }
  }
  return events;
}

/** Read local completion receipts only on database notifications. Never scan unrelated chat content. */
export function workerEvents(root, codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {
  const orderPath = join(root, 'work-orders.sqlite');
  const historyPath = join(codexHome, 'thread_history_1.sqlite');
  if (!existsSync(orderPath) || !existsSync(historyPath)) return [];
  let orders, history;
  try {
    orders = new DatabaseSync(orderPath, { readOnly: true });
    orders.exec('PRAGMA busy_timeout=2000');
    const active = orders.prepare("SELECT id,thread_id,host_id,created_ms FROM work_orders WHERE state IN ('running','reviewing','rework') AND thread_id IS NOT NULL").all();
    if (!active.length) return [];
    history = new DatabaseSync(historyPath, { readOnly: true });
    history.exec('PRAGMA busy_timeout=2000');
    const latest = history.prepare("SELECT turn_id,status,started_at,completed_at,error_json FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1");
    return active.flatMap(order => {
      if (order.host_id && order.host_id !== 'local') return [];
      const turn = latest.get(order.thread_id);
      if (!turn || !['completed', 'failed', 'interrupted'].includes(turn.status)) return [];
      // Local projection currently stores seconds; tolerate millisecond versions as well.
      const completedMs = turn.completed_at < 1e12 ? turn.completed_at * 1000 : turn.completed_at;
      if (!completedMs || completedMs < Math.floor(order.created_ms / 1000) * 1000) return [];
      return [{ id: `work:${order.id}:${turn.turn_id}:${turn.status}`, order_id: order.id,
        thread_id: order.thread_id, turn_id: turn.turn_id, status: turn.status }];
    });
  } catch (error) {
    // Preserve a local diagnostic on schema drift, without waking a model or retry loop.
    const path = join(root, 'worker-hook-error.json');
    const message = String(error.message);
    if (!existsSync(path) || JSON.parse(readFileSync(path, 'utf8')).error !== message)
      atomicJSON(path, { status: 'needs_attention', error: message, at: Date.now() });
    return [];
  } finally { history?.close(); orders?.close(); }
}

/** At most one queue delivery process. Persist claims BEFORE dispatch: uncertain failures never spin. */
export class EventDispatch {
  constructor(root, dispatch) {
    this.path = join(root, 'hook-receipts.json');
    this.receipts = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
    this.dispatch = dispatch;
    this.running = false;
    this.queued = new Map();
    this.completion = Promise.resolve();
  }
  enqueue(events) {
    for (const event of events) if (!this.receipts[event.id]) this.queued.set(event.id, event);
    if (!this.running && this.queued.size) this.completion = this.drain();
    return this.completion;
  }
  async drain() {
    this.running = true;
    try {
      while (this.queued.size) {
        const batch = [...this.queued.values()].slice(0, 3);
        for (const event of batch) this.queued.delete(event.id);
        for (const event of batch) this.receipts[event.id] = { state: 'dispatching', at: Date.now() };
        atomicJSON(this.path, this.receipts);
        try {
          const result = await this.dispatch(batch);
          for (const event of batch) this.receipts[event.id] = { state: result?.status === 'queued' ? 'queued' : 'completed', at: Date.now(), result };
        } catch (error) {
          for (const event of batch) this.receipts[event.id] = { state: 'needs_attention', at: Date.now(), error: error.message };
        }
        atomicJSON(this.path, this.receipts);
      }
    } finally { this.running = false; }
  }
}
