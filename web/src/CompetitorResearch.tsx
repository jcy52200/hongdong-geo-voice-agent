import type { Customer } from './types';
import { publicSourceUrl } from '../../shared/competitors';

export function CompetitorResearch({ customer, onResearch }: { customer: Customer; onResearch: (id: string) => void }) {
  const working = ['pending', 'running'].includes(customer.competitorStatus ?? '');
  const peers = Array.isArray(customer.competitors) ? customer.competitors : [];
  const checked = Date.parse(customer.competitorCheckedAt ?? '');
  const label = customer.competitorStatus === 'pending' ? '等待行业与同行查询'
    : customer.competitorStatus === 'running' ? '正在联网查询…'
    : customer.competitorStatus === 'failed' ? '查询失败，可重试'
    : customer.competitorStatus === 'skipped' ? '城市或行业待补充'
    : customer.competitorStatus === 'completed' ? peers.length ? `${customer.competitorArea || '本地'}同行 · ${peers.length} 家` : '暂无可核实的本地同行'
    : '尚未查询本地同行';
  return <div className="competitor-research">
    <small role="status" title={customer.competitorNote}>{label}</small>
    {peers.map(peer => <div key={peer.name}>{publicSourceUrl(peer.sourceUrl) ? <a href={peer.sourceUrl} target="_blank" rel="noreferrer" title={`${peer.sourceTitle}\n${peer.areaEvidence}\n${peer.industryEvidence}`}>{peer.name} ↗</a> : <span>{peer.name}</span>}</div>)}
    {Number.isFinite(checked) && <small>查询于 {new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(checked))}</small>}
    {customer.competitorError && <small className="failed" title={customer.competitorError}>联网查询未完成，暂不点名同行</small>}
    <button type="button" className="text-button" disabled={working} onClick={() => onResearch(customer.id)}>{working ? '查询中…' : customer.competitorCheckedAt ? '重新查询同行' : '查询本地同行'}</button>
  </div>;
}
