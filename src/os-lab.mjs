/** Deterministic millisecond teaching scheduler, not an AUTOSAR OS implementation. */
export class OsLabSimulator {
  constructor({ cores = 3 } = {}) {
    if (!Number.isInteger(cores) || cores < 1 || cores > 8) throw new RangeError('cores must be 1..8');
    this.coreCount = cores;
    this.reset();
  }

  reset() {
    this.nowMs = 0;
    this.fraction = 0;
    this.events = [];
    this.timeline = [];
    this.cores = Array.from({ length: this.coreCount }, (_, id) => ({ id, online: true, running: null, interrupts: [] }));
    this.tasks = [
      { id: 'background', name: 'Background', core: 0, priority: 1, period: 40, budget: 8 },
      { id: 'control', name: 'Control', core: 1 % this.coreCount, priority: 3, period: 20, budget: 4 },
      { id: 'comm', name: 'Communication', core: 2 % this.coreCount, priority: 2, period: 10, budget: 2 },
      { id: 'diagnostic', name: 'Diagnostic', core: 0, priority: 4, period: 0, budget: 2 },
      { id: 'event', name: 'EventTask', core: 0, priority: 3, period: 0, budget: 2, extended: true },
    ].map(t => ({ ...t, coreId: t.core, state: t.extended ? 'Waiting' : 'Suspended', remaining: 0, completed: 0, deadlineMisses: 0, deadline: null, missed: false, executed: 0 }));
    this.ioc = { queue: [], deliveries: [], nextSequence: 1 };
    this.spinlock = { enabled: false, owner: null, waiters: [] };
    for (const task of this.tasks.filter(t => t.period)) this.activate(task.id);
    return this.getSnapshot();
  }

  log(type, message) {
    this.events.push({ time: this.nowMs, timeMs: this.nowMs, type, message });
    if (this.events.length > 160) this.events.shift();
  }

  activate(taskId) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) throw new RangeError('Unknown task');
    if (task.remaining) { this.log('activation-limit', `${task.id}: activation already pending`); return false; }
    task.remaining = task.budget;
    task.executed = 0;
    task.deadline = this.nowMs + (task.period || 20);
    task.missed = false;
    task.state = 'Ready';
    this.log('activate', `${task.id} ready`);
    return true;
  }

  setEvent(taskId = 'event') {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task?.extended) throw new RangeError('SetEvent requires an extended task');
    return this.activate(taskId);
  }

  setCoreOnline(coreId, online) {
    const core = this.cores[coreId];
    if (!core) throw new RangeError('Unknown core');
    core.online = Boolean(online);
    core.running = null;
    for (const task of this.tasks.filter(t => t.core === coreId && t.remaining)) task.state = 'Ready';
    this.log('core', `Core ${coreId} ${online ? 'online' : 'offline'}; barrier ${this.cores.every(c => c.online) ? 'released' : 'waiting'}`);
  }

  triggerInterrupt(coreId = 0, category = 2) {
    if (!this.cores[coreId] || ![1, 2].includes(category)) throw new RangeError('Invalid interrupt');
    this.cores[coreId].interrupts.push({ category, remaining: 2 });
    this.log('interrupt', `Core ${coreId}: Cat${category} queued`);
  }

  sendIoc(value) {
    if (this.ioc.queue.length >= 32) { this.log('ioc-full', 'IOC queue full'); return false; }
    this.ioc.queue.push({ sequence: this.ioc.nextSequence++, value: structuredClone(value), sentAt: this.nowMs });
    return true;
  }

  setLockContention(enabled) {
    this.spinlock.enabled = Boolean(enabled);
    if (!enabled) { this.spinlock.owner = null; this.spinlock.waiters = []; }
  }

  record(core, task) {
    const last = this.timeline.findLast(segment => segment.core === core);
    if (last && last.task === task && last.end === this.nowMs) last.end++;
    else this.timeline.push({ core, coreId: core, task, start: this.nowMs, end: this.nowMs + 1 });
    if (this.timeline.length > 240) this.timeline.shift();
  }

  tick(ms) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 60000) throw new RangeError('tick must be 0..60000 ms');
    this.fraction += ms;
    while (this.fraction >= 1 - 1e-9) {
      this.fraction = Math.max(0, this.fraction - 1);
      if (this.nowMs > 0) for (const task of this.tasks) {
        if (task.remaining && this.nowMs >= task.deadline && !task.missed) {
          task.missed = true; task.deadlineMisses++; this.log('deadline', `${task.id} missed deadline`);
        }
        if (task.period && this.nowMs % task.period === 0) this.activate(task.id);
      }
      this.spinlock.waiters = [];
      for (const task of this.tasks) if (task.remaining) task.state = 'Ready';
      for (const core of this.cores) {
        core.running = null;
        if (!core.online) { this.record(core.id, 'Offline'); continue; }
        const interrupt = core.interrupts[0];
        if (interrupt) {
          core.running = `Cat${interrupt.category}`;
          this.record(core.id, core.running);
          if (--interrupt.remaining === 0) {
            core.interrupts.shift();
            if (interrupt.category === 2) this.setEvent();
            this.log('isr-return', `Cat${interrupt.category} completed${interrupt.category === 1 ? ' (no OS service)' : ' (SetEvent)'}`);
          }
          continue;
        }
        const task = this.tasks.filter(t => t.core === core.id && t.remaining).sort((a, b) => b.priority - a.priority)[0];
        if (!task) { this.record(core.id, 'Idle'); continue; }
        const needsLock = this.spinlock.enabled && ['control', 'comm'].includes(task.id) && task.executed < 2;
        if (needsLock && this.spinlock.owner && this.spinlock.owner !== task.id) {
          this.spinlock.waiters.push(task.id);
          core.running = `Spin:${task.id}`;
          this.record(core.id, core.running);
          continue;
        }
        if (needsLock) this.spinlock.owner = task.id;
        task.state = 'Running'; core.running = task.id;
        this.record(core.id, task.id);
        task.remaining--; task.executed++;
        if (this.spinlock.owner === task.id && task.executed >= 2) this.spinlock.owner = null;
        if (!task.remaining) {
          task.completed++; task.state = task.extended ? 'Waiting' : 'Suspended';
          this.log('complete', `${task.id} completed`);
        }
        if (task.id === 'comm' && this.ioc.queue.length) {
          this.ioc.deliveries.push({ ...this.ioc.queue.shift(), receivedAt: this.nowMs + 1 });
          if (this.ioc.deliveries.length > 80) this.ioc.deliveries.shift();
        }
      }
      this.nowMs++;
    }
    return this.getSnapshot();
  }

  getSnapshot() {
    return structuredClone({ nowMs: this.nowMs, tasks: this.tasks, cores: this.cores, timeline: this.timeline, ioc: this.ioc, spinlock: this.spinlock, events: this.events, barrier: this.cores.every(c => c.online) ? 'released' : 'waiting' });
  }
}

export { OsLabSimulator as OsSimulator };
