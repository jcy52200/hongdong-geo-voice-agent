import type { Customer } from './types.js';

/** Operator-supplied sales copy, not independently verified product claims. */
export const SALES_FAQS = [
  {
    id: 'services',
    intent: '服务内容、交付数量、包含什么',
    patterns: [/包含|包括|服务内容|哪些服务|提供什么|交付|一万多|多少条|多少篇|三千|3000|10000/, /(?:产品|套餐|年包|一年|服务).*(?:都有啥|有什么|做什么|做啥|都干啥)/],
    answer: '是这样的，我们年包12800的产品给您全年累计发布一万多条内容，包括比如新闻啦，黄页啦，自媒体还有视频这种都有。然后可以给您做到训练好3000多个全维度的词汇，哎好让豆包优先推送您',
  },
  {
    id: 'company',
    intent: '公司背景、服务商资质、团队和技术能力',
    patterns: [/(?:你们|你家|贵司|公司).*(?:来头|什么公司|哪家|叫什么|叫啥|哪里的|哪儿的|做多久|靠谱吗|可靠|技术|背景|实力|资质)/, /(?:公司|团队|技术|系统).*(?:靠不靠谱|靠谱不|靠谱吗|可靠吗|什么来头)/, /(?:是不是|是).*(?:服务商|代理商)/],
    answer: '咱们这边是泓动引擎，豆包的一线服务商。咱们手里有好几套国内顶尖的推广系统，像讯灵、摘星这些，而且这边团队以前都是做百度搜索营销的老手，技术和经验这块都没问题的。',
  },
  {
    id: 'ownership',
    intent: '停止合作后的内容、账号、资料归属',
    patterns: [/(?:不(?:要再|再)?合作|停止合作|到期|到时候|终止|不续费|不续约|停了|结束合作).*(?:删|内容|文章|视频|账号|资料|归|还在|留下)/, /(?:文章|视频|内容|账号|资料).*(?:归谁|所有权|删除|删掉|到期|永久|不(?:要再|再)?合作|不续费)/],
    answer: '这个是不会的。像帮咱们整理好的资料、已经发在网上的文章视频，还有用咱们手机号注册的账号，全部都是永久归您的。',
  },
  {
    id: 'quality',
    intent: '机器生成内容的质量',
    patterns: [/(?:内容|文章|视频|机器|AI|ai|人工智能).*(?:质量|写得行|写的行|写得好|写的好|能行吗|靠不靠谱|靠谱不|靠谱吗|有用吗|水平|原创)/, /(?:机器|AI|ai|自动).*(?:生成|写).*(?:行不行|好不好|可信吗|可靠吗)/],
    answer: '嗯这么跟您讲吧，100分满分咱们肯定能打80分，因为现在就算您花大几千招个人，他也是用AI写，而且要论产量和质量那还不如咱们这种专业系统呢，您可以算算这笔账。',
  },
  {
    id: 'managedService',
    intent: '客户需投入的工作、托管和团队服务',
    patterns: [/(?:我们|我|自己|客户|咱们).*(?:干.*活|做.*工作|做些什么|做什么|操作|维护|配合|操心|提供.*资料|准备.*资料)/, /(?:托管|服务团队|几个人|需要.*参与|麻不麻烦|麻烦吗)/, /(?:没时间|没空)(?:弄|操作|维护|打理).*(?:怎么办|怎么做|谁来|你们.*帮)/],
    answer: '这个基本不用您操心，咱们这边是一站式托管，会配个3人的小团队专门服务您。您就开头把公司现成的资料丢给我们，后面帮着把把关、看看数据就行。',
  },
  {
    id: 'visibility',
    intent: '搜索到的概率、曝光保障和数据查询',
    patterns: [/(?:保证|确保|百分之百|100%|每次|一定).*(?:搜到|搜索|找到|推荐|曝光|展示)/, /(?:曝光率|能.*搜到|搜得到|查.*数据|数据看板|怎么.*查.*效果)/],
    answer: '嗯这个的话，只要是咱们确认好去做的问答词，曝光率基本都能做到80%以上。咱们还有实时数据看板，客户怎么问的、有没有展示咱们电话，这些您都随时能查。',
  },
  {
    id: 'priceComparison',
    intent: '与其他商家相比价格偏高',
    patterns: [/(?:比|别人|别家|同行|其他家|人家).*(?:贵|便宜|低价|价格)/, /(?:价格|收费).*(?:高|贵)|太贵|有点贵/],
    answer: '嗯您也是自己开公司的，肯定也明白一分钱一分货。那现在市面上有些低价的，说白了用的是一些违规野路子，没效果不说万一再被平台查到给咱们公司打上黑名单标记，那不得不偿失嘛。',
  },
  {
    id: 'quarterlyPricing',
    intent: '季度产品价格',
    patterns: [/季度|按季|一季|三个月/],
    answer: '昂是这样的，我们这个产品按年度付费是一万两千八百元，您要是说想先看看效果也可以看下我们的季度产品，每个季度是三千八百元。',
  },
  {
    id: 'pricing',
    intent: '年度价格、收费和额外费用',
    patterns: [/多少钱|价格|报价|收费|费用|怎么收|怎么卖|多少费用|隐形|隐性|加钱|额外.*钱|后续.*钱/],
    answer: '咱们这边产品是按年收费，基础版一年就12800，但您要算平摊下来一天也就三四十块钱。',
  },
  {
    id: 'effectiveness',
    intent: '现在做有没有效果、是否适合入场',
    patterns: [/有效果|有效吗|有没有用|真的有用|效果怎么样|效果如何|能带来.*客户|能带来.*订单|现在做|红利/],
    answer: '嗯这么跟您讲吧，这个东西现在做效果正是最好的时候，因为正赶上红利期，您很多同行还没听过这个，那新广告都是早做的吃肉，再等过半年大家全挤进来了，效果肯定就该打折扣啦，其次价格也得跟着涨上去，要不这样，我加您个微信，找几个咱们行业的案例发您瞅瞅？',
  },
  {
    id: 'implementation',
    intent: '具体实现方法和底层原理',
    patterns: [/怎么实现|底层|原理|技术上.*做|怎么做到|如何做到|具体怎么做/],
    answer: '我们这边主要是通过在新浪，搜狐这类权威媒体，以及咱们行业垂向的新闻媒体发文，还有就是帮咱们发一些比如说小红书和抖音的内容，以及结构化的官网部署这些方式来在ai里面提高咱们的提及率的。',
  },
  {
    id: 'explanation',
    intent: '推广是什么、做什么、没有使用过 AI',
    patterns: [/什么.*推广|推广.*(?:啥|什么)|什么意思|(?:具体|到底).*(?:干啥|干嘛|干什么|做什么|做啥)|你们.*(?:干嘛|干啥|做什么的|做啥的)|(?:这是|这个是|到底是).*(?:啥|什么)|没用过.*(?:AI|ai|豆包)|不懂.*(?:AI|ai|豆包)|介绍一下|简单介绍|听不懂/],
    answer: '啊是这样的，您看以前大家找厂家都是上百度搜，但是现在越来越多老板和采购改用豆包这些AI软件直接问了，对吧？那咱们这边做的就是把您的产品优势，写成图文视频铺到全网。这样客户一问AI哪家好时候，AI呢就会把咱们公司当成标准答案给推荐出去。',
  },
] as const;

