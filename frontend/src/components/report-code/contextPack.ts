import { reportCodeApi } from '@/lib/api/report-code';
import { toast } from '@/lib/toast';

/** Download the AI Design Context Pack for a dataset as a markdown file. */
export async function downloadContextPack(datasetId: number, t: (k: string) => string): Promise<void> {
  try {
    const { text, filename } = await reportCodeApi.contextPack(datasetId);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success(t('reportCode.pack.downloaded'));
  } catch (e: any) {
    toast.error(e?.response?.data?.detail || e?.message);
  }
}
