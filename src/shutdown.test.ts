import { EventEmitter } from 'node:events';
import { createShutdown, installShutdownTriggers } from './shutdown.js';

describe('createShutdown', () => {
  it('runs every step once and exits once, however many triggers fire', async () => {
    const exit = vi.fn();
    const closeAll = vi.fn().mockResolvedValue(undefined);
    const stopScheduler = vi.fn();
    const shutdown = createShutdown(
      [
        { name: 'scheduler', run: stopScheduler },
        { name: 'connections', run: closeAll },
      ],
      { exit, log: vi.fn() },
    );

    // stdin 'end' puis 'close', puis fermeture du transport : trois causes.
    await Promise.all([shutdown('stdin ended'), shutdown('stdin closed'), shutdown('transport')]);

    expect(stopScheduler).toHaveBeenCalledTimes(1);
    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a failing step is logged and does not stop the next ones', async () => {
    const exit = vi.fn();
    const log = vi.fn();
    const after = vi.fn();
    const shutdown = createShutdown(
      [
        {
          name: 'watcher',
          run: async () => {
            throw new Error('logout refused');
          },
        },
        { name: 'connections', run: after },
      ],
      { exit, log },
    );

    await shutdown('SIGTERM');

    expect(after).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('logout refused'));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits after the timeout when a step hangs', async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const shutdown = createShutdown(
        [{ name: 'connections', run: async () => new Promise(() => {}) }],
        { exit, log: vi.fn(), timeoutMs: 5_000 },
      );

      shutdown('stdin ended').catch(() => {});
      await vi.advanceTimersByTimeAsync(4_999);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('installShutdownTriggers', () => {
  it('fires on stdin end/close and on SIGINT/SIGTERM, and can be removed', () => {
    const stdin = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const proc = new EventEmitter();
    const shutdown = vi.fn().mockResolvedValue(undefined);

    const remove = installShutdownTriggers(shutdown, stdin, proc);
    (stdin as unknown as EventEmitter).emit('end');
    (stdin as unknown as EventEmitter).emit('close');
    proc.emit('SIGINT');
    proc.emit('SIGTERM');

    expect(shutdown.mock.calls.map(([reason]) => reason)).toEqual([
      'stdin ended',
      'stdin closed',
      'SIGINT',
      'SIGTERM',
    ]);

    remove();
    proc.emit('SIGINT');
    expect(shutdown).toHaveBeenCalledTimes(4);
  });
});
