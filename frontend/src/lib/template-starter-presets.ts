import type {
  ReportTemplateCreate,
  TemplateDefinition,
  TemplateFilter,
  TemplateTheme,
} from '@/types/template';

export interface TemplateStarterPreset {
  id: string;
  name: string;
  description: string;
  useCase: string;
  features: string[];
  accent: string;
  createPayload: ReportTemplateCreate;
}

const payrollTheme: TemplateTheme = {
  headerBg: '#0f4c81',
  headerText: '#ffffff',
  groupBg: '#dbeafe',
  groupText: '#0f4c81',
  subtotalBg: '#eff6ff',
  subtotalText: '#1d4ed8',
  accentColor: '#2563eb',
  sectionBg: '#dbeafe',
  sectionText: '#0f4c81',
};

const inventoryTheme: TemplateTheme = {
  headerBg: '#14532d',
  headerText: '#ffffff',
  groupBg: '#dcfce7',
  groupText: '#14532d',
  subtotalBg: '#ecfdf5',
  subtotalText: '#047857',
  accentColor: '#16a34a',
  sectionBg: '#dcfce7',
  sectionText: '#14532d',
};

const salesTheme: TemplateTheme = {
  headerBg: '#7c2d12',
  headerText: '#ffffff',
  groupBg: '#ffedd5',
  groupText: '#7c2d12',
  subtotalBg: '#fff7ed',
  subtotalText: '#c2410c',
  accentColor: '#ea580c',
  sectionBg: '#ffedd5',
  sectionText: '#7c2d12',
};

function cloneDefinition(definition: TemplateDefinition): TemplateDefinition {
  return JSON.parse(JSON.stringify(definition)) as TemplateDefinition;
}

function cloneFilters(filters: TemplateFilter[]): TemplateFilter[] {
  return JSON.parse(JSON.stringify(filters)) as TemplateFilter[];
}

