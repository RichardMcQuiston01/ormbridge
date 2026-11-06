/**
 * SQL Server rejects a foreign key whose cascading action (CASCADE, SET NULL, SET DEFAULT) would create a cycle
 * or a second cascade path between two tables (error 1785). This graph holds the cascading keys accepted so far,
 * as edges from the referenced table to the table that holds the key, and tells whether the next one would be
 * refused. The SQL DDL and the Sequelize writers use it to write NO ACTION for the keys that SQL Server would not
 * create.
 */
export class CascadeGraph {
  private readonly edges: Map<string, Set<string>> = new Map<
    string,
    Set<string>
  >();

  /** The tables a cascade from `start` reaches. */
  private reachFrom(start: string): Set<string> {
    const seen: Set<string> = new Set<string>();
    const queue: string[] = [start];
    while (queue.length > 0) {
      const current: string | undefined = queue.pop();
      for (const next of this.edges.get(current ?? '') ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  }

  /** True when a cascading key in `child` that references `parent` makes a cycle or a second cascade path. */
  conflicts(parent: string, child: string): boolean {
    if (parent === child || this.reachFrom(child).has(parent)) {
      return true;
    }
    // A second path: some table that already reaches the parent (or is the parent) reaches the child, or anything
    // below it, another way.
    const below: Set<string> = this.reachFrom(child);
    below.add(child);
    for (const root of this.edges.keys()) {
      if (root !== parent && !this.reachFrom(root).has(parent)) {
        continue;
      }
      const reached: Set<string> = this.reachFrom(root);
      if ([...below].some((name: string) => reached.has(name))) {
        return true;
      }
    }
    return false;
  }

  /** Records an accepted cascading key in `child` that references `parent`. */
  add(parent: string, child: string): void {
    const children: Set<string> = this.edges.get(parent) ?? new Set<string>();
    children.add(child);
    this.edges.set(parent, children);
  }
}
