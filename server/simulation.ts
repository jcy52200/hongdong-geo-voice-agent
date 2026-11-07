import type { AgentConfig, Customer } from './types.js';
import { competitorArea, knownIndustry, spokenCompetitorNames } from '../shared/competitors.js';
import { buildCompetitorScenario, buildInitialIntroduction, buildSalesFaqAnswer, identifySalesFaq, isExplicitStop, isInitialRefusal } from './sales-script.js';

// Deliberately deterministic: exercises the business flow, never estimates SeedDuplex quality.
export class Simulation {
  private stage: 'intro' | 'wechat' | 'same' | 'number' | 'confirm' | 'complete' = 'intro';
  private competitorUsed = false;
  private explanationCount = 0;
  private customerTurns = 0;
  private invited = false;
  constructor(private customer: Customer, private config: Pick<AgentConfig, 'competitorPressureEnabled' | 'quickReplyText'> = {}) {}
  reply(text: string): { text: string; done?: boolean } {
    this.customerTurns++;
    const yes = /可以|好的|行吧|没问题|是的|就是|对的|同意|加吧|发吧|好啊|嗯|^是$|^对$|^好$/.test(text);
    const no = /不|别|没有|不用|没兴趣/.test(text);
    if (isExplicitStop(text)) {
      return { text: '嗯，明白了，那就先不打扰您啦，再见。', done: true };
    }
    if (this.competitorUsed && /他们|这几家|这些同行/.test(text) && /已经|真的?|有没有|做了|也做/.test(text)) {
      return { text: '这儿是用当地同行举个假设例子，没确认他们有没有做GEO。' };
    }
    // FAQ can interrupt any step without consuming a consent or number answer.
    const faq = identifySalesFaq(text);
    if (faq) {
      let answer = buildSalesFaqAnswer(faq, this.customer, text);
      if (faq === 'explanation' && this.explanationCount++ > 0) answer = `嗯，换个例子，客户问豆包“${competitorArea(this.customer.address) ?? '当地'}哪家${knownIndustry(this.customer.industry) ?? '这类产品和服务'}合适”，我们帮企业整理并发布产品和服务资料，让AI更容易了解并提到咱们公司。`;
      const mayUseCompetition = this.config.competitorPressureEnabled !== false && !this.competitorUsed
        && ['intro', 'wechat'].includes(this.stage);
      if (faq === 'competition') {
        if (!mayUseCompetition) answer = this.competitorUsed ? '嗯，刚才是用当地同行举个假设例子，没确认他们有没有做GEO。'
          : '是否做这个，还是要看咱们的业务需求，可以结合行业案例判断。';
        else this.competitorUsed = true;
      } else if (mayUseCompetition && spokenCompetitorNames(this.customer).length
        && (faq === 'effectiveness' || (faq === 'explanation' && /举.*例|比如|例子/.test(text)))) {
        this.competitorUsed = true;
        // A short industry contrast replaces the generic sales paragraph.
        answer = `${faq === 'explanation' ? '嗯，就是帮咱们的企业和产品信息更容易被AI了解、提到。' : ''}${buildCompetitorScenario(this.customer)}`;
      }
      if (this.stage === 'complete') return { text: answer, done: true };
      if (this.stage === 'intro') this.stage = 'wechat';
      const alreadyInvited = this.invited;
      const next = this.nextQuestion();
      // The supplied effectiveness answer already requests WeChat consent.
      const base = faq === 'effectiveness' && this.stage !== 'wechat'
        ? answer.slice(0, answer.indexOf('要不这样')) : answer;
      if (faq === 'effectiveness' && this.stage === 'wechat' && answer.includes('要不这样')) {
        this.invited = true; return { text: alreadyInvited ? answer.slice(0, answer.indexOf('要不这样')) : answer };
      }
      return { text: `${base}${next}` };
    }
    if (this.stage === 'intro' && isInitialRefusal(text)) {
      if (this.customerTurns !== 1) return { text: '嗯，明白，那就先不打扰您啦，再见。', done: true };
      this.stage = 'wechat';
      this.invited = true;
      return { text: buildInitialIntroduction(this.customer, this.config.quickReplyText) };
    }
    if (this.stage === 'complete') return { text: '嗯好的，后续咱们微信联系。', done: true };
    if (this.stage === 'number') {
      const phone = text.replace(/[\s+()\-]/g, '').match(/(?<!\d)1[3-9]\d{9}(?!\d)/)?.[0];
      if (!phone) return { text: '嗯，您把微信绑定的手机号说一下就行，我跟您核对一遍。' };
      this.stage = 'confirm';
      return { text: `嗯，我核对一下，是 ${phone.split('').join(' ')}，对吗？` };
    }
    if (this.stage === 'confirm') {
      if (yes && !no) { this.stage = 'complete'; return { text: '嗯好的，那打扰您啦，后续咱们微信联系。', done: true }; }
      this.stage = 'number';
      return { text: '昂，那您再说一遍微信绑定的电话，我重新记一下。' };
    }
    if (this.stage === 'same') {
      if (no) { this.stage = 'number'; return { text: '昂，那您微信绑定的是哪个手机号呀？我记一下。' }; }
      if (yes) { this.stage = 'complete'; return { text: '嗯好的，那打扰您啦，后续咱们微信联系。', done: true }; }
      return { text: '嗯，就是我现在打的这个号码，能直接搜到您的微信吗？' };
    }
    if (this.stage === 'wechat' && yes && !no) {
      this.stage = 'same'; return { text: '嗯，那您微信电话是我现在打的这个吗？' };
    }
    if (this.stage === 'wechat' && no) {
      return { text: '嗯，明白，那就先不打扰您啦，再见。', done: true };
    }
    if (this.stage === 'intro' && /了解|听过|知道|兴趣|有需求/.test(text) && !no) {
      this.stage = 'wechat';
      this.invited = true;
      return { text: '啊，那您的商业嗅觉还是很灵敏的。这样吧，方便加个微信，我把咱们行业相关的案例介绍发您看看？' };
    }
    return { text: '嗯，您是想了解具体怎么做，还是产品包含哪些服务呀？' };
  }

  private nextQuestion(): string {
    if (this.stage === 'same') return '嗯，那您微信电话是我现在打的这个吗？';
    if (this.stage === 'number') return '嗯，那您微信绑定的是哪个手机号呀？我记一下。';
    if (this.stage === 'confirm') return '嗯，那刚才说的微信绑定电话，我记得对吗？';
    if (this.invited) return '';
    this.invited = true;
    return '这样吧，方便加个微信，我把咱们行业相关的案例发您看看？';
  }
}