const payrollDefinition: TemplateDefinition = {
  version: 3,
  layout: 'table',
  groupBy: 'department',
  showSubtotals: true,
  theme: payrollTheme,
  header: {
    title: 'BANG TONG HOP LUONG THEO BO PHAN',
    meta: 'Ky bao cao: {{period}}',
    titleAlign: 'center',
    titleFontSize: 'xl',
    titleBold: true,
    lines: [
      { text: 'CONG TY CO PHAN APPBI', align: 'center', bold: true, fontSize: 'lg' },
      { text: 'Phong Tai chinh - Nhan su', align: 'center', fontSize: 'base' },
      { text: 'Mau dung thu de huong dan tao Template phuc tap', align: 'center', fontSize: 'sm' },
    ],
  },
  footer: {
    lines: [
      { text: 'Luu y: mau nay phu hop bang luong theo phong ban, co tong phu va ky xac nhan cuoi trang.', fontSize: 'sm' },
      { text: 'Nguoi lap co the bind bo loc Ky / Chi nhanh / Bo phan sau khi chon dataset.', fontSize: 'sm' },
    ],
    signatureSlots: 3,
    signatureLabels: ['Nguoi lap', 'Truong phong Nhan su', 'Giam doc'],
  },
  columns: [
    { id: 'pay-department', key: 'department', label: 'Bo phan', type: 'raw', width: 140, format: 'text', visible: false },
    { id: 'pay-employee-code', key: 'employee_code', label: 'Ma NV', type: 'raw', width: 100, format: 'text' },
    { id: 'pay-employee-name', key: 'employee_name', label: 'Ho va ten', type: 'raw', width: 180, format: 'text', bold: true },
    { id: 'pay-title', key: 'job_title', label: 'Chuc danh', type: 'raw', width: 140, format: 'text' },
    { id: 'pay-work-days', key: 'work_days', label: 'Cong thuc te', type: 'raw', width: 92, format: 'decimal', align: 'right' },
    { id: 'pay-paid-leave', key: 'paid_leave', label: 'Phep huong luong', type: 'raw', width: 108, format: 'decimal', align: 'right' },
    { id: 'pay-unpaid-leave', key: 'unpaid_leave', label: 'Phep khong luong', type: 'raw', width: 112, format: 'decimal', align: 'right' },
    { id: 'pay-base-salary', key: 'base_salary', label: 'Luong co ban', type: 'raw', width: 120, format: 'decimal', align: 'right', suffix: 'VND' },
    { id: 'pay-allowance', key: 'allowance', label: 'Phu cap', type: 'raw', width: 100, format: 'decimal', align: 'right', suffix: 'VND' },
    { id: 'pay-overtime', key: 'overtime_amount', label: 'Tang ca', type: 'raw', width: 100, format: 'decimal', align: 'right', suffix: 'VND' },
    { id: 'pay-bonus', key: 'bonus_amount', label: 'Thuong', type: 'raw', width: 100, format: 'decimal', align: 'right', suffix: 'VND' },
    { id: 'pay-insurance', key: 'insurance_deduction', label: 'BHXH/BHYT', type: 'raw', width: 116, format: 'decimal', align: 'right', suffix: 'VND' },
    { id: 'pay-advance', key: 'advance_deduction', label: 'Tam ung', type: 'raw', width: 100, format: 'decimal', align: 'right', suffix: 'VND' },
    {
      id: 'pay-net-income',
      key: 'net_income',
      label: 'Thuc nhan',
      type: 'subtotal',
      width: 120,
      format: 'decimal',
      align: 'right',
      suffix: 'VND',
      expression: 'base_salary + allowance + overtime_amount + bonus_amount - insurance_deduction - advance_deduction',
      bold: true,
    },
  ],
  columnGroups: [
    { id: 'pay-level1-info', label: 'Thong tin nhan su', level: 1, columnIds: ['pay-employee-code', 'pay-employee-name', 'pay-title'] },
    { id: 'pay-level1-attendance', label: 'Ngay cong', level: 1, columnIds: ['pay-work-days', 'pay-paid-leave', 'pay-unpaid-leave'] },
    { id: 'pay-level1-income', label: 'Thu nhap', level: 1, columnIds: ['pay-base-salary', 'pay-allowance', 'pay-overtime', 'pay-bonus', 'pay-net-income'] },
    { id: 'pay-level1-deduction', label: 'Khau tru', level: 1, columnIds: ['pay-insurance', 'pay-advance'] },
    { id: 'pay-level2-fixed', label: 'Co dinh', level: 2, columnIds: ['pay-base-salary', 'pay-allowance'] },
    { id: 'pay-level2-variable', label: 'Phat sinh', level: 2, columnIds: ['pay-overtime', 'pay-bonus'] },
    { id: 'pay-level2-result', label: 'Ket qua', level: 2, columnIds: ['pay-net-income'] },
  ],
};

const payrollFilters: TemplateFilter[] = [
  { id: 'payroll-period', label: 'Ky luong', datasetId: 0, tableId: 0, column: 'period', operator: 'eq', defaultValue: '{{period}}' },
  { id: 'payroll-branch', label: 'Chi nhanh', datasetId: 0, tableId: 0, column: 'branch_name', operator: 'eq', defaultValue: '' },
  { id: 'payroll-department', label: 'Bo phan', datasetId: 0, tableId: 0, column: 'department', operator: 'eq', defaultValue: '' },
];

