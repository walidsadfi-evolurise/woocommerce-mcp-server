/**
 * Human-in-the-loop write path.
 *
 * The agent never writes to the store directly. It creates a *proposal* (what
 * it wants to change and why), a human approves it out of band (CLI or the
 * admin HTTP endpoint, with a token the agent doesn't hold), and only then can
 * `apply_proposal` execute it. Proposals live in a JSON file so the approver
 * can be a different process than the MCP server.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

export type ProposalKind = "order_note" | "order_status" | "stock_update" | "price_update" | "refund";
export type ProposalStatus = "pending" | "approved" | "rejected" | "applied" | "failed";

export interface Proposal {
  id: string;
  kind: ProposalKind;
  summary: string;
  reason: string;
  payload: Record<string, unknown>;
  status: ProposalStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  appliedAt?: string;
  result?: unknown;
  error?: string;
}

export class ProposalStore {
  constructor(private readonly file: string) {}

  private read(): Proposal[] {
    if (!existsSync(this.file)) return [];
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Proposal[];
    } catch {
      throw new Error(`Proposals file ${this.file} is not valid JSON`);
    }
  }

  private write(all: Proposal[]): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, this.file);
  }

  list(status?: ProposalStatus): Proposal[] {
    const all = this.read();
    return status ? all.filter((p) => p.status === status) : all;
  }

  get(id: string): Proposal | undefined {
    return this.read().find((p) => p.id === id || p.id.startsWith(id));
  }

  create(input: Pick<Proposal, "kind" | "summary" | "reason" | "payload">): Proposal {
    const p: Proposal = { id: randomUUID(), status: "pending", createdAt: new Date().toISOString(), ...input };
    this.write([...this.read(), p]);
    return p;
  }

  decide(id: string, decision: "approved" | "rejected", by: string): Proposal {
    const all = this.read();
    const p = all.find((x) => x.id === id || x.id.startsWith(id));
    if (!p) throw new Error(`Unknown proposal ${id}`);
    if (p.status !== "pending") throw new Error(`Proposal ${p.id} is already ${p.status}`);
    p.status = decision;
    p.decidedAt = new Date().toISOString();
    p.decidedBy = by;
    this.write(all);
    return p;
  }

  markApplied(id: string, result: unknown): Proposal {
    return this.update(id, (p) => {
      p.status = "applied";
      p.appliedAt = new Date().toISOString();
      p.result = result;
    });
  }

  markFailed(id: string, error: string): Proposal {
    return this.update(id, (p) => {
      p.status = "failed";
      p.error = error;
    });
  }

  private update(id: string, fn: (p: Proposal) => void): Proposal {
    const all = this.read();
    const p = all.find((x) => x.id === id);
    if (!p) throw new Error(`Unknown proposal ${id}`);
    fn(p);
    this.write(all);
    return p;
  }
}
