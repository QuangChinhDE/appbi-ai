import { AppLanguage } from '@/i18n/messages';
import { BriefPreset, BriefSectionKey, BriefSectionMeta, StepMeta } from './wizard-types';

export const DEFAULT_BRIEF_SECTIONS: BriefSectionKey[] = ['essentials', 'intent'];
export const ALL_BRIEF_SECTIONS: BriefSectionKey[] = ['essentials', 'intent', 'dataset', 'narrative', 'advanced'];

export function getStepMeta(language: AppLanguage): StepMeta[] {
  if (language === 'vi') {
    return [
      { key: 'select', label: 'Chọn bảng', caption: 'Xác định phạm vi phân tích' },
      { key: 'brief', label: 'Viết brief', caption: 'Mô tả mục tiêu nghiệp vụ' },
      { key: 'plan', label: 'Duyệt draft', caption: 'Chỉnh sửa trước khi build' },
      { key: 'building', label: 'Tạo dashboard', caption: 'Tạo chart và bố cục' },
    ];
  }
  return [
    { key: 'select', label: 'Choose tables', caption: 'Set the analysis scope' },
    { key: 'brief', label: 'Write the brief', caption: 'Describe the business goal' },
    { key: 'plan', label: 'Review the draft', caption: 'Edit before building' },
    { key: 'building', label: 'Build dashboard', caption: 'Create charts and layout' },
  ];
}

export function getBriefSectionMeta(language: AppLanguage): BriefSectionMeta[] {
  if (language === 'vi') {
    return [
      {
        key: 'essentials',
        title: 'Cốt lõi',
        description: 'Bắt đầu với lượng ngữ cảnh tối thiểu để AI tạo bản draft đầu tiên đủ tốt.',
        helper: 'Các trường này quyết định câu hỏi nghiệp vụ chính, KPI trọng tâm và đối tượng người đọc report.',
      },
      {
        key: 'intent',
        title: 'Ý định report',
        description: 'Cho AI biết bạn muốn kiểu report nào và cần hỗ trợ quyết định gì.',
        helper: 'Phần này ảnh hưởng tới section planning, chart mix, logic so sánh và giọng điệu đầu ra.',
      },
      {
        key: 'dataset',
        title: 'Ngữ cảnh dữ liệu',
        description: 'Các gợi ý tùy chọn giúp AI hiểu nhanh dữ liệu mơ hồ hoặc lộn xộn.',
        helper: 'Hữu ích khi tên cột chưa rõ nghĩa, dữ liệu có issue đã biết, hoặc một số bảng giữ vai trò nghiệp vụ cụ thể.',
        optional: true,
      },
      {
        key: 'narrative',
        title: 'Đầu ra phân tích',
        description: 'Chọn mức độ phân tích bằng văn bản sẽ đi kèm report.',
        helper: 'Phần này ảnh hưởng tới độ sâu của executive summary, caveat và việc AI có đề xuất action hay không.',
        optional: true,
      },
      {
        key: 'advanced',
        title: 'Nâng cao',
        description: 'Tinh chỉnh loại report và các ghi chú cuối cùng cho AI.',
        helper: 'Đây là các điều khiển tùy chọn khi phần brief cốt lõi đã đủ mạnh.',
        optional: true,
      },
    ];
  }

  return [
    {
      key: 'essentials',
      title: 'Essentials',
      description: 'Start with the minimum context needed for a solid first draft.',
      helper: 'These fields shape the main business question, core KPI focus, and who the report is written for.',
    },
    {
      key: 'intent',
      title: 'Report intent',
      description: 'Tell the Agent what kind of report you want and what decisions it should support.',
      helper: 'This changes section planning, chart mix, comparison logic, and the tone of the output.',
    },
    {
      key: 'dataset',
      title: 'Dataset context',
      description: 'Optional hints that help the Agent understand messy or ambiguous data faster.',
      helper: 'Useful when column names are unclear, there are known data issues, or some tables play a specific business role.',
      optional: true,
    },
    {
      key: 'narrative',
      title: 'Narrative output',
      description: 'Choose how much written analysis should ship with the report.',
      helper: 'This affects executive summary depth, caveats, and whether the Agent should propose actions.',
      optional: true,
    },
    {
      key: 'advanced',
      title: 'Advanced',
      description: 'Fine-tune report type and any last notes for the Agent.',
      helper: 'These are optional controls for shaping behavior once the core brief is already strong.',
      optional: true,
    },
  ];
}