const inventoryDefinition: TemplateDefinition = {
  version: 3,
  layout: 'table',
  groupBy: 'warehouse_name',
  showSubtotals: true,
  theme: inventoryTheme,
  header: {
    title: 'BIEN BAN NHAP XUAT TON KIEM KE',
    meta: 'Ngay chot so: {{period}}',
    titleAlign: 'center',
    titleFontSize: 'xl',
    titleBold: true,
    lines: [
      { text: 'Kho van trung tam', align: 'center', bold: true, fontSize: 'lg' },
      { text: 'Mau phu hop nhap kho, xuat kho, doi chieu ton va ky bien ban', align: 'center', fontSize: 'sm' },
    ],
  },
  footer: {
    lines: [
      { text: 'Hang hoa chenh lech can ghi ro nguyen nhan trong cot Ghi chu truoc khi trinh ky.', fontSize: 'sm' },
    ],
    signatureSlots: 4,
    signatureLabels: ['Thu kho', 'Ke toan kho', 'Quan ly kho', 'Ban giam doc'],
  },
  columns: [
    { id: 'inv-warehouse', key: 'warehouse_name', label: 'Kho', type: 'raw', width: 140, visible: false },
    { id: 'inv-item-code', key: 'item_code', label: 'Ma hang', type: 'raw', width: 110, format: 'text' },
    { id: 'inv-item-name', key: 'item_name', label: 'Ten hang', type: 'raw', width: 200, format: 'text', bold: true },
    { id: 'inv-unit', key: 'unit_name', label: 'DVT', type: 'raw', width: 72, format: 'text', align: 'center' },
    { id: 'inv-opening', key: 'opening_qty', label: 'Ton dau', type: 'raw', width: 92, format: 'decimal', align: 'right' },
    { id: 'inv-received', key: 'received_qty', label: 'Nhap trong ky', type: 'raw', width: 104, format: 'decimal', align: 'right' },
    { id: 'inv-issued', key: 'issued_qty', label: 'Xuat trong ky', type: 'raw', width: 104, format: 'decimal', align: 'right' },
    {
      id: 'inv-ending',
      key: 'ending_qty',
      label: 'Ton he thong',
      type: 'formula',
      width: 106,
      format: 'decimal',
      align: 'right',
      expression: 'opening_qty + received_qty - issued_qty',
    },
    { id: 'inv-counted', key: 'counted_qty', label: 'Ton thuc te', type: 'input', width: 100, format: 'decimal', align: 'right' },
    {
      id: 'inv-variance',
      key: 'variance_qty',
      label: 'Lech',
      type: 'subtotal',
      width: 86,
      format: 'decimal',
      align: 'right',
      expression: 'counted_qty - ending_qty',
      highlightNegative: true,
      bold: true,
    },
    { id: 'inv-note', key: 'reconcile_note', label: 'Ghi chu doi chieu', type: 'input', width: 180, format: 'text' },
  ],
  columnGroups: [
    { id: 'inv-level1-product', label: 'Thong tin hang', level: 1, columnIds: ['inv-item-code', 'inv-item-name', 'inv-unit'] },
    { id: 'inv-level1-balance', label: 'Can doi ton kho', level: 1, columnIds: ['inv-opening', 'inv-received', 'inv-issued', 'inv-ending', 'inv-counted', 'inv-variance'] },
    { id: 'inv-level2-flow', label: 'Phat sinh trong ky', level: 2, columnIds: ['inv-received', 'inv-issued'] },
    { id: 'inv-level2-check', label: 'Doi chieu', level: 2, columnIds: ['inv-ending', 'inv-counted', 'inv-variance'] },
  ],
};

const inventoryFilters: TemplateFilter[] = [
  { id: 'inventory-period', label: 'Ky doi chieu', datasetId: 0, tableId: 0, column: 'period', operator: 'eq', defaultValue: '{{period}}' },
  { id: 'inventory-warehouse', label: 'Kho', datasetId: 0, tableId: 0, column: 'warehouse_name', operator: 'eq', defaultValue: '' },
  { id: 'inventory-item-group', label: 'Nhom hang', datasetId: 0, tableId: 0, column: 'item_group', operator: 'eq', defaultValue: '' },
];

