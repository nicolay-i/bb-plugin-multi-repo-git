import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { repositoryScanConcurrency, scanSelectedRepositories } from "../lib/git.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  availableParallelism: vi.fn(),
  loadavg: vi.fn(),
}));

let directory: string | null = null;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
  vi.resetAllMocks();
});

describe("adaptive repository scanning", () => {
  it.each([
    [1, 0, 1], [4, 0, 1], [8, 0, 2], [16, 0, 4],
    [64, 0, 4], [16, 8, 2], [4, 9, 1],
  ])("budgets %i CPUs at load %i as %i repositories", (cpus, load, expected) => {
    expect(repositoryScanConcurrency(cpus, load)).toBe(expected);
  });

  it("bounds actual workers, preserves input order and resamples load on the next scan", async () => {
    directory = await mkdtemp(join(tmpdir(), "adaptive-git-"));
    const paths = ["slow", "fast", "third", "fourth"];
    await Promise.all(paths.map((path) => mkdir(join(directory!, path))));
    vi.mocked(availableParallelism).mockReturnValue(8);
    vi.mocked(loadavg).mockReturnValue([0, 0, 0]);
    const active = new Map<string, number>();
    let peak = 0;
    let peakProcesses = 0;
    const completed: string[] = [];
    vi.mocked(spawn).mockImplementation((_command, args) => {
      const cwd = String(args![1]);
      const command = args!.slice(2);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
      });
      active.set(cwd, (active.get(cwd) ?? 0) + 1);
      peak = Math.max(peak, active.size);
      peakProcesses = Math.max(peakProcesses, [...active.values()].reduce((a, b) => a + b, 0));
      setTimeout(() => {
        let output = "";
        let code = 0;
        if (command.includes("--show-toplevel")) output = cwd;
        else if (command[0] === "symbolic-ref") output = "main";
        else if (command.includes("--short")) output = "abc123";
        else if (command.includes("@{upstream}")) code = 1;
        else if (command[0] === "status") completed.push(cwd);
        child.stdout.end(output);
        const remaining = active.get(cwd)! - 1;
        if (remaining) active.set(cwd, remaining); else active.delete(cwd);
        child.emit("close", code);
      }, cwd.endsWith("slow") ? 15 : 1);
      return child as unknown as ReturnType<typeof spawn>;
    });

    const results = await scanSelectedRepositories(directory, [...paths, "missing", "../outside"]);
    expect(peak).toBe(2);
    expect(peakProcesses).toBeLessThanOrEqual(8);
    expect(completed[0]).toMatch(/fast$/);
    expect(results.map((result) => result.relativePath)).toEqual([...paths, "missing", "../outside"]);
    expect(results.slice(0, 4).every((result) => result.available)).toBe(true);
    expect(results[4]?.unavailableReason).toBe("missing");
    expect(results[5]?.unavailableReason).toBe("outside_workspace");

    peak = 0;
    vi.mocked(loadavg).mockReturnValue([10, 10, 10]);
    await scanSelectedRepositories(directory, paths);
    expect(peak).toBe(1);
    expect(availableParallelism).toHaveBeenCalledTimes(2);
    expect(loadavg).toHaveBeenCalledTimes(2);
  });

  it("stops launching queued repositories when a running scan is cancelled", async () => {
    directory = await mkdtemp(join(tmpdir(), "adaptive-git-abort-"));
    const paths = ["one", "two", "three"];
    await Promise.all(paths.map((path) => mkdir(join(directory!, path))));
    vi.mocked(availableParallelism).mockReturnValue(8);
    vi.mocked(loadavg).mockReturnValue([0, 0, 0]);
    const controller = new AbortController();
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        kill: vi.fn(() => {
          queueMicrotask(() => child.emit("close", 143));
          return true;
        }),
      });
      queueMicrotask(() => controller.abort());
      return child as unknown as ReturnType<typeof spawn>;
    });
    await expect(scanSelectedRepositories(directory, paths, controller.signal)).rejects.toThrow();
    const started = vi.mocked(spawn).mock.calls.length;
    expect(started).toBeGreaterThan(0);
    expect(started).toBeLessThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawn).toHaveBeenCalledTimes(started);
  });

  it("does not start Git for an already cancelled scan", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(scanSelectedRepositories("unused", ["."], controller.signal)).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
});
