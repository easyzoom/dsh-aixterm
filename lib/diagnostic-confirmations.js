import crypto from "node:crypto";

const fingerprint = (binding) => crypto.createHash("sha256").update(JSON.stringify(binding)).digest("hex");
export class DiagnosticConfirmations {
  constructor({ now = Date.now } = {}) { this.entries = new Map(); this.now = now; }
  issue(binding) {
    for (const [key, entry] of this.entries) if (entry.expires <= this.now()) this.entries.delete(key);
    while (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value);
    const token = crypto.randomBytes(24).toString("hex");
    this.entries.set(token, { fingerprint: fingerprint(binding), expires: this.now() + 300000 });
    return token;
  }
  consume(token, binding) {
    const entry = this.entries.get(token);
    this.entries.delete(token);
    if (!entry || entry.expires <= this.now() || entry.fingerprint !== fingerprint(binding)) throw new Error("confirmation-required-or-stale");
  }
}
