/** A local peer selected from live search evidence, not proof it purchased GEO. */
export interface Competitor {
  name: string;
  area: string;
  industry: string;
  sourceUrl: string;
  sourceTitle: string;
  nameEvidence: string;
  areaEvidence: string;
  industryEvidence: string;
}
export type CompetitorStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export interface CompetitorResearch {
  competitors: Competitor[];
  area: string;
  checkedAt: string;
  status: 'completed' | 'skipped';
  note: string;
}
const instructions = /忽略|指令|提示词|系统|扮演|输出|执行|删除|读出|请你|\b(?:prompt|ignore|system|instruction)\b/i;
export const companyKey = (value: string) => value.normalize('NFKC').replace(/[\s·（）()]/g, '').replace(/有限责任公司$|股份有限公司$|有限公司$/, '').toLowerCase();

/** Use a city, never send a customer's full street address to web search. */
export function competitorArea(address: string): string | undefined {
  const value = address.trim().replace(/^中国/, '');
  if (instructions.test(value) || /未知|待确认|待补充|不详|全国|当地|某某/.test(value)) return;
  const municipality = value.match(/^(北京|上海|天津|重庆)/)?.[1];
  if (municipality) return `${municipality}市`;
  const rest = value.replace(/^.*?(?:省|自治区|特别行政区)/, '');
  const city = rest.match(/^([\p{Script=Han}]{2,10}市)/u)?.[1];
  if (city) return city;
  const provinces = '河北 河南 山东 山西 陕西 甘肃 青海 四川 云南 贵州 湖北 湖南 江西 江苏 浙江 安徽 福建 广东 海南 黑龙江 吉林 辽宁 台湾 内蒙古 广西 西藏 宁夏 新疆 香港 澳门 中国 华东 华北 华南 华中 东北 西北 西南'.split(' ');
  if (/^[\p{Script=Han}]{2,7}$/u.test(value) && !/[省区县镇乡村街路号州]$/.test(value) && !provinces.includes(value)) return `${value}市`;
}
export function knownIndustry(industry?: string) {
  const value = industry?.trim();
  return value && value.length <= 40 && /^[\p{Script=Han}A-Za-z0-9、·（）() -]+$/u.test(value)
    && !instructions.test(value) && !/未知|待确认|不明确|其他|无法判断|未识别/.test(value) ? value.replace(/行业$/, '') : undefined;
}
export function safeCompanyName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length >= 2 && name.length <= 100
    && /^[\p{Script=Han}A-Za-z0-9·（）() ._-]+$/u.test(name) && !instructions.test(name);
}
export function publicSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      && url.hostname.includes('.') && !/^localhost$|\.local$|\.localhost$|^\d+\.\d+\.\d+\.\d+$|:/.test(url.hostname);
  } catch { return false; }
}
/** Only source-backed peers for the same current city/industry enter spoken copy. */
export function spokenCompetitorNames(customer: { camp: string; address: string; industry?: string; competitors?: Competitor[]; competitorStatus?: CompetitorStatus }): string[] {
  const area = competitorArea(customer.address); const industry = knownIndustry(customer.industry);
  if (!area || !industry || !Array.isArray(customer.competitors) || (customer.competitorStatus && customer.competitorStatus !== 'completed')) return [];
  const seen = new Set<string>();
  return customer.competitors.filter(item => {
    if (!item || !safeCompanyName(item.name) || item.area !== area || item.industry !== industry
      || !publicSourceUrl(item.sourceUrl || '') || !item.nameEvidence?.includes(item.name)
      || !item.areaEvidence?.includes(area.replace(/市$/, '')) || !item.industryEvidence?.includes(industry)) return false;
    const key = companyKey(item.name);
    if (!key || key === companyKey(customer.camp) || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 2).map(item => item.name);
}
