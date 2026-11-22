// For the unit tests that hold code to a speed. A speed budget is a benchmark, run on request
// (docs/CI.md "Rules for tests"): the suite checks what the code answers, and only a run that asks
// for it checks how long the code took.

/** Node's environment, and its count of this process's time on a processor in microseconds. The app's types leave Node out. */
declare const process: {
  env: Record<string, string | undefined>;
  cpuUsage: () => { user: number; system: number };
};

/** A run that checks the speed budgets too. From `web/`: `BENCH=1 bunx vitest run <file>`. */
export const BENCH = process.env["BENCH"] === "1";

/**
 * `run`'s answer. On a `BENCH` run it also fails when `run` took more than `limitMs` of processor
 * time. Processor time, not the time that passed: beside other builds a run waits its turn for many
 * times as long as it works (a 170 ms read took 2,434 ms with every core taken four times over),
 * and waiting is no cost of the code. It counts the whole process: no other test, as Vitest runs
 * each test file in a process of its own, but Node's own background threads with it (garbage
 * collection), so leave a limit room. `run` must do all its work before it returns: time spent
 * after an `await` is not counted.
 */
export function budget<T>(limitMs: number, run: () => T): T {
  if (!BENCH) return run();
  const used = () => {
    const { user, system } = process.cpuUsage();
    return (user + system) / 1000;
  };
  const start = used();
  const value = run();
  const ms = used() - start;
  if (ms > limitMs) {
    throw new Error(`took ${ms.toFixed(1)} ms of processor time, over its budget of ${limitMs} ms`);
  }
  return value;
}