const salesDefinition: TemplateDefinition = {
  version: 3,
  layout: 'table',
  groupBy: 'region_name',
  showSubtotals: true,
  theme: salesTheme,
  header: {
    title: 'BAO CAO DOANH THU CHI NHANH + PHU LUC GIAO DICH',
    meta: 'Tu {{from_date}} den {{to_date}}',
    titleAlign: 'center',
    titleFontSize: 'xl',
    titleBold: true,
    lines: [
      { text: 'Khoi Kinh doanh', align: 'center', bold: true, fontSize: 'lg' },
      { text: 'Mau nay mo ta kieu bao cao tong hop o tren va bang phu luc chi tiet o cuoi trang', align: 'center', fontSize: 'sm' },
    ],
  },
  footer: {
    lines: [
      { text: 'Neu muon xac nhan, co the thay bang phu luc bang chu ky o phan cuoi trang.', fontSize: 'sm' },
    ],
    signatureSlots: 2,
    signatureLabels: ['Truong phong kinh doanh', 'Giam doc vung'],
  },
  columns: [
    { id: 'sale-region', key: 'region_name', label: 'Vung', type: 'raw', width: 120, visible: false },
    { id: 'sale-branch', key: 'branch_name', label: 'Chi nhanh', type: 'raw', width: 160, format: 'text', bold: true },
    { id: 'sale-channel', key: 'channel_name', label: 'Kenh', type: 'raw', width: 110, format: 'text' },
    { id: 'sale-target', key: 'target_amount', label: 'Ke hoach', type: 'raw', width: 118, format: 'decimal', align: 'right', suffix: 'VND' },
    { id: 'sale-actual', key: 'actual_amount', label: 'Thuc hien', type: 'raw', width: 118, format: 'decimal', align: 'right', suffix: 'VND' },
    {
      id: 'sale-variance',
      key: 'variance_amount',
      label: 'Lech',
      type: 'formula',
      width: 104,
      format: 'decimal',
      align: 'right',
      suffix: 'VND',
      expression: 'actual_amount - target_amount',
      highlightNegative: true,
    },
    {
      id: 'sale-achievement',
      key: 'achievement_pct',
      label: '% HT',
      type: 'subtotal',
      width: 82,
      format: 'percentage',
      align: 'right',
      expression: 'actual_amount / target_amount',
      bold: true,
    },
    { id: 'sale-manager-note', key: 'manager_note', label: 'Nhan xet', type: 'input', width: 180, format: 'text' },
    { id: 'sale-invoice-no', key: 'invoice_no', label: 'So hoa don', type: 'raw', width: 120, format: 'text', visible: false },
    { id: 'sale-invoice-date', key: 'invoice_date', label: 'Ngay HD', type: 'raw', width: 110, format: 'text', visible: false },
    { id: 'sale-customer', key: 'customer_name', label: 'Khach hang', type: 'raw', width: 180, format: 'text', visible: false },
    { id: 'sale-owner', key: 'sales_owner', label: 'Sale phu trach', type: 'raw', width: 140, format: 'text', visible: false },
    { id: 'sale-discount', key: 'discount_amount', label: 'Chiet khau', type: 'raw', width: 105, format: 'decimal', align: 'right', suffix: 'VND', visible: false },
    { id: 'sale-status', key: 'order_status', label: 'Trang thai', type: 'raw', width: 110, format: 'text', visible: false },
  ],
  columnGroups: [
    { id: 'sale-level1-summary', label: 'Tong hop chi nhanh', level: 1, columnIds: ['sale-branch', 'sale-channel', 'sale-target', 'sale-actual', 'sale-variance', 'sale-achievement', 'sale-manager-note'] },
    { id: 'sale-level1-result', label: 'So sanh KPI', level: 1, columnIds: ['sale-target', 'sale-actual', 'sale-variance', 'sale-achievement'] },
    { id: 'sale-level2-execution', label: 'Ket qua', level: 2, columnIds: ['sale-actual', 'sale-variance', 'sale-achievement'] },
    { id: 'sale-level1-appendix', label: 'Chi tiet giao dich', level: 1, columnIds: ['sale-invoice-no', 'sale-invoice-date', 'sale-customer', 'sale-owner', 'sale-actual', 'sale-discount', 'sale-status'] },
  ],
  appendixSections: [
    {
      id: 'sales-appendix-transactions',
      title: 'PHU LUC GIAO DICH CAN KIEM TRA',
      description: 'Day la bang phu o cuoi mau template, dung de hien bang du lieu thu hai ngay trong cung mot template.',
      columnKeys: ['invoice_no', 'invoice_date', 'customer_name', 'branch_name', 'sales_owner', 'actual_amount', 'discount_amount', 'order_status'],
      groupBy: 'branch_name',
      showSubtotals: false,
    },
  ],
};

