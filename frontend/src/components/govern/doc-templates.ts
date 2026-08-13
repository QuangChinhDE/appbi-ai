const DOC_TEMPLATE_KEY: Record<string, string> = {
  domain: 'govern.docTemplate.domain',
  sop: 'govern.docTemplate.sop',
  report: 'govern.docTemplate.report',
  ai_knowhow: 'govern.docTemplate.aiKnowhow',
};

/** Template for a doc type, or '' when the type has no skeleton. */
export function docTemplate(
  docType: string | undefined | null,
  t: (key: string) => string,
): string {
  const key = DOC_TEMPLATE_KEY[String(docType || '')];
  return key ? t(key) : '';
}
