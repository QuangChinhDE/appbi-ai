import { AgentDomainId } from '@/types/agent';
import { AppLanguage } from '@/i18n/messages';

export interface AgentDomainCatalogItem {
  id: Exclude<AgentDomainId, 'generic'>;
  label: string;
  description: string;
  enabled: boolean;
  version?: string;
  badgeTone: 'emerald' | 'blue' | 'amber' | 'slate';
  helperTitle: Record<AppLanguage, string>;
  helperDescription: Record<AppLanguage, string>;
  exampleGoal: Record<AppLanguage, string>;
  reviewLens?: Record<AppLanguage, string>;
}

export const AGENT_DOMAIN_CATALOG: AgentDomainCatalogItem[] = [
  {
    id: 'sales',
    label: 'Sales',
    description: 'Revenue pipeline, conversion, attainment, and territory performance.',
    enabled: false,
    badgeTone: 'blue',
    helperTitle: { en: 'Sales specialist', vi: 'Chuyên gia Sales' },
    helperDescription: {
      en: 'Coming soon. This pack will focus on pipeline, win rate, pricing, and rep performance.',
      vi: 'Sắp có. Pack này sẽ tập trung vào pipeline, win rate, pricing và hiệu suất đội sales.',
    },
    exampleGoal: {
      en: 'Analyze pipeline conversion by region and rep for the current quarter.',
      vi: 'Phân tích tỷ lệ chuyển đổi pipeline theo khu vực và nhân sự cho quý hiện tại.',
    },
  },
  {
    id: 'marketing',
    label: 'Marketing',
    description: 'Campaign efficiency, attribution, funnel quality, and audience mix.',
    enabled: false,
    badgeTone: 'amber',
    helperTitle: { en: 'Marketing specialist', vi: 'Chuyên gia Marketing' },
    helperDescription: {
      en: 'Coming soon. This pack will focus on CAC, ROI, funnel conversion, and channel mix.',
      vi: 'Sắp có. Pack này sẽ tập trung vào CAC, ROI, funnel conversion và channel mix.',
    },
    exampleGoal: {
      en: 'Review campaign ROI by channel and landing-page funnel drop-off.',
      vi: 'Rà soát ROI chiến dịch theo kênh và điểm rơi của funnel landing page.',
    },
  },
  {
    id: 'finance',
    label: 'Finance',
    description: 'Variance, profitability, cost drivers, budget vs actual, and cash posture.',
    enabled: true,
    version: '1.0',
    badgeTone: 'emerald',
    helperTitle: { en: 'Finance specialist', vi: 'Chuyên gia Finance' },
    helperDescription: {
      en: 'Use a finance lens first: explain performance through variance, margin, cost, budget, or cash.',
      vi: 'Ưu tiên lăng kính Finance: giải thích kết quả qua variance, margin, cost, budget hoặc cash.',
    },
    exampleGoal: {
      en: 'Explain budget vs actual variance by business unit and highlight the main margin drivers this quarter.',
      vi: 'Giải thích variance budget vs actual theo business unit và nêu các driver chính của margin trong quý này.',
    },
    reviewLens: {
      en: 'The draft should connect executive summary, section titles, and actions back to a finance thesis.',
      vi: 'Bản draft nên nối executive summary, tiêu đề section và action về cùng một finance thesis.',
    },
  },
  {
    id: 'hr',
    label: 'HR',
    description: 'Headcount, attrition, recruiting funnel, performance, and workforce mix.',
    enabled: false,
    badgeTone: 'slate',
    helperTitle: { en: 'HR specialist', vi: 'Chuyên gia HR' },
    helperDescription: {
      en: 'Coming soon. This pack will focus on hiring flow, retention, and workforce planning.',
      vi: 'Sắp có. Pack này sẽ tập trung vào luồng tuyển dụng, giữ chân và workforce planning.',
    },
    exampleGoal: {
      en: 'Review attrition risk by team and recruiting funnel health for critical roles.',
      vi: 'Rà soát rủi ro attrition theo team và sức khỏe funnel tuyển dụng cho critical roles.',
    },
  },
  {
    id: 'operations',
    label: 'Operations',
    description: 'Throughput, SLA, bottlenecks, cycle time, and operational exceptions.',
    enabled: false,
    badgeTone: 'blue',
    helperTitle: { en: 'Operations specialist', vi: 'Chuyên gia Operations' },
    helperDescription: {
      en: 'Coming soon. This pack will focus on throughput, SLA, utilization, and bottleneck analysis.',
      vi: 'Sắp có. Pack này sẽ tập trung vào throughput, SLA, utilization và bottleneck analysis.',
    },
    exampleGoal: {
      en: 'Investigate order cycle time bottlenecks and SLA misses by region.',
      vi: 'Điều tra bottleneck của order cycle time và các điểm fail SLA theo khu vực.',
    },
  },
  {
    id: 'customer_service',
    label: 'Customer Service',
    description: 'Ticket volume, resolution quality, response time, and support mix.',
    enabled: false,
    badgeTone: 'amber',
    helperTitle: { en: 'Customer service specialist', vi: 'Chuyên gia Customer Service' },
    helperDescription: {
      en: 'Coming soon. This pack will focus on ticket trends, SLA, resolution quality, and contact drivers.',
      vi: 'Sắp có. Pack này sẽ tập trung vào ticket trends, SLA, chất lượng xử lý và contact drivers.',
    },
    exampleGoal: {
      en: 'Explain response-time drift and repeat-ticket drivers by queue.',
      vi: 'Giải thích sự lệch response time và các driver của repeat ticket theo queue.',
    },
  },
];

export function getDomainCatalogItem(domainId: AgentDomainId | string | null | undefined): AgentDomainCatalogItem | undefined {
  return AGENT_DOMAIN_CATALOG.find((item) => item.id === domainId);
}

export function getDefaultDomainId(): Exclude<AgentDomainId, 'generic'> {
  return 'finance';
}
