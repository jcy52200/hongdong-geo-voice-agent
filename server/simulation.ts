import type { Customer } from './types.js';

// Deliberately deterministic: exercises the business flow, never estimates SeedDuplex quality.
export class Simulation {
  private stage: 'intro' | 'wechat' | 'same' | 'number' | 'confirm' = 'intro';
  private retried = false;
  constructor(private customer: Customer) {}
  reply(text: string): { text: string; done?: boolean } {
    const yes = /可以|好的|行吧|没问题|是的|就是|对的|同意|加吧|发吧|好啊|嗯|^是$|^对$|^好$/.test(text);
    const no = /不|别|没有|不用|没兴趣/.test(text);
    if (/别打|不要再|挂了|再见|没时间|不方便|不加|别加|别联系/.test(text)) {
      return { text: '嗯，明白了，那就先不打扰您啦，再见。', done: true };
    }
    if (this.stage === 'number') {
      const phone = text.replace(/[\s+()\-]/g, '').match(/\d{5,20}/)?.[0];
      if (!phone) return { text: '嗯，您把微信绑定的手机号说一下就行，我跟您核对一遍。' };
      this.stage = 'confirm';
      return { text: `嗯，我核对一下，是 ${phone.split('').join(' ')}，对吗？` };
    }
    if (this.stage === 'confirm') {
      if (yes && !no) return { text: '嗯好的，那打扰您啦，后续咱们微信联系。', done: true };
      this.stage = 'number';
      return { text: '昂，那您再说一遍微信绑定的电话，我重新记一下。' };
    }
    if (this.stage === 'same') {
      if (no) { this.stage = 'number'; return { text: '昂，那您微信绑定的是哪个手机号呀？我记一下。' }; }
      if (yes) return { text: '嗯好的，那打扰您啦，后续咱们微信联系。', done: true };
      return { text: '嗯，就是我现在打的这个号码，能直接搜到您的微信吗？' };
    }
    if (/多少钱|价格|报价|收费|费用/.test(text)) {
      this.stage = 'wechat';
      return { text: '昂是这样的，我们这个产品按年度付费是一万两千八百元，您要是说想先看看效果，也可以看下我们的季度产品，每个季度是三千八百元。这样吧，方便加个微信，我把产品介绍发您看看？' };
    }
    if (/怎么实现|底层|原理|怎么做/.test(text)) {
      this.stage = 'wechat';
      return { text: '呃，我们主要通过在新浪、搜狐这类媒体，还有行业媒体发文，再配合小红书、抖音的内容和官网结构化部署，增加品牌在AI回答中被提到的机会。方便加个微信，我把相关说明发您看看？' };
    }
    if (this.stage === 'wechat' && yes && !no) {
      this.stage = 'same'; return { text: '嗯，那您微信电话是我现在打的这个吗？' };
    }
    if (this.stage === 'wechat' && no) {
      if (this.retried) return { text: '嗯，明白，那就先不打扰您啦，再见。', done: true };
      this.retried = true;
      return { text: '嗯，理解。要不我先把行业相关的介绍发您，您有空再看，方便加个微信吗？' };
    }
    if (this.stage === 'intro' && /了解|听过|知道|兴趣|有需求/.test(text) && !no) {
      this.stage = 'wechat';
      return { text: '啊，那您的商业嗅觉还是很灵敏的。这样吧，方便加个微信，我把咱们行业相关的案例介绍发您看看？' };
    }
    if (this.stage === 'intro' && !no && !/具体|什么|干嘛|意思|介绍/.test(text)) {
      return { text: '啊，是这样的，我们这边是帮咱们公司通过豆包这类AI应用精准获客的。您之前有了解过这种获客的方式吗？' };
    }
    this.stage = 'wechat';
    const industry = this.customer.industry || '咱们这个';
    const area = this.customer.address || '当地';
    return { text: `那这样老板，我二十秒的时间给您简单介绍下。比如咱们是做${industry}行业的，客户选供应商前，可能会问豆包“${area}有哪些相关公司”。我们做的是增加咱们公司在这类回答里被提到的机会。这样，我加您微信发些相关介绍，您看怎么样？` };
  }
}
