import { renderDocument } from './document-renderer.js';
import * as fs from 'fs';

async function main() {
  const spec = {
    format: 'pdf' as const,
    title: 'สรุปงบประมาณประจำปี 2026',
    content: `# สรุปงบประมาณประจำปี 2026
รายงานสรุปงบประมาณประจำปีสำหรับโครงการพัฒนาระบบ AI และอัตโนมัติ

## รายการตรวจสอบ
- [x] อนุมัติงบประมาณก้อนแรก (1,500,000 บาท)
- [x] ตรวจสอบฟอนต์ไทยไม่เป็นสี่เหลี่ยม (tofu)
- [ ] รอการตรวจสอบรอบที่สอง

## สูตรคำนวณทางการเงิน
สัดส่วนงบประมาณ = ยอดค่าใช้จ่ายสะสม / งบประมาณรวม × 100%
∑(i=1..n) xi = 4,200,000 บาท | σ = √(Var) ≈ 12,450 บาท

## ตารางการจัดสรร
| หมวดหมู่ | งบประมาณ (บาท) | สถานะ |
|---|---|---|
| เซิร์ฟเวอร์และคลาวด์ | 1,500,000 | อนุมัติ |
| วิจัยและพัฒนาโมเดล | 2,000,000 | อนุมัติ |
| ตรวจสอบความปลอดภัย | 700,000 | อนุมัติ |
| สำรองฉุกเฉิน | 800,000 | รออนุมัติ |`
  };

  const res = await renderDocument(spec);
  fs.writeFileSync('/data/real_render_output.pdf', Buffer.from(res.bytes));
  console.log('RESULT:', JSON.stringify({
    ok: res.ok,
    sizeBytes: res.sizeBytes,
    sha256: res.sha256,
    valid: res.validation.valid,
    hasThaiFonts: res.validation.hasThaiFonts,
    hasFormulas: res.validation.hasFormulas,
    pageCount: res.validation.pageCount
  }));
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