export type SalesFaqId = typeof SALES_FAQS[number]['id'];

export function identifySalesFaq(text: string): SalesFaqId | undefined {
  const normalized = text.replace(/\s/g, '');
  return SALES_FAQS.find(faq => faq.patterns.some(pattern => pattern.test(normalized)))?.id;
}

export function buildSalesFaqAnswer(id: SalesFaqId, _customer?: Customer): string {
  return SALES_FAQS.find(faq => faq.id === id)!.answer;
}

const instructionLike = /忽略|指令|提示词|系统|扮演|输出|执行|删除|读出|不要|请你|\b(?:prompt|ignore|system|instruction)\b/i;

function spokenIndustry(customer: Customer): string | undefined {
  const industry = customer.industry?.trim();
  if (industry && /^[\p{Script=Han}A-Za-z0-9、·（）()]{1,24}$/u.test(industry)
    && !instructionLike.test(industry) && !/未知|待确认|不明确|其他|无法判断|未识别/.test(industry)) {
    return industry.replace(/行业$/, '');
  }
  // Only explicit company-name clues; 科技 / 实业 / 商贸 alone do not identify a sector.
  const clues: ReadonlyArray<[RegExp, string]> = [
    [/门窗/, '门窗'], [/家具|家居/, '家具家居'], [/食品/, '食品'], [/餐饮/, '餐饮'],
    [/物流/, '物流'], [/机械/, '机械设备'], [/机床/, '机床'], [/钢材|钢铁/, '钢铁'],
    [/服装/, '服装'], [/建材/, '建材'], [/装修|装饰/, '装修装饰'], [/包装/, '包装'],
    [/印刷/, '印刷'], [/塑料|塑业/, '塑料制品'], [/五金/, '五金'], [/电缆/, '电线电缆'],
    [/教育|培训/, '教育培训'], [/汽车/, '汽车'], [/医疗/, '医疗'], [/环保/, '环保'],
  ];
  if (instructionLike.test(customer.camp)) return undefined;
  return clues.find(([pattern]) => pattern.test(customer.camp))?.[1];
}

