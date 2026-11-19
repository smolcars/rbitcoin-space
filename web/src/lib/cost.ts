// For the unit tests that hold code to a speed: what a run cost, measured so that a busy machine
// cannot fail them.

/** Node's count of this process's time on a processor, in microseconds. The app's types leave Node out. */
declare const process: { cpuUsage: () => { user: number; system: number } };

/**
 * A run's answer and the processor time it took, in milliseconds, not the time that passed: beside
 * other builds a run waits its turn for many times as long as it works (a 170 ms read took 2,434 ms
 * with every core taken four times over), and waiting is no cost of the code. It counts the whole
 * process, which is the test alone: Vitest runs each test file in a process of its own.
 */
export function cost<T>(run: () => T): { value: T; ms: number } {
  const used = () => {
    const { user, system } = process.cpuUsage();
    return (user + system) / 1000;
  };
  const start = used();
  const value = run();
  return { value, ms: used() - start };
}
