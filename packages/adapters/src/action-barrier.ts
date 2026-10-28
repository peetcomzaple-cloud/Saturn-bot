/**
 * Adapted from CopilotKit/OpenBot (commit e8bb27368ff436958b614292ae91283e51d5a813)
 *
 * MIT License
 *
 * Copyright (c) 2026 CopilotKit
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Synchronous admission, asynchronous draining for computer and browser actions.
 */

export function createActionBarrier() {
  let closed = false;
  let active = 0;
  const waiters = new Set<() => void>();
  return {
    enter(): () => void {
      if (closed) {
        throw new Error("Action admission is closed for this computer.");
      }
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
        if (active === 0) {
          for (const wake of [...waiters]) wake();
        }
      };
    },
    close() {
      closed = true;
    },
    open() {
      closed = false;
    },
    pending() {
      return active;
    },
    drain(timeoutMs = 30_000): Promise<void> {
      if (active === 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(wake);
          reject(
            new Error(
              "An admitted action is still finishing; human control has not been granted. Try taking control again.",
            ),
          );
        }, timeoutMs);
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        waiters.add(wake);
      });
    },
  };
}

export type ActionBarrier = ReturnType<typeof createActionBarrier>;

export class SnapshotRequiredError extends Error {
  constructor() {
    super("Take a fresh browser snapshot after handback before acting.");
    this.name = "SnapshotRequiredError";
  }
}

export class HumanHasControlError extends Error {
  constructor() {
    super("A person has control or has been asked to take control. Wait for them to hand it back before acting.");
    this.name = "HumanHasControlError";
  }
}

/**
 * Adapter integrating OpenBot's action barrier and snapshot requirement
 * into Rakazo's takeover-resume lifecycle.
 */
export function createTakeoverControlGate(options: { drainTimeoutMs?: number } = {}) {
  const barrier = createActionBarrier();
  let holder: "bot" | "human" = "bot";
  let resumeSnapshotRequired = false;

  return {
    getHolder: () => holder,
    isResumeSnapshotRequired: () => resumeSnapshotRequired,
    pendingActions: () => barrier.pending(),

    admitBotAction(browserMutation = false): () => void {
      if (holder === "human") {
        throw new HumanHasControlError();
      }
      if (browserMutation && resumeSnapshotRequired) {
        throw new SnapshotRequiredError();
      }
      return barrier.enter();
    },

    async takeHumanControl(): Promise<void> {
      if (holder === "human") return;
      barrier.close();
      await barrier.drain(options.drainTimeoutMs ?? 5_000);
      holder = "human";
    },

    setHumanControl(): void {
      holder = "human";
      barrier.close();
    },

    releaseHumanControl(): void {
      holder = "bot";
      resumeSnapshotRequired = true;
      barrier.open();
    },

    requireResumeSnapshot(): void {
      resumeSnapshotRequired = true;
    },

    recordSnapshotTaken(): void {
      if (holder === "bot" && resumeSnapshotRequired) {
        resumeSnapshotRequired = false;
      }
    },
  };
}

export type TakeoverControlGate = ReturnType<typeof createTakeoverControlGate>;

const computerControlGates = new Map<string, TakeoverControlGate>();

/**
 * Obtain or lazily create a TakeoverControlGate for a specific computer.
 */
export function getTakeoverControlGate(
  computerId: string,
  options: { drainTimeoutMs?: number } = {},
): TakeoverControlGate {
  let gate = computerControlGates.get(computerId);
  if (!gate) {
    gate = createTakeoverControlGate(options);
    computerControlGates.set(computerId, gate);
  }
  return gate;
}

/**
 * Remove or clear the gate instance for a computer.
 */
export function removeTakeoverControlGate(computerId: string): void {
  computerControlGates.delete(computerId);
}

/**
 * Clear all registered computer control gates (test tear-down).
 */
export function clearAllTakeoverControlGates(): void {
  computerControlGates.clear();
}