const salesFilters: TemplateFilter[] = [
  { id: 'sales-period', label: 'Ky bao cao', datasetId: 0, tableId: 0, column: 'period', operator: 'eq', defaultValue: '{{period}}' },
  { id: 'sales-region', label: 'Vung', datasetId: 0, tableId: 0, column: 'region_name', operator: 'eq', defaultValue: '' },
  { id: 'sales-branch', label: 'Chi nhanh', datasetId: 0, tableId: 0, column: 'branch_name', operator: 'eq', defaultValue: '' },
  { id: 'sales-channel', label: 'Kenh', datasetId: 0, tableId: 0, column: 'channel_name', operator: 'eq', defaultValue: '' },
];

export const TEMPLATE_STARTER_PRESETS: TemplateStarterPreset[] = [
  {
    id: 'payroll-complex',
    name: 'Mau 1 - Bang luong phong ban',
    description: 'Bang phuc tap co 3 tang header, tong phu theo bo phan va chu ky cuoi trang.',
    useCase: 'Luong, thu nhap, tong hop nhan su, ky xac nhan',
    features: ['3 tang tieu de', 'Tong phu theo nhom', '3 o chu ky', 'Bo loc ky/chi nhanh/bo phan'],
    accent: '#2563eb',
    createPayload: {
      name: 'Mau 1 - Bang luong phong ban',
      description: 'Starter preset: bang luong phong ban co tieu de phuc tap va chu ky.',
      blocks: cloneDefinition(payrollDefinition),
      filters: cloneFilters(payrollFilters),
    },
  },
  {
    id: 'inventory-reconcile',
    name: 'Mau 2 - Bien ban nhap xuat ton',
    description: 'Mau doi chieu ton kho co cot nhap/xuat, ton he thong, ton thuc te va lech.',
    useCase: 'Kho van, kiem ke, doi chieu ton, bien ban ky',
    features: ['Header gom nhom', 'Cot input thuc te', 'Cong thuc lech', '4 o chu ky'],
    accent: '#16a34a',
    createPayload: {
      name: 'Mau 2 - Bien ban nhap xuat ton',
      description: 'Starter preset: bien ban nhap xuat ton va kiem ke.',
      blocks: cloneDefinition(inventoryDefinition),
      filters: cloneFilters(inventoryFilters),
    },
  },
  {
    id: 'sales-appendix',
    name: 'Mau 3 - Doanh thu + phu luc',
    description: 'Bao cao tong hop o tren va bang du lieu thu hai o cuoi trang de doi chieu chi tiet.',
    useCase: 'Doanh thu chi nhanh, KPI, phu luc giao dich',
    features: ['Bang tong hop chinh', 'Bang phu o cuoi trang', 'Header nhieu muc', 'Nhan xet + chu ky'],
    accent: '#ea580c',
    createPayload: {
      name: 'Mau 3 - Doanh thu + phu luc',
      description: 'Starter preset: bao cao tong hop co phu luc du lieu thu hai.',
      blocks: cloneDefinition(salesDefinition),
      filters: cloneFilters(salesFilters),
    },
  },
];