export function getBriefPresets(language: AppLanguage): BriefPreset[] {
  if (language === 'vi') {
    return [
      {
        key: 'executive',
        title: 'Review KPI điều hành',
        summary: 'Báo cáo theo dõi ngắn gọn, tập trung vào quyết định cho lãnh đạo.',
        goal: 'Tạo một báo cáo KPI điều hành cho thấy các thay đổi lớn nhất, rủi ro ưu tiên và nơi lãnh đạo nên tập trung tiếp theo.',
        audience: 'Ban lãnh đạo',
        reportStyle: 'executive',
        reportType: 'executive_tracking',
        comparisonPeriod: 'Kỳ trước',
        refreshFrequency: 'Weekly',
        mustIncludeSectionsText: 'Executive summary\nTrend\nBreakdown\nRisks',
        alertFocusText: 'Drops\nAnomalies\nEmerging risks',
        insightDepth: 'balanced',
        recommendationStyle: 'priority_actions',
        preferredDashboardStructure: 'summary_first',
      },
      {
        key: 'operations',
        title: 'Theo dõi vận hành',
        summary: 'Theo dõi vận hành với các điểm kiểm tra lặp lại, owner và blocker.',
        goal: 'Tạo báo cáo vận hành làm nổi bật các vấn đề cần follow-up, ownership gap và thay đổi trong hoạt động theo thời gian.',
        audience: 'Quản lý vận hành',
        reportStyle: 'operational',
        reportType: 'operations_monitoring',
        comparisonPeriod: 'Tuần qua tuần',
        refreshFrequency: 'Weekly',
        mustIncludeSectionsText: 'Executive summary\nTrend\nOwnership gaps\nOperational backlog',
        alertFocusText: 'Backlog growth\nMissing ownership\nStale records',
        insightDepth: 'balanced',
        recommendationStyle: 'suggested_actions',
        preferredDashboardStructure: 'section_by_issue',
      },
      {
        key: 'quality',
        title: 'Chất lượng dữ liệu / stewardship',
        summary: 'Làm nổi bật metadata thiếu, tài sản stale và rủi ro stewardship.',
        goal: 'Tạo báo cáo stewardship làm lộ ra metadata gap, tài sản không hoạt động và rủi ro chất lượng dữ liệu cần khắc phục.',
        audience: 'Nhóm quản trị dữ liệu',
        reportStyle: 'monitoring',
        reportType: 'data_quality_watch',
        comparisonPeriod: 'Kỳ trước',
        refreshFrequency: 'Weekly',
        mustIncludeSectionsText: 'Executive summary\nQuality gate\nOwnership gaps\nSensitive assets',
        alertFocusText: 'Missing metadata\nStale assets\nSensitive assets without owners',
        insightDepth: 'deep',
        recommendationStyle: 'priority_actions',
        preferredDashboardStructure: 'section_by_issue',
      },
      {
        key: 'investigative',
        title: 'Điều tra chuyên sâu',
        summary: 'Narrative dài hơn với giả thuyết, yếu tố dẫn dắt và caveat.',
        goal: 'Điều tra xem điều gì đang thay đổi, nhóm nào đang dẫn dắt thay đổi đó và giả thuyết nào đáng xác minh tiếp theo.',
        audience: 'Analyst và chủ report',
        reportStyle: 'investigative',
        reportType: 'investigative_review',
        comparisonPeriod: 'Kỳ trước',
        refreshFrequency: 'Ad hoc',
        mustIncludeSectionsText: 'Executive summary\nTrend\nDriver analysis\nOpen questions',
        alertFocusText: 'Outliers\nUnexpected drivers\nSegments with unusual behavior',
        insightDepth: 'deep',
        recommendationStyle: 'suggested_actions',
        preferredDashboardStructure: 'summary_first',
      },
    ];
  }

  return [
    {
      key: 'executive',
      title: 'Executive KPI review',
      summary: 'Short, decision-focused monitoring report for leadership.',
      goal: 'Create an executive KPI review that shows the biggest shifts, priority risks, and where leadership should focus next.',
      audience: 'Executive leadership',
      reportStyle: 'executive',
      reportType: 'executive_tracking',
      comparisonPeriod: 'Previous period',
      refreshFrequency: 'Weekly',
      mustIncludeSectionsText: 'Executive summary\nTrend\nBreakdown\nRisks',
      alertFocusText: 'Drops\nAnomalies\nEmerging risks',
      insightDepth: 'balanced',
      recommendationStyle: 'priority_actions',
      preferredDashboardStructure: 'summary_first',
    },
    {
      key: 'operations',
      title: 'Operations monitoring',
      summary: 'Operational tracking with recurring checks, owners, and blockers.',
      goal: 'Build an operational monitoring report that highlights issues requiring follow-up, ownership gaps, and changes in activity over time.',
      audience: 'Operations managers',
      reportStyle: 'operational',
      reportType: 'operations_monitoring',
      comparisonPeriod: 'Week over week',
      refreshFrequency: 'Weekly',
      mustIncludeSectionsText: 'Executive summary\nTrend\nOwnership gaps\nOperational backlog',
      alertFocusText: 'Backlog growth\nMissing ownership\nStale records',
      insightDepth: 'balanced',
      recommendationStyle: 'suggested_actions',
      preferredDashboardStructure: 'section_by_issue',
    },
    {
      key: 'quality',
      title: 'Data quality / stewardship',
      summary: 'Highlight missing metadata, stale assets, and stewardship risk.',
      goal: 'Build a stewardship report that surfaces metadata gaps, inactive assets, and data quality risks that need remediation.',
      audience: 'Data governance team',
      reportStyle: 'monitoring',
      reportType: 'data_quality_watch',
      comparisonPeriod: 'Previous period',
      refreshFrequency: 'Weekly',
      mustIncludeSectionsText: 'Executive summary\nQuality gate\nOwnership gaps\nSensitive assets',
      alertFocusText: 'Missing metadata\nStale assets\nSensitive assets without owners',
      insightDepth: 'deep',
      recommendationStyle: 'priority_actions',
      preferredDashboardStructure: 'section_by_issue',
    },
    {
      key: 'investigative',
      title: 'Investigative deep dive',
      summary: 'Longer narrative with hypotheses, drivers, and caveats.',
      goal: 'Investigate what is changing, which segments are driving the change, and what hypotheses are most worth validating next.',
      audience: 'Analysts and report owners',
      reportStyle: 'investigative',
      reportType: 'investigative_review',
      comparisonPeriod: 'Previous period',
      refreshFrequency: 'Ad hoc',
      mustIncludeSectionsText: 'Executive summary\nTrend\nDriver analysis\nOpen questions',
      alertFocusText: 'Outliers\nUnexpected drivers\nSegments with unusual behavior',
      insightDepth: 'deep',
      recommendationStyle: 'suggested_actions',
      preferredDashboardStructure: 'summary_first',
    },
  ];
}

