import type { Customer } from './types.js';
import { buildInitialIntroduction, buildSalesFaqAnswer, identifySalesFaq, isExplicitStop, isInitialRefusal } from './sales-script.js';

// Deliberately deterministic: exercises the business flow, never estimates SeedDuplex quality.
export class Simulation {
  private stage: 'intro' | 'wechat' | 'same' | 'number' | 'confirm' | 'complete' = 'intro';
  constructor(private customer: Customer) {}
  reply(text: string): { text: string; done?: boolean } {
    const yes = /可以|好的|行吧|没问题|是的|就是|对的|同意|加吧|发吧|好啊|嗯|^是$|^对$|^好$/.test(text);
    const no = /不|别|没有|不用|没兴趣/.test(text);
    if (isExplicitStop(text)) {
      return { text: '嗯，明白了，那就先不打扰您啦，再见。', done: true };
    }
    // FAQ can interrupt any step without consuming a consent or number answer.
    const faq = identifySalesFaq(text);
    if (faq) {
      const answer = buildSalesFaqAnswer(faq, this.customer);
      if (this.stage === 'complete') return { text: answer, done: true };
      if (this.stage === 'intro') this.stage = 'wechat';
      const next = this.nextQuestion();
      // The supplied effectiveness answer already requests WeChat consent.
      const base = faq === 'effectiveness' && this.stage !== 'wechat'
        ? answer.slice(0, answer.indexOf('要不这样')) : answer;
      return { text: faq === 'effectiveness' && this.stage === 'wechat' ? answer : `${base}${next}` };
    }
    if (this.stage === 'intro' && isInitialRefusal(text)) {
      this.stage = 'wechat';
      return { text: buildInitialIntroduction(this.customer) };
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
      return { text: '啊，那您的商业嗅觉还是很灵敏的。这样吧，方便加个微信，我把咱们行业相关的案例介绍发您看看？' };
    }
    if (this.stage === 'intro' && !no && !/具体|什么|干嘛|意思|介绍/.test(text)) {
      return { text: '啊，是这样的，我们这边是帮咱们公司通过豆包这类AI应用精准获客的。您之前有了解过这种获客的方式吗？' };
    }
    this.stage = 'wechat';
    return { text: buildInitialIntroduction(this.customer) };
  }

  private nextQuestion(): string {
    if (this.stage === 'same') return '嗯，那您微信电话是我现在打的这个吗？';
    if (this.stage === 'number') return '嗯，那您微信绑定的是哪个手机号呀？我记一下。';
    if (this.stage === 'confirm') return '嗯，那刚才说的微信绑定电话，我记得对吗？';
    return '这样吧，方便加个微信，我把咱们行业相关的案例发您看看？';
  }
}
