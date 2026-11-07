import { DeepSeekClient, DeepSeekError } from './deepseek.js';
import { Store } from './store.js';

/** One persistent consumer; jobs survive restarts and are never marked successful on an API failure. */
export class AnalysisWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private task?: Promise<void>;
  private stopping = false;
  private controller = new AbortController();
  constructor(private store: Store, private client?: DeepSeekClient) { this.wake(); }
  status() { return { configured: Boolean(this.client), model: this.client?.model ?? 'deepseek-flash', ...this.store.jobCounts() }; }
  wake() {
    if (this.stopping || !this.client || this.task) return;
    clearTimeout(this.timer);
    this.task = this.run().finally(() => {
      this.task = undefined;
      if (!this.stopping) { this.timer = setTimeout(() => this.wake(), 1000); this.timer.unref(); }
    });
  }
  private retry(attempts: number, error?: unknown) {
    if (error instanceof DeepSeekError && !error.retryable) return undefined;
    return attempts < 3 ? new Date(Date.now() + 1000 * 5 ** (attempts - 1)).toISOString() : undefined;
  }
  private async run() {
    const client = this.client!;
    const call = this.store.claimAnalysis();
    if (call) {
      try { this.store.completeAnalysis(call.session.id, await client.analyzeCall(call.session, this.controller.signal)); }
      catch (error) { this.store.failAnalysis(call.session.id, this.message(error), this.stopping ? new Date().toISOString() : this.retry(call.attempts, error)); }
    }
    if (this.stopping) return;
    const industries = this.store.claimIndustries(20);
    if (industries.length) {
      try {
        const results = await client.inferIndustries(industries.map(job => ({ id: job.customerId, camp: job.camp })), this.controller.signal);
        for (const job of industries) {
          const result = results.find(result => result.id === job.customerId);
          if (result) this.store.completeIndustry(job, result.industry);
          else this.store.failIndustry(job, '行业分析未返回此客户，请重试', this.retry(job.attempts));
        }
      } catch (error) {
        for (const job of industries) this.store.failIndustry(job, this.message(error), this.stopping ? new Date().toISOString() : this.retry(job.attempts, error));
      }
    }
    if (this.stopping) return;
    // One company per iteration; finished-call analysis keeps first priority.
    const competitor = this.store.claimCompetitor();
    if (competitor) {
      try { this.store.completeCompetitors(competitor, await client.researchCompetitors(competitor, this.controller.signal)); }
      catch (error) { this.store.failCompetitors(competitor, this.message(error), this.stopping ? new Date().toISOString() : this.retry(competitor.attempts, error)); }
    }
  }
  private message(error: unknown) { return error instanceof Error ? error.message.slice(0, 300) : 'DeepSeek 分析失败，请重试'; }
  async close() { this.stopping = true; clearTimeout(this.timer); this.controller.abort(); await this.task; }
}
