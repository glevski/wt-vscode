// What each worktree has on top of the long-lived branch it grew from: which
// branch that is, how many commits, and the commits themselves.

import { execText } from "./cli";
import { Commit, Parent, baseBranches, commitFormat, hasParent, parseCommits, pickParent } from "./model";
import { View } from "./store";

/** How many commits a worktree row lists; more than this is a job for git log. */
export const commitLimit = 50;

export class History {
  // Keyed by commit ids, so an answer never goes stale: a branch that moves
  // has a new id and simply misses the cache.
  private readonly counts = new Map<string, Promise<number>>();
  private readonly lists = new Map<string, Promise<Commit[]>>();

  constructor(private readonly log: (line: string) => void) {}

  /** The parent of every worktree that has one, by worktree path. */
  async resolve(view: View): Promise<Map<string, Parent>> {
    const bases = baseBranches(view.doc);
    const parents = new Map<string, Parent>();
    if (bases.length === 0) {
      return parents;
    }
    await Promise.all(
      view.doc.worktrees.filter(hasParent).map(async (w) => {
        try {
          const candidates = [];
          for (const base of bases) {
            candidates.push({ ...base, ahead: await this.ahead(view.cwd, base.sha, w.head) });
          }
          const parent = pickParent(w, candidates);
          if (parent !== undefined) {
            parents.set(w.path, parent);
          }
        } catch (err) {
          this.log(`history of ${w.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    return parents;
  }

  /** The newest commits `head` has and `parent` does not, newest first. */
  commits(cwd: string, parent: Parent, head: string): Promise<Commit[]> {
    return this.remember(this.lists, `${parent.sha}..${head}`, async () =>
      parseCommits(await execText("git", ["log", "-n", String(commitLimit), commitFormat, `${parent.sha}..${head}`], cwd)),
    );
  }

  private ahead(cwd: string, base: string, head: string): Promise<number> {
    if (base === head) {
      return Promise.resolve(0);
    }
    return this.remember(this.counts, `${base}..${head}`, async () =>
      Number((await execText("git", ["rev-list", "--count", `${base}..${head}`], cwd)).trim()),
    );
  }

  private remember<T>(cache: Map<string, Promise<T>>, key: string, compute: () => Promise<T>): Promise<T> {
    let value = cache.get(key);
    if (value === undefined) {
      if (cache.size > 2000) {
        cache.clear(); // ids of long-gone commits; start over rather than grow forever
      }
      value = compute();
      cache.set(key, value);
      value.catch(() => cache.delete(key)); // a failure is not an answer worth keeping
    }
    return value;
  }
}
