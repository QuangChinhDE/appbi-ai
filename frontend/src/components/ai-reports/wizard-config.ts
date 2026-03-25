import { BriefPreset, BriefSectionKey, BriefSectionMeta, StepMeta } from './wizard-types';

export const STEP_META: StepMeta[] = [
  { key: 'select', label: 'Choose tables', caption: 'Set the analysis scope' },
  { key: 'brief', label: 'Write the brief', caption: 'Describe the business goal' },
  { key: 'plan', label: 'Review the draft', caption: 'Edit before building' },
  { key: 'building', label: 'Build dashboard', caption: 'Create charts and layout' },
];

const INITIAL_GOAL = 'Build an executive dashboard that tracks core KPIs and highlights the biggest changes';
const INITIAL_AUDIENCE = 'Executive team';
const INITIAL_TIMEFRAME = 'Last 30 days';
const INITIAL_KPIS = 'Revenue\nOrder volume\nGrowth';
const INITIAL_QUESTIONS = 'What is the main trend?\nWhich segment contributes the most?\nWhat anomaly needs attention?';
const INITIAL_MUST_INCLUDE = 'Executive summary\nTrend\nBreakdown';
const INITIAL_ALERT_FOCUS = 'Anomalies\nDrops';

export const DEFAULT_BRIEF_SECTIONS: BriefSectionKey[] = ['essentials', 'intent'];
export const ALL_BRIEF_SECTIONS: BriefSectionKey[] = ['essentials', 'intent', 'dataset', 'narrative', 'advanced'];

export const BRIEF_SECTION_META: BriefSectionMeta[] = [
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

export const BRIEF_PRESETS: BriefPreset[] = [
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

export function makeInitialBriefState() {
  return {
    reportName: '',
    reportType: 'executive_tracking',
    goal: INITIAL_GOAL,
    audience: INITIAL_AUDIENCE,
    timeframe: INITIAL_TIMEFRAME,
    whyNow: 'We need a concise readout that helps the team decide what changed recently and where to focus next.',
    businessBackground: '',
    kpisText: INITIAL_KPIS,
    questionsText: INITIAL_QUESTIONS,
    comparisonPeriod: 'Previous period',
    refreshFrequency: 'Weekly',
    mustIncludeSectionsText: INITIAL_MUST_INCLUDE,
    alertFocusText: INITIAL_ALERT_FOCUS,
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