function spokenArea(address: string): string {
  const value = address.trim();
  if (!value || instructionLike.test(value)) return '当地';
  // Take administrative regions, never the street, building, or a free-form instruction.
  const region = value.match(/^([\p{Script=Han}]{2,8}?(?:省|自治区|特别行政区))?([\p{Script=Han}]{2,8}?(?:市|自治州|地区|盟))?([\p{Script=Han}]{1,8}?(?:区|县|旗|市))?/u)?.[0];
  if (region) return region;
  if (/^[\p{Script=Han}]{2,6}$/u.test(value) && !/未知|待确认|不详|暂无|未填写/.test(value)) return value;
  return '当地';
}

export const INITIAL_INTRODUCTION_TEMPLATE = '那这样老板，我二十秒给您简单介绍下，比如说咱们不是&industry的嘛，像现在大家都会用豆包，比如说咱们当地有个客户想买相关产品之前，肯定会问豆包‘&address哪家做的比较好’，这时候如果说咱们买了我们的这个产品，豆包就会将咱们公司和联系方式曝光给客户，我们主要就是帮您做到这个的，然后我们这边也有很多咱们行业的相关案例，要不这样，我加您微信发您案例您有空就看一眼您看怎么样';

function spokenField(value: string, fallback: string, maxLength: number): string {
  const trimmed = value.trim();
  if (instructionLike.test(trimmed) || trimmed.length > maxLength
    || !/^[\p{Script=Han}A-Za-z0-9&·（）()、 ._-]+$/u.test(trimmed)) return fallback;
  return trimmed;
}

/** Shared by the rule preview and the real first-refusal response control. */
export function buildInitialIntroduction(customer: Customer, template = INITIAL_INTRODUCTION_TEMPLATE): string {
  const industry = spokenIndustry(customer);
  const business = industry ? `${industry}${industry.endsWith('业') ? '' : '行业'}` : '做这类产品和服务';
  const area = spokenArea(customer.address);
  const phone = customer.phone.replace(/[\s+()\-]/g, '');
  const values = {
    industry: business,
    address: area,
    camp: spokenField(customer.camp, '咱们公司', 80),
    name: spokenField(customer.name, '老板', 32),
    phone: /^\d{5,20}$/.test(phone) ? phone : '当前来电号码',
  };
  // Customer text remains data: inserted values are never scanned for tokens again.
  return (template.trim() || INITIAL_INTRODUCTION_TEMPLATE).replace(
    /&(industry|address|camp|name|phone)(?![A-Za-z0-9_])/g,
    (_token, key: keyof typeof values) => values[key],
  );
}

export function isExplicitStop(text: string): boolean {
  if (/别打|(?:不要再|不许再|别再)(?:打|联系|说|讲|骚扰|推)|挂了|挂吧|再见|再会|拜拜|先这样|不聊了|不说了|不想听了|不加(?:微信|你|好友|了|啦|$)|别加|别联系|不要联系|不要打|别说了|别讲了|停止|闭嘴/.test(text)) return true;
  // Work after purchase is a service question, distinct from being busy on this call.
  const workloadQuestion = /(?:没时间|没空).*(?:弄|操作|维护|打理|做这些|做这个|做内容)/.test(text)
    && /需要|要自己|自己.*吗|怎么办|怎么做|谁来|谁负责|你们.*(?:帮|托管)|是否|[?？]/.test(text);
  if (workloadQuestion && !/没时间(?:接|听|聊|说|讲)|不方便(?:接听|说|聊|听)|开会|开车/.test(text)) return false;
  return /没时间|^(?:现在)?不方便[。！!，,]*$|不方便(?:接听|说|聊|听|加)|在忙|忙着|开会|开车/.test(text);
}

/** A soft refusal to the opening, rather than an explicit request to stop calling. */
export function isInitialRefusal(text: string): boolean {
  return !isExplicitStop(text) && /不需要|不想了解|不感兴趣|没(?:什么|啥)?兴趣|不用|不了解|没了解|没听过|不知道|不想听|没需求/.test(text);
}