export function makeInitialBriefState(language: AppLanguage) {
  if (language === 'vi') {
    return {
      reportName: '',
      reportType: 'executive_tracking',
      goal: 'Tạo dashboard điều hành theo dõi KPI cốt lõi và làm nổi bật những thay đổi đáng chú ý nhất',
      audience: 'Ban điều hành',
      timeframe: '30 ngày gần nhất',
      whyNow: 'Nhóm cần một bản đọc ngắn gọn để biết điều gì vừa thay đổi và nên tập trung vào đâu tiếp theo.',
      businessBackground: '',
      kpisText: 'Doanh thu\nSố lượng đơn hàng\nTăng trưởng',
      questionsText: 'Xu hướng chính là gì?\nPhân khúc nào đóng góp nhiều nhất?\nCó bất thường nào cần chú ý không?',
      comparisonPeriod: 'Kỳ trước',
      refreshFrequency: 'Weekly',
      mustIncludeSectionsText: 'Executive summary\nTrend\nBreakdown',
      alertFocusText: 'Bất thường\nSụt giảm',
      preferredGranularity: 'day',
      decisionContext: 'Giúp nhóm quyết định điều gì đã thay đổi, yếu tố nào đang dẫn dắt và nên tập trung vào đâu tiếp theo.',
      reportStyle: 'executive',
      insightDepth: 'balanced',
      recommendationStyle: 'suggested_actions',
      confidencePreference: 'include_tentative_with_caveats',
      preferredDashboardStructure: 'summary_first',
      includeTextNarrative: true,
      includeActionItems: true,
      includeDataQualityNotes: true,
      tableRolesHintText: '',
      businessGlossaryText: '',
      knownDataIssuesText: '',
      importantDimensionsText: '',
      columnsToAvoidText: '',
      notes: '',
      planningMode: 'deep' as const,
    };
  }

  return {
    reportName: '',
    reportType: 'executive_tracking',
    goal: 'Build an executive dashboard that tracks core KPIs and highlights the biggest changes',
    audience: 'Executive team',
    timeframe: 'Last 30 days',
    whyNow: 'We need a concise readout that helps the team decide what changed recently and where to focus next.',
    businessBackground: '',
    kpisText: 'Revenue\nOrder volume\nGrowth',
    questionsText: 'What is the main trend?\nWhich segment contributes the most?\nWhat anomaly needs attention?',
    comparisonPeriod: 'Previous period',
    refreshFrequency: 'Weekly',
    mustIncludeSectionsText: 'Executive summary\nTrend\nBreakdown',
    alertFocusText: 'Anomalies\nDrops',
    preferredGranularity: 'day',
    decisionContext: 'Help the team decide what changed, what is driving it, and where to focus next.',
    reportStyle: 'executive',
    insightDepth: 'balanced',
    recommendationStyle: 'suggested_actions',
    confidencePreference: 'include_tentative_with_caveats',
    preferredDashboardStructure: 'summary_first',
    includeTextNarrative: true,
    includeActionItems: true,
    includeDataQualityNotes: true,
    tableRolesHintText: '',
    businessGlossaryText: '',
    knownDataIssuesText: '',
    importantDimensionsText: '',
    columnsToAvoidText: '',
    notes: '',
    planningMode: 'deep' as const,
  };
}
