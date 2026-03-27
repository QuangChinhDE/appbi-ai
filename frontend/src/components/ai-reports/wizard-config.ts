import { AppLanguage } from '@/i18n/messages';
import { BriefPreset, BriefSectionKey, BriefSectionMeta, StepMeta } from './wizard-types';

export const DEFAULT_BRIEF_SECTIONS: BriefSectionKey[] = ['brief'];
export const ALL_BRIEF_SECTIONS: BriefSectionKey[] = ['brief'];

export function getStepMeta(language: AppLanguage): StepMeta[] {
  if (language === 'vi') {
    return [
      { key: 'select', label: 'Chọn bảng', caption: 'Xác định phạm vi phân tích' },
      { key: 'brief', label: 'Viết brief', caption: '6 tín hiệu đầu vào cho Agent' },
      { key: 'plan', label: 'Duyệt draft', caption: 'Chỉnh sửa trước khi build' },
      { key: 'building', label: 'Tạo dashboard', caption: 'Tạo chart và bố cục' },
    ];
  }

  return [
    { key: 'select', label: 'Choose tables', caption: 'Set the analysis scope' },
    { key: 'brief', label: 'Write the brief', caption: 'Six inputs for the Agent' },
    { key: 'plan', label: 'Review the draft', caption: 'Edit before building' },
    { key: 'building', label: 'Build dashboard', caption: 'Create charts and layout' },
  ];
}

export function getBriefSectionMeta(language: AppLanguage): BriefSectionMeta[] {
  return [
    {
      key: 'brief',
      title: language === 'vi' ? 'Senior Analyst Brief' : 'Senior analyst brief',
      description:
        language === 'vi'
          ? 'Agent chỉ cần một brief thật ngắn để tự suy luận hướng phân tích như một DA senior.'
          : 'The Agent only needs a compact brief to infer the analysis direction like a senior analyst.',
      helper:
        language === 'vi'
          ? 'Chỉ giữ mục tiêu quyết định, audience, thời gian, mốc so sánh, mức chi tiết và notes.'
          : 'Keep only the decision goal, audience, timeframe, comparison, detail level, and notes.',
    },
  ];
}

export function getBriefPresets(language: AppLanguage): BriefPreset[] {
  return [
    {
      key: 'investigative',
      title: language === 'vi' ? 'Điều tra chuyên sâu' : 'Investigative deep dive',
      summary:
        language === 'vi'
          ? 'Template mặc định để Agent suy nghĩ như một DA senior với brief tối giản.'
          : 'Default template for a senior-analyst style run with a minimal brief.',
      goal: '',
      audience: '',
      comparisonPeriod: '',
      mustIncludeSectionsText: '',
      alertFocusText: '',
    },
  ];
}

export function makeInitialBriefState(language: AppLanguage) {
  return {
    reportName: '',
    goal: '',
    audience: '',
    timeframe: language === 'vi' ? '30 ngày gần nhất' : 'Last 30 days',
    whyNow: '',
    businessBackground: '',
    kpisText: '',
    questionsText: '',
    comparisonPeriod: '',
    mustIncludeSectionsText: '',
    alertFocusText: '',
    preferredGranularity: '',
    decisionContext: '',
    importantDimensionsText: '',
    businessGlossaryText: '',
    knownDataIssuesText: '',
    columnsToAvoidText: '',
    tableRolesHintText: '',
    includeTextNarrative: true,
    includeActionItems: true,
    includeDataQualityNotes: true,
    notes: '',
    planningMode: 'deep' as const,
  };
}
